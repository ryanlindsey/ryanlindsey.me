import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { BUNDLED_CASES } from '../workers/mcp/src/evals-cases';
import { SUITE_ORDER } from '../src/lib/evals/plan';

/**
 * The bundle drift test (issue #291, task 4), and the shape is
 * tests/mcp-env.test.ts's: one fact spelled in two places, checked from both
 * ends, failing whichever way it drifts.
 *
 * WHAT IT IS FOR. `evals/run.mjs` LOADS its cases at run time with
 * `readdirSync`, so a new file under `evals/cases/<suite>/` joins the manual
 * run the moment it is committed. The MCP Worker cannot read a directory:
 * `workers/mcp/src/evals-cases.ts` names every case file in a static import,
 * because that is what makes the JSON part of the deployed bundle at all. So
 * the two runners agree only while somebody remembers to add the import, and
 * the failure of forgetting is silent and flattering -- the scheduled suite
 * is simply SMALLER than the one a person runs by hand, every case in it
 * still passes, and the `eval_runs` row says green with a total nobody reads.
 * This is what makes that a red pull request instead.
 *
 * It reads the directory the way the manual runner does rather than trusting
 * a second list, which is why a file added and never bundled fails here.
 */

const CASES = new URL('../evals/cases/', import.meta.url).pathname;

/**
 * The committed case ids in one suite, off disk. `*.local.json` is dropped for
 * the same reason `evals-cases.ts` cannot import one: it is gitignored, so it
 * does not exist at build time and is not a case the scheduled runner can
 * ever see.
 */
function idsOnDisk(suite: string): string[] {
  return readdirSync(join(CASES, suite))
    .filter((name) => name.endsWith('.json') && !name.endsWith('.local.json'))
    .map((name) => JSON.parse(readFileSync(join(CASES, suite, name), 'utf8')).id as string)
    .sort();
}

test.each([...SUITE_ORDER])('every committed %s case is bundled, and no other', (suite) => {
  const bundled = BUNDLED_CASES[suite].map((testCase) => testCase.id).sort();
  expect(bundled).toEqual(idsOnDisk(suite));
});

test('the directory listing found cases at all', () => {
  // The one way the equality above could go green while proving nothing: a
  // path that resolves nowhere makes both sides empty.
  expect(SUITE_ORDER.flatMap((suite) => idsOnDisk(suite)).length).toBeGreaterThan(0);
});

test('every bundled case is marked not-local, structurally rather than by convention', () => {
  // `*.local.json` is gitignored, so there is no such file at build time and
  // `evals-cases.ts` holds no reference to one. The scheduled path therefore
  // cannot leak a local case's id or its model-derived failure text into the
  // remote `eval_runs` row -- it has nothing to redact, which is the stronger
  // form of the redaction `redactedNotes` applies at the row.
  const every: { id: string; local: boolean }[] = [
    ...BUNDLED_CASES.tier,
    ...BUNDLED_CASES.fit,
    ...BUNDLED_CASES.chat,
    ...BUNDLED_CASES.leak,
  ];
  expect(every.filter((testCase) => testCase.local).map((testCase) => testCase.id)).toEqual([]);
});

test('the leak suite bundles the questions each probe runs', () => {
  // The leak suite is the one whose cases are not one-to-one with results:
  // every question in a file is its own probe and its own row. A file that
  // arrived with no `questions` array would silently contribute nothing.
  for (const testCase of BUNDLED_CASES.leak) {
    expect(testCase.questions.length, `${testCase.id} carries no questions`).toBeGreaterThan(0);
  }
});
