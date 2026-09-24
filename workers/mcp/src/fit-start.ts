import { newReportId } from '../../../src/lib/fit/report-id';
import { hasScope, resolveGrant } from '../../../src/lib/tier/grant';
import { limitAndAudit } from './define';
import { abandonRun, messageOf } from './fit-workflow';
import { FIT_INPUT } from './gated';
import type { McpEnv } from './env';

/**
 * Opens a fit run and answers with its permalink id (#269).
 *
 * THE WAIT MOVED, NOT THE WORK. The fit engine takes about eighty seconds --
 * measured at 78,222 ms on 2026-09-18 -- and `/fit/run` used to hold the
 * browser open for every one of them. This route writes the row, hands back the
 * id, and starts a Workflow instance to finish the run.
 *
 * THE SHAPE THIS REPLACES, AND WHY IT FAILED, because deleting it would leave
 * the next reader free to reach for it again. Epic #270 finished the run in
 * `ctx.waitUntil(completeRun(...))`. For an HTTP-triggered Worker that is
 * capped at 30 seconds after the response is sent and Cloudflare CANCELS
 * anything still unsettled at the cap, so a call measured at 2.6 times the
 * budget was killed mid-engine on every real run. CONFIRMED IN PRODUCTION
 * 2026-09-22: one run answered `200 {"id":"QIdjP22q7RAJi1No8Ckjag"}` in 0.98 s
 * and the row read `pending`, with `model`, `report_json` and
 * `citations_checked` all null, at t+25, 40, 60, 85, 110 and 150 seconds. The
 * `UPDATE` never ran and no notification arrived. Nothing in this repository
 * could see it: `FIT_ENGINE`'s harness modes refuse in half a second at the
 * slowest, three orders of magnitude inside the budget, so no test could reach
 * a real eighty-second run. That invisibility is why the Workflow was chosen
 * over the queue #349 first recommended -- workers/mcp/src/fit-workflow.ts
 * carries the rest of that argument.
 *
 * `ctx.waitUntil` IS STILL HERE AND IS NOT THE THING THAT BROKE. What it holds
 * now is `env.FIT_WORKFLOW.create`, which settles in milliseconds; the budget
 * it sits inside is three orders of magnitude larger than that. The rule the
 * defect actually taught is narrower than "no `waitUntil`": nothing whose
 * duration is a measured number may be scheduled on a budget that is not.
 *
 * THE TOKEN NEVER LEAVES THIS REQUEST. It is not written to the row, not put
 * into the workflow's params, not persisted in any step's durable state and not
 * logged. The instance is handed the permalink id alone and reads the rest back
 * off the row -- the reasoning, including why the pasted description stays out
 * of the params too, is beside `FitRunParams` in ./fit-workflow.ts.
 *
 * LIMITED AND AUDITED THROUGH `limitAndAudit`, which is the same implementation
 * `defineTool` uses. `analyze_fit` is the only `expensive` tool in the server,
 * and a route that reached the engine around the limiter would be an unmetered
 * path to it.
 *
 * `resolveGrant` IS ASKED HERE AND NOWHERE ELSE ON THIS PATH. The site holds
 * the token as an opaque string and cannot verify it (src/lib/fit/client.ts);
 * this Worker is the one authorization check, and a second one would be a copy
 * that proves nothing by agreeing with the first. The Workflow does not add one
 * either: it finishes work this check already authorized, and it never sees a
 * bearer.
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

  // THE TOOL'S OWN SCHEMA, not a copy of its numbers (#275). `analyze_fit`
  // declares `FIT_INPUT` and the SDK enforces it before `limitAndAudit` runs,
  // which is what kept a five-character description from ever reaching the
  // engine while `/fit/run` went through the tool. It does not any more, so
  // this route is the floor: without this line a hand-rolled POST opens a row
  // and spends an expensive-bucket inference call on two words. `minlength` on
  // the form is a browser's courtesy and not a check.
  //
  // The TRIMMED value is what is parsed, so whitespace cannot pad a short
  // description past the floor. That makes this a shade stricter than the tool
  // and never looser, which is the direction an unguarded path should err in.
  //
  // `null` rather than the schema's own message, unlike the tool: the message
  // is written for a calling agent that can act on it, and this surface
  // answers every refusal the way an unrouted path does. A 400 saying "too
  // short" would tell anyone holding a link that the route is real.
  if (!FIT_INPUT.safeParse({ target_description: description }).success) return null;

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
  //
  // WHAT THE AUDIT ROW THIS WRITES MEANS, which is the second half of #349 and
  // was found by the same production run. `limitAndAudit` audits the moment the
  // guarded body returns, so this row said `analyze_fit / tier=private /
  // outcome=ok / duration_ms=487` for a run that went on to produce nothing.
  // The row is kept exactly as it is and it means ACCEPTED: the call the
  // limiter metered really did succeed, in 487 ms, and 487 ms is how long
  // accepting takes. What the RUN came to is recorded where the run ends, on
  // `fit_reports.status` and in the `fit-run` event, which is the pair this
  // issue makes reliable -- before the fix neither ever happened, so there was
  // no honest record of a run anywhere and this row was the only thing left
  // being read as one.
  //
  // WHY NOT A SECOND ROW WHEN THE RUN CLOSES, which is the obvious repair. One
  // accepted call has to stay one row: scripts/token.mjs answers "what did this
  // token read" by counting `mcp_tool_calls` per `grant_jti`, /ops groups by
  // tool, and the limiter's whole claim is that a metered call leaves one
  // record. A second row under the same name would double every one of those
  // for the one tool whose spend matters most. tests/fit-workflow.test.ts pins
  // the count so the repair cannot be made later without meeting this comment.
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

      // The eighty seconds, off the response AND off this request's lifetime.
      // `waitUntil` rather than an await: creating an instance is a round trip
      // to the Workflows API, and the whole point of this route is that the
      // caller does not wait for anything it does not have to.
      ctx.waitUntil(startRun(env, id, grant.audience));
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
 * It also makes a second instance for one report impossible from this route,
 * which is what lets ./fit-workflow.ts's row read skip a `status` guard.
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
 * which is the distinction the doc comment above draws.
 */
async function startRun(env: McpEnv, id: string, audience: string): Promise<void> {
  try {
    await env.FIT_WORKFLOW.create({ id, params: { id } });
  } catch (error) {
    console.error(`fit: the run for ${id} could not be started: ${messageOf(error)}`);
    await abandonRun(env, id, audience);
  }
}
