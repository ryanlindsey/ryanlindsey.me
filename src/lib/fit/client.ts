// How the SITE talks to the MCP Worker.
//
// The design this file implements, and the reason it is short: `/fit` does not
// verify tokens and does not spend inference. It forwards an opaque bearer
// string to the MCP Worker over the `MCP` service binding and asks it two
// questions -- "what tools does this grant have?" and "run analyze_fit". Both
// answers come from the one place either question is really decided
// (src/lib/tier/grant.ts and src/lib/fit/engine.ts), so the site cannot
// disagree with the boundary, drift from it, or accidentally implement a
// weaker copy of it.
//
// A service-binding dispatch never reaches Cloudflare's edge, which is what
// makes the URL below arbitrary-but-fixed: only the path is read. See
// workers/mcp/wrangler.jsonc's `services` note for the 522 this avoids.

export interface McpClientEnv {
  MCP: Fetcher;
}

const MCP_URL = 'https://mcp.ryanlindsey.me/mcp';
const GRANT_URL = 'https://mcp.ryanlindsey.me/grant';

let nextId = 1;

/**
 * The JSON-RPC message answering `id`, out of an SSE body, or `null`.
 *
 * A REAL FRAME WALK rather than a line search, and the measurement below is
 * why. What stood
 * here read the body's FIRST BYTES to decide it was SSE and then took the
 * FIRST `data:` line in the whole stream, which is correct for exactly one
 * shape: a single frame, arriving alone. Two things break it, and production
 * hit both.
 *
 * KEEP-ALIVES. @modelcontextprotocol/sdk arms
 * `armSseKeepAlive(options.keepAliveMs ?? DEFAULT_SSE_KEEP_ALIVE_MS)` on the
 * POST response stream (server/webStandardStreamableHttp.js), the default is
 * 15,000 ms, and each tick writes `': keepalive\n\n'` -- an SSE COMMENT, which
 * is the one frame type carrying no `data:` at all. A call answering in under
 * fifteen seconds opens `event: message`; a call taking longer opens
 * `: keepalive`, failed the old `startsWith` check, and had the entire stream
 * handed to `JSON.parse`.
 *
 * NOTIFICATIONS. A frame before the response is still `event: message` with a
 * `data:` line, so a reader taking the first one gets a message with no
 * `result` -- which `callAnalyzeFit` answers as `unreachable` and does not log.
 * Matching on `id` is what makes that frame skippable rather than fatal.
 *
 * MEASURED, and this is the cost of the two together: `analyze_fit` is the only
 * call the site makes that runs past one keep-alive tick, so it is the only one
 * that ever failed -- `tools/list`, `/grant` and every document tool answer in
 * milliseconds and parsed fine throughout. `fit_reports` held ZERO rows from
 * #37 until this fix, against 28 recorded `analyze_fit` calls, while the engine
 * itself was working: trace 77c557ab4623b2fa059f29c7f75053b2 on 2026-09-18 ran
 * 78,222 ms, recorded `outcome: 'ok'`, and ended `mcp: unparseable response
 * (200)` on this side.
 *
 * A frame carrying no `data:` line, or one whose data is not JSON, is SKIPPED
 * rather than refused: a comment is a legal frame and an unparseable one is not
 * ours to fail on. A stream with no frame answering `id` returns `null`, and
 * the caller turns that into the same error as an unreadable body -- silently
 * taking the wrong frame would be worse than saying nothing was found.
 */
function sseMessage(text: string, id: number): Record<string, unknown> | null {
  // Frames are separated by a blank line, and a frame's `data:` lines are
  // joined with newlines -- both per the SSE grammar rather than per what this
  // server happens to emit today, because the reader is the half that has to
  // survive the server changing.
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (data === '') continue;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof message !== 'object' || message === null) continue;
    if ((message as { id?: unknown }).id === id) return message as Record<string, unknown>;
  }
  return null;
}

async function rpc(
  env: McpClientEnv,
  token: string,
  method: string,
  params: object,
): Promise<Record<string, unknown>> {
  // HOISTED out of the body below, because the response has to be matched
  // against it: an SSE stream may carry frames that are not the answer to this
  // call, and `id` is the only thing that tells them apart.
  const id = nextId++;
  const response = await env.MCP.fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      // So `/ops` and the audit trail can tell a browser run from an agent's
      // (`clientIdentity` in workers/mcp/src/define.ts reads this header).
      // These are high-intent events and the two sources are worth telling
      // apart.
      'user-agent': 'ryanlindsey-me-fit/1',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

  const text = await response.text();
  // The CONTENT TYPE picks the ORDER, not the only attempt. Streamable HTTP
  // defines exactly two response modes and names the one it used in this
  // header, so reading it is reading the contract rather than sniffing the
  // first bytes -- which is what made a leading `: keepalive` look like JSON.
  //
  // Both are still tried, and that is a regression guard rather than
  // belt-and-braces: the reader this replaced decided by content alone, so it
  // read SSE whatever the header said, and keying on the header ALONE would
  // have quietly dropped a working case to fix a broken one. The two modes
  // cannot be confused for each other -- an SSE body is never valid JSON, and a
  // JSON body has no frames -- so trying the second costs nothing but the call.
  const sse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  const message = sse
    ? (sseMessage(text, id) ?? parseJson(text))
    : (parseJson(text) ?? sseMessage(text, id));
  if (message === null) throw new Error(`mcp: unparseable response (${response.status})`);
  return message;
}

/** The whole body as one JSON-RPC message, or `null` if it is not JSON. */
function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What this token unlocks, from the Worker that decides it.
 *
 * THIS IS `/fit`'s ACCESS CHECK, and it is the same check it always was:
 * `analyze_fit`'s presence in `tools` states that the token carries the fit
 * scope, is unexpired, is registered and is not revoked, evaluated by the code
 * that owns that question with no cache in between.
 *
 * It now carries the audience, the expiry and the campaign preload as well,
 * which is what the page needs to preload the right target description and to
 * tell the holder when the link dies. The site still never parses the token:
 * an `aud` read here without verifying the signature would be a second, weaker
 * copy of the boundary, and a forged one would preload another campaign's text.
 *
 * `null` on any failure, which the page reads as 404 -- the right answer for
 * every reason it could fail.
 */
export interface GrantContext {
  tools: Set<string>;
  audience: string;
  expiresAt: number;
  preload: string;
}

export async function grantContext(env: McpClientEnv, token: string): Promise<GrantContext | null> {
  try {
    const response = await env.MCP.fetch(GRANT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        // So `/ops` and the audit trail can tell a browser run from an agent's.
        'user-agent': 'ryanlindsey-me-fit/1',
      },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      tools?: unknown;
      audience?: unknown;
      expiresAt?: unknown;
      preload?: unknown;
    };
    const tools = Array.isArray(body.tools)
      ? body.tools.filter((name): name is string => typeof name === 'string')
      : [];
    if (typeof body.audience !== 'string' || body.audience === '') return null;
    return {
      tools: new Set(tools),
      audience: body.audience,
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : 0,
      preload: typeof body.preload === 'string' ? body.preload : '',
    };
  } catch (error) {
    console.error('fit: could not read the grant context', error);
    return null;
  }
}

/**
 * Why a run did not produce a report.
 *
 * A CLOSED SET, and it is what `/fit/run` puts in the redirect rather than the
 * sentence itself (final-review Important 7). The sentence still exists and is
 * still written to be read -- it is logged for the operator and, for the
 * tool's own refusals, it is the only place the breaker's or the limiter's
 * wording survives. What changed is that it no longer travels through a query
 * parameter, because anything that does is attacker-supplied: a `/fit?t=...`
 * link is designed to be forwarded, and a holder of one could previously
 * append `&error=<any text>` and have ryanlindsey.me render it above the form.
 * That is a convincing phish on precisely the page an audience was told to
 * trust, which is the leaked-link threat this tier is built around.
 */
export type AnalyzeFailure = 'unreachable' | 'refused' | 'unusable';

export type AnalyzeOutcome =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: AnalyzeFailure; message: string };

/**
 * Runs the tool. The refusal path is as important as the success one: the tool
 * answers a refusal as a RESULT with `isError` (see `defineTool`), not as a
 * transport error, and that result's text is a sentence written to be shown --
 * the breaker's message, the limiter's, or the engine's. It is carried back
 * verbatim in `message`, which is what an MCP caller reads and what `/fit/run`
 * logs; the PAGE renders fixed copy keyed on `code` instead, because the
 * redirect that reaches it is forgeable and the sentence is not worth a phish
 * (see `AnalyzeFailure`).
 *
 * `instanceof` is no help on this side of the binding: a `FitUnavailable`
 * thrown in the MCP Worker never crosses as an instance, which is why the
 * error is read out of the RESULT TEXT rather than off an error class. See the
 * note beside `fitToolError` in workers/mcp/src/gated.ts.
 */
export async function callAnalyzeFit(
  env: McpClientEnv,
  token: string,
  targetDescription: string,
): Promise<AnalyzeOutcome> {
  let body: Record<string, unknown>;
  try {
    body = await rpc(env, token, 'tools/call', {
      name: 'analyze_fit',
      arguments: { target_description: targetDescription },
    });
  } catch (error) {
    console.error('fit: the tool call failed in transport', error);
    return {
      ok: false,
      code: 'unreachable',
      message: 'The fit engine could not be reached. Try again shortly.',
    };
  }

  const result = body.result as
    { isError?: boolean; content?: { text?: unknown }[]; structuredContent?: unknown } | undefined;

  if (body.error || result === undefined) {
    return {
      ok: false,
      code: 'unreachable',
      message: 'The fit engine could not be reached. Try again shortly.',
    };
  }
  if (result.isError) {
    const text = result.content?.[0]?.text;
    return {
      ok: false,
      code: 'refused',
      message: typeof text === 'string' ? text : 'The fit engine refused the request.',
    };
  }

  // `structuredContent` when the tool declares an output schema, the text
  // block otherwise -- read in that order rather than assuming, because
  // `defineTool` emits the former only for a tool with an `outputSchema`.
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return { ok: true, payload: result.structuredContent as Record<string, unknown> };
  }
  const text = result.content?.[0]?.text;
  // `unusable` rather than `unreachable`, and the distinction is worth a
  // third code: the engine ANSWERED, and the answer did not parse. That is a
  // protocol or prompt bug on our side, where `unreachable` is an outage --
  // they want different things done about them, and the audit log is where
  // the difference has to be visible.
  if (typeof text !== 'string')
    return { ok: false, code: 'unusable', message: 'The fit engine returned nothing usable.' };
  try {
    return { ok: true, payload: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'unusable', message: 'The fit engine returned nothing usable.' };
  }
}

/**
 * A permalink id: 128 bits, base64url, 22 characters.
 *
 * THE ID IS THE CAPABILITY -- `/fit/r/<id>` asks for nothing else (04 §2's
 * shareable permalink). Two things follow, and both are requirements rather
 * than notes: it must come from the CSPRNG, and it must never be derived from
 * anything about the report. A derived id is a guessable id, and a guessable
 * id is a public report.
 */
export function newReportId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
