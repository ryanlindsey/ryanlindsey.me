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

const GRANT_URL = 'https://mcp.ryanlindsey.me/grant';
const START_URL = 'https://mcp.ryanlindsey.me/fit/start';

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
 * frame. This file used to keep an SSE reader for a `tools/call` anyway, the
 * frame walk the defect it was written against cost this feature eighteen days
 * to learn. #351 moved it into `payloadOf` in workers/mcp/src/evals-client.ts,
 * the one reader with a live caller, and deleted it here: a site that makes a
 * `tools/call` again should take it from there rather than grow a second copy.
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
        // header), the same label `grantContext` above sets.
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
