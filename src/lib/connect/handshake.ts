/**
 * The live handshake on /connect (#395): the one request any MCP client sends
 * first, sent for real from the reader's browser, and the reduction of its
 * answer to what the page may show.
 *
 * WHY THE ANSWER IS REDUCED RATHER THAN RENDERED. Measured 2026-09-24 against
 * production: the `initialize` result's `instructions` field names and
 * describes every public tool. /connect deliberately publishes no tool
 * catalogue, so `parseInitialize` returns four fields and nothing else, and
 * nothing downstream of it can render what it never received.
 *
 * `initialize` reaches neither `checkLimit` nor `recordToolCall`
 * (workers/mcp/src/define.ts wraps tools, not the handshake), so this spends
 * no inference and writes no row. That is also why the button carries no
 * Turnstile check: see #395's Decisions.
 */

/** Requested, not displayed: the page shows whatever version the server answered. */
export const REQUESTED_PROTOCOL_VERSION = '2025-06-18';

export const HANDSHAKE_TIMEOUT_MS = 8000;

/** After a reply, before the button accepts another press. */
export const HANDSHAKE_COOLDOWN_MS = 5000;

export function buildInitialize() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: REQUESTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ryanlindsey.me/connect', version: '1' },
    },
  } as const;
}

export type InitializeRequest = ReturnType<typeof buildInitialize>;

export interface ServerHello {
  name: string;
  version: string;
  protocolVersion: string;
  /** The capability names the server advertised, sorted. */
  capabilities: string[];
}

/**
 * Candidate JSON messages in a response body. The endpoint answers with SSE
 * today (`event: message` / `data: {...}`), and a Streamable HTTP server may
 * answer with plain JSON instead, so both are read. One `data:` line per
 * message is what this server sends; a message split across several `data:`
 * lines would not parse and would fall through to `unexpected`, which is the
 * honest outcome for a shape nothing here has seen.
 */
function payloads(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return [trimmed];
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function helloFrom(message: unknown): ServerHello | null {
  if (!isRecord(message) || !isRecord(message.result)) return null;
  const { serverInfo, protocolVersion, capabilities } = message.result;
  if (!isRecord(serverInfo)) return null;
  const { name, version } = serverInfo;
  if (typeof name !== 'string' || typeof version !== 'string') return null;
  if (typeof protocolVersion !== 'string') return null;
  return {
    name,
    version,
    protocolVersion,
    capabilities: isRecord(capabilities) ? Object.keys(capabilities).sort() : [],
  };
}

export function parseInitialize(body: string): ServerHello | null {
  for (const payload of payloads(body)) {
    let message: unknown;
    try {
      message = JSON.parse(payload);
    } catch {
      continue;
    }
    const hello = helloFrom(message);
    if (hello) return hello;
  }
  return null;
}

export const CONNECT_ERROR_COPY = {
  unreachable:
    'The server could not be reached from this browser. The address on this page is still the one to give a client.',
  timeout: 'The server did not answer within eight seconds. Try again in a moment.',
  unexpected: 'The server answered, but not with a handshake this page recognizes.',
} as const;

export type HandshakeFailure = keyof typeof CONNECT_ERROR_COPY;
