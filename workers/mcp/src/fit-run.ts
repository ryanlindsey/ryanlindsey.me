// Opening a fit run, and closing one the run never reached (#490).
//
// WHY THESE LIVE TOGETHER, AND WHY NOT IN EITHER OF THE MODULES THEY CAME
// FROM. `openFitRun` and `startRun` were in ./fit-start.ts, and `abandonRun`,
// `notifyRun` and `messageOf` in ./fit-workflow.ts. When `analyze_fit` began
// opening runs too, ./gated.ts needed `openFitRun`, and the chain through
// ./fit-start.ts reached ./fit-workflow.ts, which imports `cloudflare:workers`
// for `WorkflowEntrypoint`. That specifier does not resolve in vitest's Node
// process, where a dozen suites import ./gated.ts for `GATED_TOOL_NAMES` and
// its pure functions, so a static import would have stopped every one of them
// loading. The first version of #490 reached for a dynamic `import()` to dodge
// that, and the review ruled it out: this module imports nothing from
// `cloudflare:workers`, so ./gated.ts, ./fit-start.ts and the Workflow all
// import it statically, and the gated -> fit-start -> fit-workflow -> gated
// cycle that the dynamic import was papering over is gone.
//
// The comments below moved with their code and were edited only where the
// move or #490 made them false.

import { highIntentFor } from '../../../src/lib/agent-intel/intent';
import type { FailureReason } from '../../../src/lib/failure/classify';
import { newReportId } from '../../../src/lib/fit/report-id';
import type { FitFailureCode } from '../../../src/lib/fit/report-status';
import type { McpEnv } from './env';

/**
 * Opens a run: writes its `pending` row and hands it to the Workflow, then
 * answers with the permalink id.
 *
 * ONE IMPLEMENTATION FOR BOTH CALLERS (#490). `handleFitStart` (./fit-start.ts) calls it
 * inside `limitAndAudit`, and `analyze_fit` (./gated.ts) inside `defineTool`'s
 * guard, which is the same function reached by another adapter. Each caller
 * meters and audits exactly once and this function does neither, so a run
 * cannot be metered twice by reaching it from both, and cannot reach the
 * engine around the limiter by reaching it from somewhere new: it has no
 * caller outside a guarded body, and must not gain one.
 *
 * `analyze_fit` used to await the engine itself, and on Opus 5 a run took 59
 * to 104 seconds (tail 135 s), which MCP clients did not wait for. The form
 * had stopped holding the browser open for the same run in #269, and the tool
 * now takes the same way out rather than a second one.
 *
 * Called INSIDE the guard on both paths, which is the ordering argued above
 * `limitAndAudit` in ./fit-start.ts's `handleFitStart`: the limiter is asked
 * first, so a refused call leaves no row for a permalink nothing will finish.
 *
 * `audience` is the grant's. Each caller passes it from the grant its own
 * request resolved, and the row is the only place the run reads it back from.
 *
 * `notify` IS WHETHER THE OPERATOR HEARS ABOUT THE RUN WHEN IT ENDS, and the
 * two callers pass opposite values on purpose. `/fit/start` passes true: the
 * `fit-run` event exists for the form, whose reader holds a forwarded link and
 * may get nothing (#277). `analyze_fit` passes false, which keeps what it did
 * before #490, when it awaited the engine itself and queued nothing. Its
 * callers are the owner's own clients and the scheduled `fit` suite, whose
 * runs would otherwise reach the operator's inbox every week. Passing it
 * through rather than deciding it here keeps this function ignorant of who
 * called it.
 */
export async function openFitRun(
  env: McpEnv,
  ctx: ExecutionContext,
  audience: string,
  description: string,
  notify: boolean,
): Promise<string> {
  const id = newReportId();
  await env.DB.prepare(
    `INSERT INTO fit_reports (id, created_at, status, audience, target_description)
     VALUES (?, ?, 'pending', ?, ?)`,
  )
    .bind(id, new Date().toISOString(), audience, description)
    .run();

  // The eighty seconds, off the response AND off this request's lifetime.
  // `waitUntil` rather than an await: creating an instance is a round trip
  // to the Workflows API, and the whole point of this route is that the
  // caller does not wait for anything it does not have to. ("This route" is
  // `/fit/start`, where these lines were written; since #490 it is equally
  // true of `analyze_fit`, whose caller is exactly who could not wait.)
  ctx.waitUntil(startRun(env, id, audience, notify));
  return id;
}

/**
 * Starts the instance that finishes the run, and closes the row if it cannot.
 *
 * THE INSTANCE ID IS THE REPORT ID, which is a deliberate join rather than a
 * convenience. Workflows instance ids are unique per workflow and accept up to
 * 100 characters (workflows/reference/limits); a report id is 22 base64url
 * characters from `newReportId`, so the mapping is total and collision-free.
 * The limits page does not state the other rule: an instance id may not START
 * with `-`. This comment used to cite the length alone, and one report id in
 * sixty-four was refused until `newReportId` stopped minting them (2026-09-24).
 * What it buys is that an operator holding a permalink can run
 * `wrangler workflows instances describe rlme-fit <id>` and read what became of
 * that run, and that a test can address the instance a request started --
 * which is the thing `ctx.waitUntil` could never offer, and the reason this
 * defect survived seven merged children of epic #270.
 *
 * It also makes a second instance for one report impossible from `/fit/start`,
 * or from `analyze_fit`, which mints its id in the same `openFitRun` -- and
 * that is what lets ./fit-workflow.ts's row read skip a `status` guard.
 *
 * A `create` THAT REJECTS MUST NOT LEAVE THE ROW OPEN. The row is already
 * inserted by the time this runs, and a `pending` row with no instance behind
 * it is exactly the state #349 is about: `/fit/r/<id>` refreshes every five
 * seconds and then renders the stale copy, having promised a report nothing
 * will write. `abandonRun` closes it as `errored` and notifies, which is the
 * same treatment the run itself gives a failure it cannot recover from.
 *
 * Both branches here are milliseconds: a create, or two D1 writes and a queue
 * send. Nothing on this path is anywhere near the 30-second `waitUntil` budget,
 * which is the distinction the doc comment on `handleFitStart` in
 * ./fit-start.ts draws.
 */
async function startRun(env: McpEnv, id: string, audience: string, notify: boolean): Promise<void> {
  try {
    await env.FIT_WORKFLOW.create({ id, params: { id, notify } });
  } catch (error) {
    console.error(`fit: the run for ${id} could not be started: ${messageOf(error)}`);
    await abandonRun(env, id, audience, notify);
  }
}

/**
 * An error's own message. See the `console.error` note in `FitWorkflow.run`
 * (./fit-workflow.ts) for why it is interpolated.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Puts the finished run on the events queue.
 *
 * Called from `FitWorkflow.run` in ./fit-workflow.ts, which is where "here"
 * below means; it lives in this module since #490 only so `abandonRun` can
 * reach it without importing `cloudflare:workers`.
 *
 * THE NOTIFICATION IS QUEUED FROM HERE BECAUSE THIS IS WHERE THE RUN ENDS
 * (#277). It used to be queued by the site Worker, off the 303 to
 * `/fit/r/<id>`, which was an unambiguous "a report exists" until #269 made
 * that redirect mean "a run started" instead -- so the operator was told at the
 * moment nothing had been generated, and was never told when something was.
 * This Worker resolved the grant, so it is also the only one that can name the
 * audience without a second verifier. The audience reaches this function off
 * the ROW now rather than out of a closure, which is the same value by a
 * shorter route: it was written there from the grant before the run started.
 *
 * A FAILED RUN NOTIFIES TOO. It means a reader holding a live link got nothing,
 * which is exactly the case nobody would otherwise hear about, and it is why
 * the event carries `outcome` rather than standing for success by existing.
 *
 * The three fields are the whole message: the audience the grant named, the
 * permalink id and which way the run went. Not the description, not the report,
 * not the token -- src/lib/agent-intel/intent.ts is where that rule is written,
 * and a queue message is the one thing here that gets copied into an email and
 * leaves Cloudflare.
 *
 * THE SEND SITS OUTSIDE EVERY STEP, AND OUTSIDE THE WRITE THAT CLOSES THE ROW.
 * Inside the `close` step its own failure would fail that step, and `ROW_STEP`
 * would then repeat the `UPDATE` to fix a queue -- so a refused message would
 * be answered by rewriting a row that was already correct.
 *
 * WHAT A REFUSED SEND DOES INSTEAD, since the placement chooses it: the
 * rejection leaves `run()` and the instance is `errored`, which is strictly
 * more than the old shape managed. Under `ctx.waitUntil` the same rejection was
 * a line in the log and nothing else; now it is a terminal status with a
 * message that `wrangler workflows instances describe` prints. The row is
 * already closed by then, so the reader's permalink is correct either way.
 *
 * NOT EVERY RUN NOTIFIES SINCE #490. The caller checks the run's `notify`
 * flag before calling this, in `FitWorkflow.run` and in `abandonRun` below:
 * runs `/fit/start` opens notify, and runs `analyze_fit` opens do not, which
 * is what the tool did before it opened runs at all. See `openFitRun`.
 *
 * ONE CONSEQUENCE OF BEING OUTSIDE A STEP, named rather than discovered: a
 * resumed instance replays both steps from durable state and then reaches this
 * line again, so a resume can send a second `fit-run` event for one run. That
 * is the right way round. The event is three labels and the operator reads it
 * beside a permalink that says the same thing; a duplicate is noise, and the
 * alternative -- persisting the send as a step so it cannot repeat -- buys
 * silence at the price of a run nobody hears about.
 */
export async function notifyRun(
  env: McpEnv,
  id: string,
  audience: string,
  outcome: 'ok' | 'failed',
): Promise<void> {
  const event = highIntentFor({
    kind: 'fit-run',
    at: new Date().toISOString(),
    audience,
    reportId: id,
    outcome,
  });
  if (event !== null) await env.EVENTS.send(event);
}

/**
 * Closes a row the run never reached, and tells the operator.
 *
 * ONE CALLER, `startRun` above: a `create` that rejects. The row is open by
 * then, and a row nothing will ever write to is the exact state this whole
 * issue exists to end -- `/fit/r/<id>` would refresh for five minutes and then
 * render the stale copy, telling a reader a report was coming that nothing was
 * going to produce.
 *
 * `errored` rather than `refused`: the engine never declined, because the
 * engine was never asked. A run that could not be started is a defect of this
 * system, which is what the closed set's second member means.
 *
 * THE REASON IS `internal` WITH A FIXED DETAIL, not a classification: this
 * function receives no error, only the id, so the underlying cause is in the
 * log line `startRun` writes rather than in the row.
 *
 * `notify` is the run's own flag, handed down from `openFitRun`, so a run that
 * could not be started is reported exactly when one that finished would be.
 *
 * IT SWALLOWS ITS OWN FAILURE AFTER LOGGING, because it is already the
 * fallback. A throw from here would be raised inside the `ctx.waitUntil` that
 * called it, which logs it and changes nothing else, and the five-minute stale
 * branch in src/lib/fit/report-status.ts is the insurance under it -- computed
 * at read time from `created_at`, so nothing has to run for the page to tell
 * the truth.
 */
export async function abandonRun(
  env: McpEnv,
  id: string,
  audience: string,
  notify: boolean,
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE fit_reports
          SET status = 'failed', failure_code = ?, failure_reason = ?, failure_detail = ?,
              no_answer = 0
        WHERE id = ?`,
    )
      .bind(
        'errored' satisfies FitFailureCode,
        'internal' satisfies FailureReason,
        'abandoned: the run could not be started',
        id,
      )
      .run();
    if (notify) await notifyRun(env, id, audience, 'failed');
  } catch (error) {
    console.error(`fit: the run for ${id} could not be abandoned cleanly: ${messageOf(error)}`);
  }
}
