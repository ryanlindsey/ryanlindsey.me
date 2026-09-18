import { readFile } from 'node:fs/promises';
import { beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS, MCP_WORKER } from './workers';
import {
  CORPUS_CRON,
  EVALS_DAILY_CRON,
  EVALS_WEEKLY_CRON,
  evalsRunEnabled,
  suitesForCron,
} from '../src/lib/evals/plan';
import type { McpEnv } from '../workers/mcp/src/env';

/**
 * The MCP Worker's scheduled dispatch (issue #291, task 4): which cron starts
 * an evals run, which one does not, and the seam that stops one here.
 *
 * WHAT THIS CAN AND CANNOT OBSERVE, said first because the assertions below
 * look thinner than they are. A workflow instance leaves exactly one trace
 * this harness can read: `EvalsWorkflow.run` mints a scoped token before it
 * touches a step, so an instance that started writes an `access_tokens` row
 * with the audience `scheduled-evals` whatever the suites then do. That row is
 * the fingerprint, and the first test below is the positive control that
 * proves the fingerprint is visible at all -- without it, every "no instance
 * started" assertion here would pass just as readily against a binding that
 * does nothing.
 *
 * The suites themselves cannot run here and are not meant to: `AI` is
 * overridden to a service Worker, so `env.AI.run()` is a TypeError, and
 * `CHAT_ENGINE`, `FIT_ENGINE` and `JUDGE_ENGINE` are all `'off'` besides. The
 * scheduled run is turned off by `EVALS_RUNNER: 'off'` in tests/workers.ts for
 * that reason and one more: it spends frontier-model calls through AI Gateway.
 */

const server = createTestHarness({ workers: MCP_HARNESS_WORKERS });
let env: McpEnv;
let mcp: ReturnType<typeof server.getWorker<McpEnv>>;

/** The audience the scheduled runner mints under. Generic, and deliberately so. */
const AUDIENCE = 'scheduled-evals';

beforeAll(async () => {
  await server.listen();
  mcp = server.getWorker<McpEnv>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  env = await mcp.getEnv();
});

async function tokenRows(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM access_tokens WHERE audience = ?')
    .bind(AUDIENCE)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** When the newest scheduled-evals token was revoked, or `null` for none and for one still live. */
async function latestRevokedAt(): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT revoked_at AS revokedAt FROM access_tokens WHERE audience = ? ORDER BY issued_at DESC',
  )
    .bind(AUDIENCE)
    .first<{ revokedAt: string | null }>();
  return row?.revokedAt ?? null;
}

/**
 * Polls `read` until `done` accepts a reading or the deadline passes, and
 * returns whatever it last read.
 *
 * EVERY ASSERTION BELOW GOES THROUGH THIS, including the negative ones. A
 * workflow instance starts asynchronously, so a bare read taken the moment
 * `scheduled()` returns would report "no instance" for a run that was merely a
 * few milliseconds behind -- which is the one way an assertion here could be
 * green and worthless. A positive reading ends the wait immediately; a
 * negative one costs the whole timeout, which is why the negatives get a short
 * one and the control gets a generous one.
 */
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

test('the positive control: an instance that runs leaves a token row behind', async () => {
  // `suites: []` asks for no suite at all, so `run()` mints, iterates nothing
  // and revokes -- the cheapest possible instance, and the only one this
  // harness could complete. It spends nothing: no model call, no step.
  const before = await tokenRows();
  await env.EVALS_WORKFLOW.create({ params: { suites: [] } });
  expect(await until(tokenRows, (seen) => seen > before, 20_000)).toBe(before + 1);

  // And the `finally` ran: the token a run mints does not outlive it. This is
  // the second half of the mint decision recorded in
  // workers/mcp/src/evals-workflow.ts -- the bearer is never persisted into a
  // step's durable state, and it is revoked the moment the run is over, so the
  // only thing left bounding it is an instance that dies between the two.
  const revokedAt = await until(latestRevokedAt, (value) => value !== null, 20_000);
  expect(revokedAt, 'the run did not revoke the token it minted').not.toBeNull();
});

test('the corpus cron starts no evals instance', async () => {
  const before = await tokenRows();
  await mcp.scheduled({ cron: CORPUS_CRON, scheduledTime: new Date() });
  expect(await until(tokenRows, (seen) => seen > before, 1000)).toBe(before);
});

test.each([EVALS_DAILY_CRON, EVALS_WEEKLY_CRON])(
  'the evals cron %s starts no instance while EVALS_RUNNER is off',
  async (cron) => {
    const before = await tokenRows();
    await mcp.scheduled({ cron, scheduledTime: new Date() });
    expect(await until(tokenRows, (seen) => seen > before, 1000)).toBe(before);
  },
);

test('the harness sets the seam, and it reads as off', () => {
  // The pure contract of `evalsRunEnabled` -- absent runs, `'off'` does not,
  // anything else throws -- is owned by tests/evals-plan.test.ts and is not
  // repeated here. What that file cannot see is whether the harness actually
  // sets the var, which is the only thing standing between `npm test` and a
  // scheduled run that spends money.
  expect(MCP_WORKER.vars.EVALS_RUNNER).toBe('off');
  expect(evalsRunEnabled(MCP_WORKER.vars)).toBe(false);
});

/**
 * A SECOND HARNESS, WITH THE CORPUS SEAM POISONED, and it exists to observe
 * the one thing the harness above cannot.
 *
 * WHAT NEEDS OBSERVING. Until issue #291 this Worker's `scheduled()` ran the
 * corpus refresh for EVERY trigger, because there was only one. It now runs it
 * for `CORPUS_CRON` and for nothing else, and that is a change to an existing
 * path rather than a new one -- an evals cron that still re-embedded the whole
 * corpus would be two extra full refreshes a week, silently, with every other
 * assertion in this file still green.
 *
 * WHY IT TAKES A POISONED VALUE. `CORPUS_REFRESH: 'off'` (tests/workers.ts)
 * makes the refresh skip, so under the ordinary harness "the branch was
 * entered and skipped" and "the branch was never entered" are the same
 * observation. An UNRECOGNISED value is different: `corpusRefreshEnabled`
 * (src/lib/corpus.ts) throws on one -- that is the seam's third documented
 * safety property -- and a `scheduled()` handler that throws answers
 * `outcome: 'exception'` instead of `'ok'`. So the exception IS the proof that
 * control reached the corpus branch, and its absence is the proof that it did
 * not.
 *
 * MEASURED 2026-09-18, both readings: the corpus cron answers
 * `{"outcome":"exception","noRetry":false}` and the daily evals cron answers
 * `{"outcome":"ok","noRetry":false}`.
 */
const poisonedCorpus = createTestHarness({
  workers: MCP_HARNESS_WORKERS.map((worker) =>
    worker === MCP_WORKER
      ? { ...MCP_WORKER, vars: { ...MCP_WORKER.vars, CORPUS_REFRESH: 'not-a-value-it-accepts' } }
      : worker,
  ),
});

test('the corpus refresh runs for its own cron, and for no other', async () => {
  await poisonedCorpus.listen();
  const worker = poisonedCorpus.getWorker<McpEnv>('ryanlindsey-me-mcp');

  const corpus = await worker.scheduled({ cron: CORPUS_CRON, scheduledTime: new Date() });
  expect(corpus.outcome, 'the corpus cron did not reach the corpus branch').toBe('exception');

  for (const cron of [EVALS_DAILY_CRON, EVALS_WEEKLY_CRON]) {
    const evals = await worker.scheduled({ cron, scheduledTime: new Date() });
    expect(evals.outcome, `${cron} reached the corpus branch`).toBe('ok');
  }
});

/**
 * Drops whole-line `//` comments before the config is matched, exactly as
 * tests/site-crons.test.ts does and for the same reason: a cron expression
 * quoted in a comment must not read as a declaration.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

test('every MCP cron trigger has a job, and every job has a trigger', async () => {
  const config = withoutComments(await readFile('workers/mcp/wrangler.jsonc', 'utf8'));
  const crons = /"crons"\s*:\s*\[([^\]]*)\]/.exec(config);
  expect(crons, 'workers/mcp/wrangler.jsonc declares no `triggers.crons`').not.toBeNull();
  const declared = [...crons![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  expect(declared.length, 'no cron expressions parsed out of the config').toBeGreaterThan(0);

  // The three constants in src/lib/evals/plan.ts are the other spelling of
  // this list, and `suitesForCron` is the mapping that reads it. Drift either
  // way is a cron that fires with nothing registered for it, or a job whose
  // trigger was never declared -- the same pair tests/site-crons.test.ts pins
  // for the site Worker.
  expect([...declared].sort()).toEqual([CORPUS_CRON, EVALS_DAILY_CRON, EVALS_WEEKLY_CRON].sort());

  // And the mapping agrees about which of them is not an evals trigger.
  expect(suitesForCron(CORPUS_CRON)).toEqual([]);
  for (const cron of declared.filter((expression) => expression !== CORPUS_CRON)) {
    expect(suitesForCron(cron).length, `${cron} asks for no suite`).toBeGreaterThan(0);
  }
});
