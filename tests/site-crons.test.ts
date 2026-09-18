import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

/**
 * The site Worker's cron-drift pin, and the counterpart to
 * tests/site-env.test.ts's binding pin: one fact spelled in two files, checked
 * from both ends. Every expression in wrangler.jsonc's `triggers.crons` must
 * have a `case` in src/worker.ts's `scheduled()` switch, and every `case` must
 * have an expression. Drift in either direction fails.
 *
 * WHY THIS EXISTS ALONGSIDE THE `default` ARM RATHER THAN INSTEAD OF IT. That
 * arm logs when a trigger fires with no job registered, and it stays -- but it
 * reports at the moment the cron runs, into logs nobody is watching, after a
 * deploy that was green. This reports on the pull request that causes it.
 * #233 is what made the difference worth a test: until then a mismatch cost a
 * background retention sweep that fails quietly, and it now also costs the
 * campaign hero band, a visitor-facing surface that renders for nobody if the
 * index is never written.
 *
 * SOURCE-LEVEL, FOLLOWING tests/mcp-env.test.ts's SHAPE, which keeps `McpEnv`
 * in step with the MCP Worker's config the same way. What is under test is
 * whether two files agree, so this reads both files and boots nothing: no
 * harness, no Worker, no credential.
 *
 * THE MCP WORKER IS COVERED ELSEWHERE, and this paragraph used to say it was
 * not covered at all. What it said was true when written: that Worker's
 * `scheduled()` had one trigger and one job, never read `controller.cron`, and
 * so had no second spelling to drift from -- "the day it gains a second
 * trigger is the day it needs this". Issue #291 was that day. It now has three
 * crons and branches on all of them, and tests/evals-schedule.test.ts pins the
 * pair from both ends the way this file does, against the constants in
 * src/lib/evals/plan.ts rather than against a `case` list.
 */

/**
 * Drops whole-line `//` comments before the config is matched. This file
 * carries more comment than config, and the comment above `triggers` discusses
 * two crons it does not declare -- 05:17's deleted résumé refresh and the MCP
 * Worker's 05:32 -- so an expression quoted among them is a plausible edit
 * away, and it must not read as a declaration when it lands.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

test('every site cron trigger has a `scheduled()` case, and every case has a trigger', async () => {
  const config = withoutComments(await readFile('wrangler.jsonc', 'utf8'));
  const crons = /"crons"\s*:\s*\[([^\]]*)\]/.exec(config);
  expect(crons, 'wrangler.jsonc declares no `triggers.crons`').not.toBeNull();
  const declared = [...crons![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  // A regex that matched nothing would make the comparison below pass against
  // an empty switch, which is the one way this test could go green while
  // proving nothing.
  expect(declared.length, 'no cron expressions parsed out of wrangler.jsonc').toBeGreaterThan(0);

  const worker = await readFile('src/worker.ts', 'utf8');
  const switchAt = worker.indexOf('switch (controller.cron)');
  expect(switchAt, 'src/worker.ts has no `switch (controller.cron)`').toBeGreaterThan(-1);
  const body = worker.slice(switchAt);
  const defaultAt = body.indexOf('default:');
  expect(defaultAt, 'the cron switch has no `default` arm').toBeGreaterThan(-1);
  const handled = [...body.slice(0, defaultAt).matchAll(/case '([^']+)':/g)].map(
    (match) => match[1]!,
  );

  // Sorted rather than positional: which order the array and the arms are
  // written in is not a fact anyone should have to keep in step.
  expect(handled.sort()).toEqual([...declared].sort());
});
