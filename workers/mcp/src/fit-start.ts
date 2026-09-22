import { highIntentFor } from '../../../src/lib/agent-intel/intent';
import { analyzeFit, FitUnavailable } from '../../../src/lib/fit/engine';
import { newReportId } from '../../../src/lib/fit/report-id';
import { hasScope, resolveGrant } from '../../../src/lib/tier/grant';
import { limitAndAudit } from './define';
import { fitEnv, FIT_INPUT } from './gated';
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
 * the operator needs and nothing a caller typed. `completeRun` does put one
 * message on that queue (#277), and it is that rule's shape rather than an
 * exception to it: three labels, none of them typed by the caller.
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
      ctx.waitUntil(completeRun(env, id, grant.audience, call.target_description));
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
 * Runs the engine, closes the row and tells the operator, whichever way it
 * goes.
 *
 * THE NOTIFICATION IS QUEUED FROM HERE BECAUSE THIS IS WHERE THE RUN ENDS
 * (#277). It used to be queued by the site Worker, off the 303 to
 * `/fit/r/<id>`, which was an unambiguous "a report exists" until #269 made
 * that redirect mean "a run started" instead -- so the operator was told at
 * the moment nothing had been generated, and was never told when something
 * was. This Worker resolved the grant, so it is also the only one that can
 * name the audience without a second verifier.
 *
 * A FAILED RUN NOTIFIES TOO. It means a reader holding a live link got
 * nothing, which is exactly the case nobody would otherwise hear about, and it
 * is why the event carries `outcome` rather than standing for success by
 * existing.
 *
 * `await` RATHER THAN `ctx.waitUntil`: every call of this function is already
 * inside one, and a nested `waitUntil` buys no extra time while letting the
 * send outlive the handler that scheduled it.
 *
 * THE SEND SITS OUTSIDE THE `try`, which is the one thing about the shape
 * below worth pausing on. Inside the successful branch it would be a send
 * whose own failure lands in the `catch`, and the `catch` writes
 * `status = 'failed'` -- so a queue that refused a message would rewrite a run
 * that produced a report as one that did not, send a second event saying so,
 * and leave the reader's permalink contradicting the report behind it.
 *
 * WHAT A REFUSED SEND DOES INSTEAD, since the placement above chooses it: the
 * rejection leaves this function and settles the promise the caller handed to
 * `ctx.waitUntil`, which logs it. That is the outcome worth having. The row is
 * already closed by then, so the reader's permalink is correct either way and
 * nothing here is left half written; what is lost is one operator
 * notification, which is the cheapest thing in this path to lose. It is log
 * noise rather than state damage, and it was chosen rather than overlooked.
 */
async function completeRun(
  env: McpEnv,
  id: string,
  audience: string,
  description: string,
): Promise<void> {
  let outcome: 'ok' | 'failed';
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
    outcome = 'ok';
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
    outcome = 'failed';
  }
  await notifyRun(env, id, audience, outcome);
}

/**
 * Puts the finished run on the events queue.
 *
 * The three fields are the whole message: the audience the grant named, the
 * permalink id and which way the run went. Not the description, not the
 * report, not the token -- src/lib/agent-intel/intent.ts is where that rule is
 * written, and a queue message is the one thing here that gets copied into an
 * email and leaves Cloudflare.
 */
async function notifyRun(
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
