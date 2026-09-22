// How the SITE talks to the MCP Worker.
//
// The design this file implements, and the reason it is short: `/fit` does not
// verify tokens and does not spend inference. It forwards an opaque bearer
// string to the MCP Worker over the `MCP` service binding and asks it two
// questions -- "what tools does this grant have?" and "start a fit run". Both
// answers come from the one place either question is really decided
// (src/lib/tier/grant.ts and workers/mcp/src/fit-start.ts), so the site cannot
// disagree with the boundary, drift from it, or accidentally implement a
// weaker copy of it.
//
// THE SECOND QUESTION CHANGED SHAPE IN #269 and the first did not. It used to
// be "run analyze_fit and hand me the report", which held the browser open for
// about eighty seconds; it is now "open a run" and the reader is redirected to
// the permalink while the engine works. Nothing about the boundary moved: the
// site still never verifies the token, and it now never writes `fit_reports`
// either.
//
// A service-binding dispatch never reaches Cloudflare's edge, which is what
// makes the URL below arbitrary-but-fixed: only the path is read. See
// workers/mcp/wrangler.jsonc's `services` note for the 522 this avoids.

export interface McpClientEnv {
  MCP: Fetcher;
}

const MCP_URL = 'https://mcp.ryanlindsey.me/mcp';
const GRANT_URL = 'https://mcp.ryanlindsey.me/grant';
const START_URL = 'https://mcp.ryanlindsey.me/fit/start';

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
 * `result` -- which the caller of the day, `callAnalyzeFit`, answered as
 * `unreachable` and did not log. Matching on `id` is what makes that frame
 * skippable rather than fatal.
 *
 * MEASURED, and this is the cost of the two together: `analyze_fit` was the
 * only call the site made that ran past one keep-alive tick, so it was the only
 * one that ever failed -- `tools/list`, `/grant` and every document tool answer
 * in milliseconds and parsed fine throughout. `fit_reports` held ZERO rows from
 * #37 until this fix, against 28 recorded `analyze_fit` calls, while the engine
 * itself was working: trace 77c557ab4623b2fa059f29c7f75053b2 on 2026-09-18 ran
 * 78,222 ms, recorded `outcome: 'ok'`, and ended `mcp: unparseable response
 * (200)` on this side.
 *
 * PAST TENSE SINCE #269, and the reader is kept anyway. The site no longer
 * calls `analyze_fit` at all -- `startAnalyzeFit` below asks for a row to be
 * opened and gets plain JSON back in milliseconds -- so nothing this file sends
 * today crosses the fifteen-second line. That is exactly the condition under
 * which the old reader also looked correct for a year and a half, which is why
 * the walk stays and why tests/fit-client-sse.test.ts still drives it.
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

/**
 * One JSON-RPC call to the MCP Worker, through the SSE reader above.
 *
 * EXPORTED SINCE #269, and for a test rather than for a caller. `callAnalyzeFit`
 * was its only caller and #269 deleted it, which would have left this function
 * and `sseMessage` unreferenced and therefore unreadable by the suite that
 * pins them. tests/fit-client-sse.test.ts drives this directly instead. The
 * alternative considered and rejected was deleting the reader with its last
 * caller: the site will make another `tools/call` eventually, and the eighteen
 * days the frame walk cost are not worth paying twice.
 *
 * THE OTHER HALF-IMPLEMENTATION OF THIS READER IS LIVE: `payloadOf` in
 * workers/mcp/src/evals-client.ts, which the scheduled eval run depends on.
 * Named here so the next person to touch either finds both.
 */
export async function rpc(
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
  heroLine: string;
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
      heroLine?: unknown;
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
      heroLine: typeof body.heroLine === 'string' ? body.heroLine : '',
    };
  } catch (error) {
    console.error('fit: could not read the grant context', error);
    return null;
  }
}

/**
 * Why a run could not be STARTED. One code, because there is one way to fail.
 *
 * The engine's own refusals do not reach this type any more. Before #269 this
 * union had three members -- `unreachable`, `refused` and `unusable` -- because
 * the site held the request open for the whole run and had to carry the
 * engine's verdict back to the form. The run now happens after the redirect,
 * so a refusal is written to `fit_reports.failure_code` and rendered by
 * `/fit/r/<id>` from `FIT_FAILURE_COPY` (src/lib/fit/report-status.ts). What is
 * left here is "the MCP Worker did not open a run", and the form says the same
 * thing for every reason that happens.
 *
 * The code rather than a sentence, still, and for the reason
 * src/lib/fit/errors.ts records at length: a `/fit?t=...` link is handed out
 * and meant to be forwarded, so anything this route puts in a query parameter
 * is attacker-supplied by the time the page reads it.
 */
export type StartOutcome = { ok: true; id: string } | { ok: false; code: 'unreachable' };

/**
 * Opens a run on the MCP Worker and returns its permalink id (#269).
 *
 * THIS DOES NOT WAIT FOR THE REPORT. `/fit/start` answers as soon as the row
 * is open, in milliseconds, and the engine runs behind it in a Workflow
 * instance on that Worker. The eighty seconds this used to spend on the request
 * path -- measured at 78,222 ms on 2026-09-18 -- is what the whole change is
 * about.
 *
 * IT RAN IN THAT WORKER'S `ctx.waitUntil` UNTIL #349, and the correction is
 * worth keeping here because this side cannot see it: that budget is 30 seconds
 * for an HTTP-triggered Worker and the runtime cancels what has not settled, so
 * a call measured at 2.6 times it never once finished. This function's own
 * answer was correct throughout -- the id came back in a second either way --
 * which is exactly why nothing on this side of the hop noticed for seven
 * merged children of epic #270.
 *
 * PLAIN JSON RATHER THAN THE MCP TRANSPORT, so this never meets a keep-alive
 * frame. `rpc` above still parses SSE correctly and still has to: it is the
 * only reader this site has for a `tools/call`, and the defect it was written
 * against cost this feature eighteen days.
 *
 * THE TOKEN IS FORWARDED AND NOTHING ELSE IS DONE WITH IT. It is not written
 * to D1 here, not logged, and not put on a queue; the Worker on the other side
 * resolves it and writes the audience itself, which is why this file no longer
 * reads an audience out of an envelope.
 *
 * A REFUSAL IS INDISTINGUISHABLE FROM AN OUTAGE ON PURPOSE, and it is not this
 * function's choice: `/fit/start` answers a refused run with the same genuine
 * 404 an unrouted path gets (workers/mcp/src/fit-start.ts), because a status
 * that said "refused" would confirm the route exists to anyone holding a link.
 * So there is nothing here to tell the two apart with.
 */
export async function startAnalyzeFit(
  env: McpClientEnv,
  token: string,
  targetDescription: string,
): Promise<StartOutcome> {
  try {
    const response = await env.MCP.fetch(START_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        // So `/ops` and the audit trail can tell a browser run from an
        // agent's (`clientIdentity` in workers/mcp/src/define.ts reads this
        // header), the same label `rpc` above sets for the same reason.
        'user-agent': 'ryanlindsey-me-fit/1',
      },
      body: JSON.stringify({ target_description: targetDescription }),
    });
    if (!response.ok) return { ok: false, code: 'unreachable' };
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== 'string' || body.id === '') return { ok: false, code: 'unreachable' };
    return { ok: true, id: body.id };
  } catch (error) {
    // INTERPOLATED rather than passed as a second argument. Measured
    // 2026-09-17: Cloudflare Worker observability renders
    // `console.error(msg, err)` as the message followed by the stack and drops
    // `err.message` entirely.
    console.error(
      `fit: could not start the run: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, code: 'unreachable' };
  }
}
