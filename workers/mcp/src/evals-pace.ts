// The scheduled runner's pacing loop and the step policy every case step
// runs under, moved out of ./evals-workflow.ts (issue #448) so a test can
// reach the loop: that module imports `cloudflare:workers` for
// `WorkflowEntrypoint`, which nothing outside workerd can load, and this one
// imports only its types. Every `step.do` that spends inference is here, which
// is why tests/evals-schedule.test.ts scans this file as well as that one.

import type { WorkflowSleepDuration, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { SCHEDULED_PACE_MS } from '../../../src/lib/evals/plan';
import type { CaseResult } from '../../../src/lib/evals/record';
import type { Answered, JudgePending } from './evals-run';

/**
 * NO RETRY ON A CASE, AND THE DEFAULT IS WHAT MAKES THAT A DECISION RATHER
 * THAN AN OMISSION. A `step.do` with no config gets Cloudflare's default
 * policy -- five retries, ten seconds apart, exponential backoff -- and that
 * would be a THIRD retry layer stacked on two this repository has already
 * measured and capped.
 *
 * The layers, so the composition is written down once: AI Gateway retries a
 * call up to four times on its own (recorded in `RETRIES` in
 * src/lib/evals/plan.ts), `ask` and `askJudge` retry once past a transient
 * refusal, and a step would retry on top of both. plan.ts settled on exactly
 * one client attempt for a stated reason -- the gateway already implements
 * this, a failure reaching the client is one it has already given up on, and a
 * second mechanism at a second layer is harder to reason about than either
 * alone. A third is strictly worse than that, and it is not free: a case step
 * that throws is a case that was about to be paid for again, five more times.
 *
 * THE CONCRETE EXPOSURE IS `fit`. `payloadOf` throws when no message in the
 * response answers the request's id -- an event stream carrying only
 * keep-alives or notifications, or a body that is not JSON at all -- which
 * since #351 covers both what it used to throw on and what `rpc`'s own
 * `JSON.parse` used to throw on. Under the default, each
 * throw sends the step back through another `analyze_fit` -- an Opus call over
 * the whole corpus -- five more times, each doing its own client retry, each
 * of those fanning out at the gateway.
 *
 * WHAT A THROW DOES INSTEAD: it leaves `runSuite`, and `run()` writes an
 * `incomplete` row for that suite. That is the same outcome evals/run.mjs
 * reaches by different means -- a throw from `rpc` there takes down the whole
 * suite and the process with it -- and it is strictly more informative,
 * because the row says the suite did not run rather than leaving its absence
 * to be noticed.
 *
 * `delay` is required by the type and inert at a limit of zero.
 *
 * THE TEN-MINUTE DEFAULT STEP TIMEOUT IS CONSIDERED AND LEFT ALONE. What
 * bounds a step here is a call COUNT rather than a guess at latency: a `fit`
 * case is one `analyze_fit` with no client retry at all, and the longest step
 * in any suite is a `chat` case or a `leak` probe, which is at most two chat
 * turns with a sixty-second backoff before the retried one. Its judge is a step
 * of its own since issue #448, two judge calls with the same backoff. Two model
 * calls and a minute of waiting is not a ten-minute step. An earlier version
 * of this sentence put all four calls in one step with a ten-second backoff,
 * which was true until `SCHEDULED_BACKOFF_MS` widened it on 2026-09-27.
 */
export const CASE_STEP: WorkflowStepConfig = { retries: { limit: 0, delay: 0 } };

/** The two methods of `WorkflowStep` the loop uses, which is what a test fakes. */
export interface PacedStep {
  do: WorkflowStep['do'];
  sleep: (name: string, duration: WorkflowSleepDuration) => Promise<void>;
}

/** One unit of work: a step's name and the answer half of the case it runs. */
export interface Unit {
  name: string;
  run: () => Promise<Answered>;
}

/**
 * Runs units in order, one `step.do` each, `SCHEDULED_PACE_MS` apart, and a
 * unit that owes a judge gets a second step for it, a full pace later.
 *
 * NOT BEFORE THE FIRST, which is where the pacing arithmetic in
 * `PACE_MS`'s own comment comes from: the gaps are `cases - 1` summed, two
 * from three fit cases, three from four chat cases and seven from eight leak
 * probes. A sleep before the first case would buy nothing -- there is no
 * preceding request for it to space this one away from.
 *
 * `step.sleep` rather than a `setTimeout`: it suspends the instance instead of
 * holding an invocation open for ninety seconds at a time.
 *
 * `SCHEDULED_PACE_MS`, NOT evals/run.mjs's `PACE_MS`, since 2026-09-27: at the
 * manual runner's twenty-five seconds the gateway refused every scheduled call
 * after the first. The gap arithmetic below still counts in `PACE_MS`'s terms,
 * `cases - 1` summed; only the length of each gap differs.
 *
 * THE JUDGE IS PACED TOO, since issue #448, and that adds one more gap per
 * judged case to the arithmetic above. Measured 2026-09-27 in the gateway log
 * for runs 60 and 61: every judge call that followed its answer by about a
 * second was refused HTTP 429, and the retry sixty seconds later was refused
 * again five times out of eight, while the three that got through came 65 to
 * 67 seconds after the answer. So the ninety seconds between cases was never
 * the problem; the unpaced call inside each case was. The price is wall clock:
 * `leak` becomes fifteen gaps rather than seven, about twenty-three minutes of
 * sleeping, still inside the hour `EVALS_CRONS` leaves it.
 *
 * A JUDGE THAT STILL CANNOT RUN reads as it did before: `judgeCase` records it
 * as a graded failure, and nothing here changes what a result says.
 */
export async function runPaced(
  step: PacedStep,
  units: Unit[],
  judge: (pending: JudgePending) => Promise<CaseResult>,
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const [index, unit] of units.entries()) {
    if (index > 0) await step.sleep(`pace before ${unit.name}`, SCHEDULED_PACE_MS);
    const answered = await step.do(unit.name, CASE_STEP, unit.run);
    if ('result' in answered) {
      results.push(answered.result);
      continue;
    }
    const pending = answered.judge;
    await step.sleep(`pace before ${unit.name}/judge`, SCHEDULED_PACE_MS);
    results.push(await step.do(`${unit.name}/judge`, CASE_STEP, async () => await judge(pending)));
  }
  return results;
}
