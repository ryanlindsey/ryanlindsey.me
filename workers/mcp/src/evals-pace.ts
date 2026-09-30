// The scheduled runner's pacing loop, moved out of ./evals-workflow.ts so a
// test can reach it: that module imports `cloudflare:workers` for
// `WorkflowEntrypoint`, which nothing outside workerd can load, and this one
// imports only its types.

import type { WorkflowSleepDuration, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { SCHEDULED_PACE_MS } from '../../../src/lib/evals/plan';
import type { CaseResult } from '../../../src/lib/evals/record';
import type { Answered, JudgePending } from './evals-run';

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
  config: WorkflowStepConfig,
  units: Unit[],
  judge: (pending: JudgePending) => Promise<CaseResult>,
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const [index, unit] of units.entries()) {
    if (index > 0) await step.sleep(`pace before ${unit.name}`, SCHEDULED_PACE_MS);
    const answered = await step.do(unit.name, config, unit.run);
    if ('result' in answered) {
      results.push(answered.result);
      continue;
    }
    const pending = answered.judge;
    await step.sleep(`pace before ${unit.name}/judge`, SCHEDULED_PACE_MS);
    results.push(await step.do(`${unit.name}/judge`, config, async () => await judge(pending)));
  }
  return results;
}
