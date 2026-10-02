// The deferred fit run (#349), as a Cloudflare Workflow.
//
// WHY THIS EXISTS, WHICH IS A PRODUCTION DEFECT RATHER THAN A PREFERENCE.
// Epic #270 moved the `analyze_fit` call off the response and into
// `ctx.waitUntil`. For an HTTP-triggered Worker that is capped at 30 seconds
// after the response is sent, and Cloudflare CANCELS anything still unsettled
// at the cap (workers/runtime-apis/context). `analyze_fit` was MEASURED at
// 78,222 ms on 2026-09-18, trace 77c557ab4623b2fa059f29c7f75053b2, which is
// 2.6 times the budget -- so the engine call was killed on every real run and
// the `UPDATE` that closes the row never ran.
//
// CONFIRMED AGAINST PRODUCTION 2026-09-22 rather than inferred. One run on a
// one-day `fit`-scoped token: `POST /fit/start` answered
// `200 {"id":"QIdjP22q7RAJi1No8Ckjag"}` in 0.98 s, and the row then read
// `pending` with `model`, `report_json` and `citations_checked` all null at
// t+25, 40, 60, 85, 110 and 150 seconds. At t+150, 1.9 times the run's own
// measured duration, nothing had moved and no `fit-run` notification had
// arrived. The reader got a permalink in a second and watched it refresh until
// the stale copy appeared at five minutes.
//
// WHY A WORKFLOW AND NOT THE QUEUE THE DOCUMENTATION NAMES FIRST. Both would
// work and issue #349's own body recommended the queue. The Workflow was
// chosen because every part of it already exists here: workers/mcp/wrangler.jsonc
// binds `workflows` today, `EvalsWorkflow` in ./evals-workflow.ts is the same
// shape spending the same kind of call, and that file records the measurement
// that decides it -- MEASURED 2026-09-18, the `workflows` binding boots and
// creates real instances UNDER THIS REPOSITORY'S TEST HARNESS, unlike `ai` and
// `ai_search`. That is the whole difference that matters: the `ctx.waitUntil`
// shape was invisible to every test in this repository, which is why a defect
// this total reached production and stayed there. An instance is addressable,
// carries a terminal status, and tests/fit-workflow.test.ts reads both.
//
// The second reason is durability rather than budget. `step.do` persists a
// step's result, so an instance that is evicted or restarted REPLAYS the
// engine call it already paid for instead of paying again. A queue consumer
// redelivering a message has no such record and would re-run the whole
// seventy-eight seconds.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { analyzeFit, FitUnavailable, type FitResult } from '../../../src/lib/fit/engine';
import { classifyFailure, type FailureReason } from '../../../src/lib/failure/classify';
import type { FitFailureCode } from '../../../src/lib/fit/report-status';
import { fitEnv } from './gated';
import { messageOf, notifyRun } from './fit-run';
import type { McpEnv } from './env';

/**
 * What `/fit/start` hands an instance: the permalink id, and nothing else --
 * which was the whole of it until #490, and is now the id and one boolean.
 * `analyze_fit` hands over the same shape, through the same `openFitRun` in
 * ./fit-run.ts.
 *
 * `notify` IS THE ONE ADDITION, AND IT IS NOT A CALLER'S PROSE. It says
 * whether the run ends with a `fit-run` event: true from `/fit/start`, false
 * from `analyze_fit`, for the reason given on `openFitRun`. Everything this
 * comment argues below is about keeping what a caller TYPED, and the token, out
 * of durable state; a flag this Worker sets from which of its own routes
 * opened the run carries neither, and is the one fact the run cannot read back
 * off the row. OPTIONAL ON PURPOSE: an instance created before #490 has no such
 * field, and `notifyOf` reads its absence as true, which is what every run did
 * then.
 *
 * THE TOKEN IS NOT HERE, AND THAT IS THE EPIC'S CONSTRAINT RATHER THAN A
 * PREFERENCE. It is consumed at `/fit/start` or at the tool call, where
 * `resolveGrant` was the one authorization check, and it is never needed
 * again -- this run is finishing work that was already authorized rather than
 * authorizing anything itself.
 *
 * `target_description` IS NOT HERE EITHER, AND THAT ONE TOOK ARGUING. It is
 * already in hand at the route, so passing it would save a read. What it would
 * also do is copy prose a caller pasted into a second store: a workflow
 * instance's params are durable state, retained by Cloudflare for up to 30 days
 * after the instance completes (workflows/reference/limits), and
 * src/lib/retention.ts is table-driven over D1 and cannot trim it. That module's
 * own comment says adding a store that holds something a visitor typed means
 * adding a row to it, and there is no row that can be added for this one.
 * `fit_reports.target_description` is the published home for that text, under a
 * 365-day window /ai-policy states out loud. So the run reads it back from the
 * row it is named after.
 *
 * The third thing the id-first shape buys is that the run is ANCHORED to the
 * row. A run whose row is gone has nothing to write to, and `run()` below
 * refuses before it reaches the one `expensive` tool in this server rather than
 * spending seventy-eight seconds on an `UPDATE` that would match no rows.
 *
 * The cost is one D1 read in front of a call measured at 78,222 ms.
 *
 * THIS IS HALF THE STORY AND THE OTHER HALF IS BESIDE `Attempt` BELOW. Keeping
 * the description out of the params does not keep every trace of it out of
 * durable state: the analyze step persists the REPORT, and a requirement in a
 * report is quoted or closely paraphrased from the description. That is
 * accepted, bounded and argued there, and a reader who stops here would carry
 * away a stronger claim than this design makes.
 */
export interface FitRunParams {
  id: string;
  notify?: boolean;
}

/**
 * NO RETRY ON THE ENGINE, AND THE DEFAULT IS WHAT MAKES THAT A DECISION.
 *
 * A `step.do` with no config takes Cloudflare's default policy -- five
 * retries, ten seconds apart, exponential backoff, read from `defaultConfig`
 * at workflows/build/sleeping-and-retrying. `analyze_fit` is the only
 * `expensive` tool in this server, one frontier-model call over the whole
 * corpus, and the limiter metered this run EXACTLY ONCE, at `/fit/start` or in
 * `analyze_fit`'s own guard, whichever opened it (#490). Five
 * unmetered repeats of a 78-second Opus call is the most expensive thing an
 * omitted argument could buy anywhere in this repository.
 *
 * It composes with two retry layers this repository has already measured and
 * capped, which is the same argument `CASE_STEP` in ./evals-workflow.ts makes
 * at more length: AI Gateway retries a call up to four times on its own, and
 * `analyzeFit` makes exactly one client attempt for the reason `RETRIES` in
 * src/lib/evals/plan.ts records. A third layer on top is strictly worse.
 *
 * WHAT A FAILED RUN DOES INSTEAD is not throw at all. The step below returns a
 * verdict rather than raising one, so the ordinary failure path never reaches
 * this policy; see `attempt` for why that shape was chosen. What is left for
 * `limit: 0` to govern is a step that crashes rather than fails -- and a crash
 * that repeated five times would be five more engine calls to reach the same
 * place `run()`'s catch reaches on the first.
 *
 * `delay` is required by the type and inert at a limit of zero.
 *
 * THE TEN-MINUTE DEFAULT STEP TIMEOUT IS CONSIDERED AND LEFT ALONE. The call
 * it bounds was measured at 78,222 ms, so the default is 7.7 times the
 * measurement, and Cloudflare's own rules-of-workflows page asks for step
 * timeouts of 30 minutes or less. A tighter number here would be a guess at
 * latency dressed as a limit.
 *
 * THAT 78,222 MS WAS OPUS 5 UNDER AN 8192-TOKEN CAP, which is again what the
 * engine runs since 2026-10-01. Between #379 and then it ran Opus 5.5, whose
 * thinking cannot be switched off, under a 32000-token cap, and nothing timed
 * that. The measurement describes the deployed engine again, though the
 * corpus has grown since it was taken.
 */
const ENGINE_STEP: WorkflowStepConfig = { retries: { limit: 0, delay: 0 } };

/**
 * ONE retry on the row write, which is where a retry earns its keep.
 *
 * The same reasoning as `RECORD_STEP` in ./evals-workflow.ts, and it applies
 * harder here: what this step repeats is a D1 write, and what it protects is a
 * report that cost seventy-eight seconds of inference to produce. The
 * 2026-09-11 incident evals/run.mjs records was a transient write failure
 * against the same database, so one cheap second attempt is worth having.
 *
 * One rather than the default five, and five seconds rather than ten with
 * exponential backoff: past the second attempt the honest reading is that the
 * store is down, and stalling the instance for five minutes to discover it
 * helps nobody.
 */
const ROW_STEP: WorkflowStepConfig = { retries: { limit: 1, delay: '5 seconds' } };

/**
 * What the engine step returns: a report, or the closed-set code for why there
 * is none.
 *
 * IT RETURNS A VERDICT RATHER THAN THROWING ONE, and that is the one decision
 * in this file that would look like a tidy-up to undo. `completeRun` used to
 * read `error instanceof FitUnavailable` to choose between `refused` and
 * `errored`, which was sound because the throw and the catch were in the same
 * call. A step boundary is not: an error raised inside `step.do` is captured
 * into durable state and handed back, which is the same class of boundary
 * src/lib/fit/engine.ts already records `FitUnavailable` losing its prototype
 * across -- "the instance is structured-cloned and `instanceof` does not
 * survive -- the name is what the far side has left to recognise", with
 * tests/fit-engine.test.ts pinning the `name`. Classifying INSIDE the step,
 * where the call is in-process and `instanceof` is certainly sound, means
 * nothing has to be recognised on the far side at all.
 *
 * `failure_code` STAYS THE CLOSED SET src/lib/fit/report-status.ts renders,
 * `refused` and `errored`, because `/fit/r/<id>` is designed to be forwarded to
 * people holding no token and an unrecognised code renders nothing.
 *
 * The second thing this shape buys: a refusal is PERSISTED like any other step
 * result, so a resumed instance replays the refusal instead of asking the
 * engine again.
 *
 * WHAT THIS DOES PUT INTO DURABLE STATE, WHICH `FitRunParams` ABOVE GOES TO
 * SOME LENGTH TO KEEP OUT OF IT. That comment argues the pasted description
 * must not enter a 30-day store src/lib/retention.ts cannot sweep. The `result`
 * on the branch above is a `FitResult`, and `Requirement.requirement`
 * (src/lib/fit/schema.ts) is declared as "one requirement, quoted or closely
 * paraphrased from the target description" -- so the report carries the model's
 * extraction of that same text, and a successful step persists it. Read only
 * the params comment and you would think nothing of the caller's prose reaches
 * workflow state. Some of it does.
 *
 * IT IS ACCEPTED RATHER THAN OVERLOOKED, and the trade is exactly the one
 * `ENGINE_STEP` above rests on: what makes the analyze and close steps separate
 * is that an eviction between them must not re-pay a call measured at 78,222
 * ms, and the only way a step can be replayed instead of re-run is for its
 * value to be persisted. Refusing to persist the report means one step, and one
 * step means paying twice.
 *
 * THE BOUND, so this is a size rather than a shrug. What is persisted is the
 * report, not the description: an extraction of the requirements rather than
 * the paste, and the same document this run is about to write to
 * `fit_reports.report_json` and publish at a forwardable permalink. It lives
 * under Workflows' retention -- up to 30 days on this plan -- where the row it
 * duplicates lives for 365 under a window /ai-policy states out loud. So the
 * copy in workflow state is a strict subset of published content with a shorter
 * life than the copy this repository already commits to keeping. The
 * description itself -- the verbatim paste, which is what
 * src/lib/agent-intel/intent.ts's rule is actually about -- stays out of both
 * the params and every step return.
 *
 * THE LINE THAT WOULD CROSS IT: returning the description, or a `FitResult` for
 * a run whose report is NOT going to be published. Either turns a bounded
 * duplicate into a second, unswept original.
 */
type Attempt =
  | { ok: true; result: FitResult }
  | {
      ok: false;
      code: FitFailureCode;
      message: string;
      // Classified INSIDE the step callback and carried as plain strings: a
      // step's return value is serialized into durable state, so an Error or
      // its cause chain would not survive the trip.
      reason: FailureReason;
      detail: string;
      // Two more plain values for `get_fit_report` (#490). `noAnswer` is
      // `FitUnavailable.noAnswer`, read inside the step for the same
      // `instanceof` reason as `code`. `publicMessage` is the engine's own
      // sentence for a `FitUnavailable` and null for every other error, so
      // upstream text never reaches a column a caller can read. It is public
      // copy the engine wrote to be shown, not a caller's prose, so it adds
      // nothing to what the bound above argues about. Both are optional on the
      // type because an instance whose analyze step finished under older code
      // replays an Attempt without them.
      noAnswer?: boolean;
      publicMessage?: string | null;
    };

export class FitWorkflow extends WorkflowEntrypoint<McpEnv, FitRunParams> {
  /**
   * THE ROW IS READ OUTSIDE EVERY `step.do`, AND THAT IS THE SAME DECISION
   * `EvalsWorkflow` records about minting its token, for the same reason.
   *
   * A `step.do`'s return value is persisted in the instance's durable state so
   * that a resumed instance can replay the step instead of re-running it. The
   * value this read returns is `target_description`, which is prose a caller
   * pasted -- so wrapping this in a step would put that text into exactly the
   * store `FitRunParams` above went to the trouble of keeping it out of.
   * Reading it here means a resumed instance re-reads the row and the durable
   * state never holds the description at all.
   *
   * So tidying this into `step.do('read', ...)` -- which would look like an
   * improvement, since both of the other calls here are steps -- reverses that
   * silently and with every test still green. It is written down because the
   * reason is invisible in the code.
   *
   * The cost is one extra D1 read per resume, against a call measured at
   * 78,222 ms.
   *
   * IT DOES NOT GUARD ON `status`, WHICH LOOKS LIKE AN OMISSION AND IS NOT. A
   * guard refusing a row that is no longer `pending` would protect against a
   * second run on a finished report -- and would refuse exactly the case it
   * must not, because a RESUMED instance re-reads a row its own `close` step
   * has already written. The route cannot create a second instance for one
   * report in any case: the instance id IS the report id, and Workflows
   * instance ids are unique per workflow.
   */
  async run(event: Readonly<WorkflowEvent<FitRunParams>>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    const id = reportIdOf(event.payload);

    const row = await env.DB.prepare(
      `SELECT audience, target_description AS targetDescription FROM fit_reports WHERE id = ?`,
    )
      .bind(id)
      .first<{ audience: string; targetDescription: string }>();

    if (row === null) {
      // IT THROWS RATHER THAN RETURNING QUIETLY, following `suitesOf` in
      // ./evals-workflow.ts: there is no row to record an outcome on, so the
      // instance's own error is the only place this can be read, and
      // `wrangler workflows instances describe` is where whoever typed the
      // command is already looking. It spends nothing, because the refusal is
      // ahead of the engine call.
      //
      // The reachable cause is a person: `wrangler workflows trigger rlme-fit`
      // takes an arbitrary params string. The other is time -- `fit_reports`
      // is swept at 365 days (src/lib/retention.ts) -- which no live run can
      // reach.
      throw refuse(`no fit report is stored under the id ${id}`);
    }

    // THE `try` AROUND THE STEP IS FOR A STEP THAT CRASHED, NOT FOR A RUN THAT
    // FAILED. The callback below answers every engine failure with a verdict,
    // so nothing ordinary reaches this catch; what does is the step machinery
    // itself -- an exceeded timeout, an eviction that exhausts `ENGINE_STEP`'s
    // zero retries, a return value over the 1 MiB a step may persist.
    //
    // WITHOUT IT THE ROW WOULD BE LEFT `pending`, which is the exact state
    // #349 exists to end: the throw would leave `run()`, the instance would be
    // `errored`, and `/fit/r/<id>` would refresh for five minutes before
    // rendering the stale copy. Closing it as `errored` costs one D1 write and
    // tells the reader something true. It is also what `completeRun` did for
    // every throw, so this preserves that behaviour rather than inventing one.
    let attempt: Attempt;
    try {
      attempt = await step.do('analyze', ENGINE_STEP, async (): Promise<Attempt> => {
        try {
          return { ok: true, result: await analyzeFit(fitEnv(env), row.targetDescription) };
        } catch (error) {
          // `refused` is the engine declining for a reason it wrote a sentence
          // about -- the breaker, an empty corpus, an unusable answer. Anything
          // else is a defect, and the two are worth telling apart on /ops even
          // though the reader is told the same thing.
          const failure = classifyFailure(error);
          return {
            ok: false,
            code: error instanceof FitUnavailable ? 'refused' : 'errored',
            message: messageOf(error),
            reason: failure.reason,
            detail: failure.detail,
            noAnswer: error instanceof FitUnavailable && error.noAnswer,
            publicMessage: error instanceof FitUnavailable ? error.message : null,
          };
        }
      });
    } catch (error) {
      // `errored` rather than `refused`, and not by default: the engine never
      // got to decline, so the only member of the closed set that fits is the
      // one meaning a defect of this system.
      const failure = classifyFailure(error);
      attempt = {
        ok: false,
        code: 'errored',
        message: `the analyze step did not finish: ${messageOf(error)}`,
        reason: failure.reason,
        detail: failure.detail,
        noAnswer: false,
        publicMessage: null,
      };
    }

    if (!attempt.ok) {
      // The message is INTERPOLATED rather than passed as a second argument.
      // MEASURED 2026-09-17: Cloudflare Worker observability renders
      // `console.error(msg, err)` as the message followed by the stack and
      // drops `err.message` entirely, which is what made the original `/fit`
      // failure take several rounds of log reading to place. Nothing about the
      // caller's token reaches this line, and nothing may be added that does.
      console.error(`fit: the run for ${id} failed (${attempt.code}): ${attempt.message}`);
    }

    await step.do('close', ROW_STEP, async () => {
      if (attempt.ok) {
        await env.DB.prepare(
          `UPDATE fit_reports
              SET status = 'ok', model = ?, report_json = ?,
                  citations_checked = ?, citations_dropped = ?,
                  generated_at = ?, corpus_documents = ?, corpus_truncated = ?
            WHERE id = ?`,
        )
          .bind(
            attempt.result.model,
            JSON.stringify(attempt.result.report),
            attempt.result.citations.checked,
            attempt.result.citations.dropped,
            attempt.result.generatedAt,
            attempt.result.corpusDocuments,
            attempt.result.corpusTruncated ? 1 : 0,
            id,
          )
          .run();
      } else {
        // The fallbacks are there because an instance whose analyze step finished under the code
        // before #465 replays its cached Attempt without a reason or detail
        // across a deploy, and `.bind(undefined)` throws. The same goes for
        // `noAnswer` and `publicMessage`, which arrived with #490.
        await env.DB.prepare(
          `UPDATE fit_reports
              SET status = 'failed', failure_code = ?, failure_reason = ?, failure_detail = ?,
                  no_answer = ?, failure_message = ?
            WHERE id = ?`,
        )
          .bind(
            attempt.code,
            attempt.reason ?? 'internal',
            attempt.detail ?? null,
            attempt.noAnswer ? 1 : 0,
            attempt.publicMessage ?? null,
            id,
          )
          .run();
      }
      return id;
    });

    // Only a run that asked for it: see `notify` on `FitRunParams`.
    if (notifyOf(event.payload)) {
      await notifyRun(env, id, row.audience, attempt.ok ? 'ok' : 'failed');
    }
  }
}

/**
 * The report id a payload asks for, or a thrown error naming what arrived.
 *
 * `FitRunParams` IS A PROMISE THE CALLER MAKES AND NOTHING ENFORCES, exactly as
 * `EvalsRunParams` is. `openFitRun` (./fit-run.ts) always passes a freshly
 * minted id, for `/fit/start` and for `analyze_fit` alike, and is
 * fine; the caller this exists for is a person at
 * `wrangler workflows trigger rlme-fit`, which takes its params as an optional
 * positional JSON string, so omitting them is both easy and valid at the CLI.
 *
 * Truncated because the payload is arbitrary JSON and this string reaches both
 * the log and the instance's error, neither of which is a place for an
 * unbounded value somebody pasted.
 */
function reportIdOf(payload: FitRunParams | undefined): string {
  const requested: unknown = payload?.id;
  if (typeof requested !== 'string' || requested === '') {
    throw refuse(`the deferred run was given no report id (payload.id was ${typeof requested})`);
  }
  return requested.slice(0, 64);
}

/**
 * Whether the run ends with a `fit-run` event. Anything but an explicit
 * `false` is true, so an instance created before #490, whose params carry no
 * `notify`, notifies exactly as it would have then.
 */
function notifyOf(payload: FitRunParams | undefined): boolean {
  return payload?.notify !== false;
}

/**
 * Logs a refusal and returns the error to throw.
 *
 * BOTH, for the reason ./evals-workflow.ts's own `refuse` gives: the throw is
 * what an operator running `wrangler workflows instances describe` reads, and
 * the log line is what puts this beside every other `fit:` message from the
 * same Worker for somebody grepping observability after the fact. Neither
 * channel reaches the other.
 */
function refuse(reason: string): Error {
  console.error(`fit: ${reason}`);
  return new Error(`fit: ${reason}`);
}
