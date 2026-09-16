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

async function rpc(
  env: McpClientEnv,
  token: string,
  method: string,
  params: object,
): Promise<Record<string, unknown>> {
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
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });

  const text = await response.text();
  // Streamable HTTP may answer as JSON or as one SSE frame.
  const payload =
    text.startsWith('event:') || text.startsWith('data:')
      ? (text.split('\n').find((line) => line.startsWith('data:')) ?? '{}').slice(5).trim()
      : text;
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw new Error(`mcp: unparseable response (${response.status})`);
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
