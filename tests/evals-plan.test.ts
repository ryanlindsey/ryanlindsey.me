import { expect, test } from 'vitest';
import {
  BACKOFF_MS,
  CORPUS_CRON,
  EVALS_CRONS,
  PACE_MS,
  RETRIES,
  SCHEDULED_BACKOFF_MS,
  SCHEDULED_PACE_MS,
  SUITE_ORDER,
  evalsRunEnabled,
  suitesForCron,
  type SuiteName,
} from '../src/lib/evals/plan';

// Task 1 (issue #291): the pacing constants (moved verbatim from
// evals/run.mjs, comments included) and the cron-to-suite mapping Task 4's
// Worker runner reads from `scheduled()`.

test('the pacing constants match evals/run.mjs', () => {
  expect(PACE_MS).toBe(25000);
  expect(RETRIES).toBe(1);
  expect(BACKOFF_MS).toBe(10_000);
});

test('the scheduled run paces wider than the manual one, and neither moves the other', () => {
  // Measured 2026-09-27 against the ryanlindsey-me gateway: at the manual
  // runner's 25s gap and 10s backoff, every scheduled case after the first
  // was answered HTTP 429 "Wholesale rate limit exceeded", and the one probe
  // that got through mid-run did so after a 34s gap. A lone call from a
  // visitor minutes later succeeded. The Workflow gets its own, wider pair;
  // evals/run.mjs keeps the pair above so a pre-merge run stays short.
  expect(SCHEDULED_PACE_MS).toBe(90_000);
  expect(SCHEDULED_BACKOFF_MS).toBe(60_000);
  expect(SCHEDULED_PACE_MS).toBeGreaterThan(PACE_MS);
  expect(SCHEDULED_BACKOFF_MS).toBeGreaterThan(BACKOFF_MS);
});

test('SUITE_ORDER is tier, fit, chat, leak, in run order', () => {
  expect(SUITE_ORDER).toEqual(['tier', 'fit', 'chat', 'leak']);
});

test('SUITE_ORDER agrees with the SuiteName union', () => {
  // A compile-time check as much as a runtime one: this only type-checks if
  // every member of SUITE_ORDER is assignable to SuiteName and vice versa,
  // since SuiteName is derived as `(typeof SUITE_ORDER)[number]`.
  const names: SuiteName[] = [...SUITE_ORDER];
  expect(names).toEqual(SUITE_ORDER);
});

test('every suite has its own cron, and each cron asks for exactly that suite', () => {
  expect(Object.keys(EVALS_CRONS).sort()).toEqual([...SUITE_ORDER].sort());
  expect(new Set(Object.values(EVALS_CRONS)).size).toBe(SUITE_ORDER.length);
  for (const suite of SUITE_ORDER) {
    expect(suitesForCron(EVALS_CRONS[suite])).toEqual([suite]);
  }
});

test('suitesForCron: the corpus cron asks for no eval suite', () => {
  expect(suitesForCron(CORPUS_CRON)).toEqual([]);
  expect(Object.values(EVALS_CRONS)).not.toContain(CORPUS_CRON);
});

/** `m h * * ?` as minutes past midnight. Only the two fields these crons vary. */
function minutesPastMidnight(cron: string): number {
  const [minute, hour] = cron.split(' ');
  const parsed = Number(minute) + Number(hour) * 60;
  expect(Number.isFinite(parsed), `${cron} is not a fixed minute-and-hour expression`).toBe(true);
  return parsed;
}

test('the suites fire in SUITE_ORDER, an hour apart, so leak is still last', () => {
  // Separate instances an hour apart are what give the gateway quiet time
  // between suites; the ordering is what keeps `leak`, the disclosure gate,
  // the last result of a Sunday, as evals/README.md asks.
  const starts = SUITE_ORDER.map((suite) => minutesPastMidnight(EVALS_CRONS[suite]));
  for (let index = 1; index < starts.length; index += 1) {
    expect(starts[index]! - starts[index - 1]!, `${SUITE_ORDER[index]} starts too soon`).toBe(60);
  }
});

test('every evals cron leaves the corpus refresh a wide gap', () => {
  // WHAT THE GAP IS FOR. `fit` and `chat` are graded against the Vectorize
  // index that `CORPUS_CRON` re-embeds and upserts that same morning.
  // src/lib/corpus.ts is incremental, so most Sundays that refresh is nearly
  // instant -- but the Sunday after content lands is the one where it is not,
  // and that is exactly the Sunday this schedule exists for. A Vectorize
  // `upsert` returns a mutation id and the index reflects it some time later,
  // so a `chat` case with a `min_sources` expectation can query a
  // still-applying index and go red with no regression behind it.
  //
  // NINETY MINUTES IS SLACK, NOT MEASUREMENT, and `EVALS_CRONS`'s own comment
  // in src/lib/evals/plan.ts says so at length. This test pins the slack
  // rather than the number: 90 is the floor, and moving any evals cron back
  // toward the refresh is the change that has to argue with it.
  for (const suite of SUITE_ORDER) {
    const gap = minutesPastMidnight(EVALS_CRONS[suite]) - minutesPastMidnight(CORPUS_CRON);
    expect(gap, `${suite} starts too close to the corpus refresh`).toBeGreaterThanOrEqual(90);
  }
});

test('tier runs daily, and the three inference suites on Sunday under Cloudflare day numbering', () => {
  // `tier` makes no model call, so a daily run costs one D1 write. The other
  // three spend inference and run weekly, which is the whole of the cost
  // decision (2026-09-27): daily would have been about seven times the spend.
  //
  // Cloudflare's day-of-week field runs 1 = Sunday to 7 = Saturday, not the
  // Unix 0 = Sunday. Every document described this schedule as Monday until
  // issue #340, measured against `eval_runs` rows dated Sunday 2026-09-20.
  // Changing the day means changing this test and every comment that names it.
  const cloudflareDays = [
    '',
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  expect(EVALS_CRONS.tier.split(' ')[4]).toBe('*');
  for (const suite of ['fit', 'chat', 'leak'] as const) {
    const dayOfWeek = EVALS_CRONS[suite].split(' ')[4];
    expect(cloudflareDays[Number(dayOfWeek)], `${suite} is not on Sunday`).toBe('Sunday');
  }
});

test('suitesForCron: an unknown expression asks for none', () => {
  expect(suitesForCron('0 0 * * *')).toEqual([]);
});

// --- evalsRunEnabled ------------------------------------------------------

test('evalsRunEnabled: an absent EVALS_RUNNER means the deployed default, true', () => {
  expect(evalsRunEnabled({})).toBe(true);
});

test('evalsRunEnabled: "off" disables the run', () => {
  expect(evalsRunEnabled({ EVALS_RUNNER: 'off' })).toBe(false);
});

test('evalsRunEnabled: an unrecognised value throws rather than guessing', () => {
  expect(() => evalsRunEnabled({ EVALS_RUNNER: 'sometimes' })).toThrow(/unrecognised EVALS_RUNNER/);
});
