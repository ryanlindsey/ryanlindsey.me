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
 * The tool names this token's grant actually has.
 *
 * THIS IS `/fit`'s ACCESS CHECK. Not a convenience: gated tools are registered
 * per grant (workers/mcp/src/server.ts), so the presence of `analyze_fit` in
 * this listing IS the statement "this token carries the fit scope, is
 * unexpired, is registered and is not revoked" -- evaluated by the code that
 * owns that question, on this request, with no cache in between.
 *
 * An empty set on any failure. The page reads that as 404, which is the right
 * answer for every reason it could be empty.
 */
export async function grantedToolNames(env: McpClientEnv, token: string): Promise<Set<string>> {
  try {
    const body = await rpc(env, token, 'tools/list', {});
    const tools = (body.result as { tools?: { name?: unknown }[] } | undefined)?.tools ?? [];
    return new Set(
      tools.map((tool) => tool.name).filter((name): name is string => typeof name === 'string'),
    );
  } catch (error) {
    console.error('fit: could not list the granted tools', error);
    return new Set();
  }
}

export type AnalyzeOutcome =
  { ok: true; payload: Record<string, unknown> } | { ok: false; message: string };

/**
 * Runs the tool. The refusal path is as important as the success one: the tool
 * answers a refusal as a RESULT with `isError` (see `defineTool`), not as a
 * transport error, and that result's text is a sentence written to be shown --
 * the breaker's message, the limiter's, or the engine's. It is passed through
 * verbatim rather than replaced with something vaguer.
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
    return { ok: false, message: 'The fit engine could not be reached. Try again shortly.' };
  }

  const result = body.result as
    { isError?: boolean; content?: { text?: unknown }[]; structuredContent?: unknown } | undefined;

  if (body.error || result === undefined) {
    return { ok: false, message: 'The fit engine could not be reached. Try again shortly.' };
  }
  if (result.isError) {
    const text = result.content?.[0]?.text;
    return {
      ok: false,
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
  if (typeof text !== 'string')
    return { ok: false, message: 'The fit engine returned nothing usable.' };
  try {
    return { ok: true, payload: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { ok: false, message: 'The fit engine returned nothing usable.' };
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
