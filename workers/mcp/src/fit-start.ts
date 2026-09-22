import { analyzeFit, FitUnavailable } from '../../../src/lib/fit/engine';
import { newReportId } from '../../../src/lib/fit/report-id';
import { hasScope, resolveGrant } from '../../../src/lib/tier/grant';
import { limitAndAudit } from './define';
import { fitEnv } from './gated';
import type { McpEnv } from './env';

/**
 * Opens a fit run and answers with its permalink id (#269).
 *
 * THE WAIT MOVED, NOT THE WORK. `analyze_fit` takes about eighty seconds --
 * measured at 78,222 ms on 2026-09-18 -- and `/fit/run` used to hold the
 * browser open for every one of them. This route writes the row, hands back
 * the id, and finishes in `ctx.waitUntil`.
 *
 * THE TOKEN NEVER LEAVES THIS REQUEST. It is not written to the row, not put
 * on a queue and not logged. That is why the run happens here rather than in a
 * queue consumer: a message would have to carry the token and the pasted
 * description, and src/lib/agent-intel/intent.ts says the queue carries labels
 * the operator needs and nothing a caller typed.
 *
 * LIMITED AND AUDITED THROUGH `limitAndAudit`, which is the same
 * implementation `defineTool` uses. `analyze_fit` is the only `expensive` tool
 * in the server, and a route that reached the engine around the limiter would
 * be an unmetered path to it.
 *
 * `resolveGrant` IS ASKED HERE AND NOWHERE ELSE ON THIS PATH. The site holds
 * the token as an opaque string and cannot verify it (src/lib/fit/client.ts);
 * this Worker is the one authorization check, and a second one would be a copy
 * that proves nothing by agreeing with the first.
 */
export async function handleFitStart(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (request.method !== 'POST') return null;

  const { grant } = await resolveGrant(env, request, Math.floor(Date.now() / 1000));
  if (grant === null || !hasScope(grant, 'fit')) return null;

  let body: { target_description?: unknown };
  try {
    body = (await request.json()) as { target_description?: unknown };
  } catch {
    return null;
  }
  const description =
    typeof body.target_description === 'string' ? body.target_description.trim() : '';
  if (description === '') return null;

  const id = newReportId();
  const tc = { env, ctx, request, grant };

  // THE LIMITER IS ASKED FIRST, AND THE ROW IS OPENED INSIDE THE GUARDED BODY.
  // That ordering is the whole reason the insert is where it is: `limitAndAudit`
  // checks the allowance before it calls `run`, so a refused run leaves no row
  // behind to be read at a permalink nothing will ever finish.
  //
  // `read` is a THUNK because that is the shape `limitAndAudit` takes, and the
  // description it closes over was parsed ABOVE the guard rather than inside
  // it. A body this route cannot read is answered like an unrouted path and
  // spends nothing, which is the same decision as the refusals above it.
  const outcome = await limitAndAudit(
    tc,
    {
      auditName: 'analyze_fit',
      cost: 'expensive',
      surface: 'route',
      read: () => ({ target_description: description }),
      hashable: (call) => call,
    },
    async (call) => {
      await env.DB.prepare(
        `INSERT INTO fit_reports (id, created_at, status, audience, target_description)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
        .bind(id, new Date().toISOString(), grant.audience, call.target_description)
        .run();

      // The eighty seconds, off the response. `waitUntil` rather than an await:
      // the whole point of this route is that the caller does not wait.
      ctx.waitUntil(completeRun(env, id, call.target_description));
      return id;
    },
  );

  if (outcome.kind === 'ok') return Response.json({ id: outcome.value });
  // A refusal answers nothing distinguishable from an unrouted path, including
  // a rate-limited one: this surface is reachable by anyone holding a link, and
  // a 429 here would confirm the route exists. `null` sends ./index.ts through
  // to `createMcpHandler`, so the refusal IS that handler's genuine 404 rather
  // than a copy of it that the next bump to `agents` can leave behind --
  // the correction workers/mcp/src/grant-context.ts records from 2026-09-15,
  // and it applies here for the same reason.
  return null;
}

/** Runs the engine and closes the row, whichever way it goes. */
async function completeRun(env: McpEnv, id: string, description: string): Promise<void> {
  try {
    const result = await analyzeFit(fitEnv(env), description);
    await env.DB.prepare(
      `UPDATE fit_reports
          SET status = 'ok', model = ?, report_json = ?,
              citations_checked = ?, citations_dropped = ?
        WHERE id = ?`,
    )
      .bind(
        result.model,
        JSON.stringify(result.report),
        result.citations.checked,
        result.citations.dropped,
        id,
      )
      .run();
  } catch (error) {
    // `refused` is the engine declining for a reason it wrote a sentence about
    // -- the breaker, an empty corpus, an unusable answer. Anything else is a
    // defect, and the two are worth telling apart on /ops even though the
    // reader is told the same thing.
    //
    // The message is INTERPOLATED rather than passed as a second argument.
    // Measured 2026-09-17: Cloudflare Worker observability renders
    // `console.error(msg, err)` as the message followed by the stack and drops
    // `err.message` entirely, which is what made the original `/fit` failure
    // take several rounds of log reading to place. Nothing about the caller's
    // token reaches this line, and nothing may be added that does.
    const code = error instanceof FitUnavailable ? 'refused' : 'errored';
    console.error(
      `fit: the deferred run failed (${code}): ${error instanceof Error ? error.message : String(error)}`,
    );
    await env.DB.prepare(`UPDATE fit_reports SET status = 'failed', failure_code = ? WHERE id = ?`)
      .bind(code, id)
      .run();
  }
}
