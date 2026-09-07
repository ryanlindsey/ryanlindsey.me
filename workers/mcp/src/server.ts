import {
  CLIENT_INFO_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type CallToolResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { hashArgs, recordToolCall, type AuditRow } from '../../../src/lib/mcp/audit';
import { limiterFor, limitKeyFor, type ToolCost } from '../../../src/lib/mcp/limits';
import type { McpEnv } from './env';

/**
 * What a tool handler is given besides its arguments.
 *
 * `request` is the ORIGINAL HTTP request, not the JSON-RPC message: it is
 * where `CF-Connecting-IP` and `User-Agent` live. It is optional because
 * `McpRequestContext.requestInfo` is HTTP-only -- a stdio-served instance
 * would have none -- and a tool must not assume it is there.
 */
export interface ToolContext {
  env: McpEnv;
  ctx: ExecutionContext;
  request: Request | undefined;
}

/** A failure whose message is safe to show the caller. Anything else is not. */
export class ToolError extends Error {}

const INSTRUCTIONS = [
  "Ryan Lindsey's professional corpus, exposed as MCP tools.",
  'Public tools cover portfolio exploration. A private tier exists for scoped tokens;',
  'ask Ryan for access if you need it.',
].join(' ');

/**
 * The caller's identity, as far as it is genuinely knowable.
 *
 * MEASURED against @modelcontextprotocol/server 2.0.0 and this harness rather
 * than assumed, because the obvious answer is wrong. `clientInfo` arrives in
 * `initialize`, and this server is stateless: `createMcpHandler` builds a
 * fresh `McpServer` per HTTP request, so a 2025-era client's handshake is not
 * carried into the `tools/call` that follows it. The 2026-07-28 revision
 * moved the same facts into a per-request `_meta` envelope, which the SDK
 * lifts onto `ctx.mcpReq.envelope` under the two exported key constants --
 * that, and only that, is a real per-call source for them.
 *
 * So: `user-agent` comes off the HTTP request and is nearly always there;
 * the other three are present only for a client that sends the modern
 * envelope, and are written NULL otherwise. Filling them in from anywhere
 * else would put a guess in an audit column, which is worse than a blank.
 */
function clientIdentity(
  request: Request | undefined,
  serverCtx: ServerContext,
): Pick<AuditRow, 'clientName' | 'clientVersion' | 'userAgent' | 'protocolVersion'> {
  // `RequestMetaEnvelope` is an intentionally empty type at the SDK's neutral
  // layer, so the envelope is read as the string-keyed bag it is on the wire.
  const envelope = (serverCtx.mcpReq.envelope ?? {}) as Record<string, unknown>;
  const clientInfo = envelope[CLIENT_INFO_META_KEY] as
    { name?: unknown; version?: unknown } | undefined;
  const protocolVersion = envelope[PROTOCOL_VERSION_META_KEY];

  return {
    clientName: typeof clientInfo?.name === 'string' ? clientInfo.name : null,
    clientVersion: typeof clientInfo?.version === 'string' ? clientInfo.version : null,
    userAgent: request?.headers.get('user-agent') ?? null,
    protocolVersion: typeof protocolVersion === 'string' ? protocolVersion : null,
  };
}

/**
 * The ONLY way a tool is registered.
 *
 * Rate limiting (03 §3) and the audit trail (03 §3) are cross-cutting
 * obligations, and the only way they stay true of every tool is for there to
 * be one registration path. Calling `server.registerTool` directly ships an
 * unaudited, unlimited tool -- which is why the review gate for this repo
 * treats that as a defect rather than a style difference.
 */
export function defineTool<A>(
  server: McpServer,
  tc: ToolContext,
  spec: {
    name: string;
    title: string;
    description: string;
    cost: ToolCost;
    inputSchema?: z.ZodObject<z.ZodRawShape>;
    outputSchema?: z.ZodObject<z.ZodRawShape>;
  },
  handler: (args: A, tc: ToolContext) => Promise<unknown>,
): void {
  /**
   * MEASURED, not assumed: the SDK's `createToolExecutor` calls a handler as
   * `(args, ctx)` when the tool has an `inputSchema` and as `(ctx)` alone
   * when it does not. The context is therefore always LAST and the arguments
   * are only there when something was declared to parse them into. Taking the
   * first parameter as `args` unconditionally would hand a no-argument tool
   * its own `ServerContext` to hash -- and since that object carries the
   * JSON-RPC id, every call would get a different `args_hash` and the audit
   * table would never show a repeated query.
   */
  const invoke = async (...params: unknown[]): Promise<CallToolResult> => {
    const serverCtx = params[params.length - 1] as ServerContext;
    const args = (params.length > 1 ? params[0] : undefined) as A;

    const started = Date.now();
    const argsHash = await hashArgs(args);

    const audit = (outcome: AuditRow['outcome']) =>
      tc.ctx.waitUntil(
        recordToolCall(tc.env.DB, {
          calledAt: new Date().toISOString(),
          tool: spec.name,
          argsHash,
          // Day 5 resolves these two from the request's token. Hard-coded
          // here so the public tier cannot accidentally write an audience.
          tier: 'public',
          audience: null,
          ...clientIdentity(tc.request, serverCtx),
          outcome,
          durationMs: Date.now() - started,
        }),
      );

    const { success } = await limiterFor(tc.env, spec.cost).limit({
      key: limitKeyFor(tc.request, spec.name),
    });
    if (!success) {
      audit('rate_limited');
      // A tool RESULT, not a thrown transport error: the client should read
      // a sentence explaining what happened rather than lose the connection.
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `Rate limit reached for ${spec.name}. Try again in a minute.`,
          },
        ],
      };
    }

    try {
      const output = await handler(args, tc);
      audit('ok');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        ...(spec.outputSchema ? { structuredContent: output as Record<string, unknown> } : {}),
      };
    } catch (error) {
      audit('error');
      // Only a ToolError's message reaches the caller. Anything else could
      // carry an internal path or a stack, and this surface is public.
      console.error(`mcp/tool: ${spec.name} failed`, error);
      const text =
        error instanceof ToolError ? error.message : `${spec.name} failed. The error was logged.`;
      return { isError: true, content: [{ type: 'text' as const, text }] };
    }
  };

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      // Spread rather than set: an `inputSchema: undefined` key resolves to
      // the deprecated raw-shape overload -- the trap day 3 recorded when it
      // registered `get_contact` with no schema at all.
      ...(spec.inputSchema ? { inputSchema: spec.inputSchema } : {}),
      ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
    },
    invoke,
  );
}

/**
 * The server one HTTP request is served by.
 *
 * `instructions` belongs to ServerOptions (the second argument), not to the
 * Implementation identity. Passing it here is also what puts it at the top
 * level of the initialize result, where the spec and clients look for it.
 * The `x-release-please-version` marker is load-bearing: release-please's `generic` updater
 * rewrites the semver on any line carrying it, which is what keeps the version this server
 * advertises over MCP in step with package.json. Moving the version off this line, or letting
 * a formatter split it across lines, silently strands it at whatever it says today. The path
 * release-please looks in is `extra-files` in release-please-config.json, and it names THIS
 * file -- moving this line to another one means editing that entry in the same commit.
 */
export function createServer(tc: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'ryanlindsey-me', version: '1.4.1' }, // x-release-please-version
    { instructions: INSTRUCTIONS },
  );

  defineTool(
    server,
    tc,
    {
      name: 'get_contact',
      title: 'Contact details',
      description: 'How to reach Ryan Lindsey, and his working timezone.',
      // No `inputSchema`: this tool takes no arguments, and the empty-object
      // form resolves to the deprecated raw-shape overload.
      cost: 'cheap',
    },
    async () => ({
      email: 'hello@ryanlindsey.me',
      site: 'https://ryanlindsey.me',
      timezone: 'America/Los_Angeles',
    }),
  );

  return server;
}
