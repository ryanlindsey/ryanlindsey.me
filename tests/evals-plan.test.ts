import { expect, test } from 'vitest';
import {
  BACKOFF_MS,
  CORPUS_CRON,
  EVALS_DAILY_CRON,
  EVALS_WEEKLY_CRON,
  PACE_MS,
  RETRIES,
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

test('suitesForCron: the daily expression asks for tier alone', () => {
  expect(suitesForCron(EVALS_DAILY_CRON)).toEqual(['tier']);
});

test('suitesForCron: the weekly expression asks for fit, chat, leak, with leak last', () => {
  const suites = suitesForCron(EVALS_WEEKLY_CRON);
  expect(suites).toEqual(['fit', 'chat', 'leak']);
  expect(suites.at(-1)).toBe('leak');
});

test('suitesForCron: the corpus cron asks for no eval suite', () => {
  expect(suitesForCron(CORPUS_CRON)).toEqual([]);
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
