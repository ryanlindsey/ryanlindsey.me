import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS, MCP_WORKER } from './workers';
import {
  CORPUS_CRON,
  EVALS_DAILY_CRON,
  EVALS_USER_AGENT,
  EVALS_WEEKLY_CRON,
  evalsRunEnabled,
  suitesForCron,
} from '../src/lib/evals/plan';
import { readOpsMetrics } from '../src/lib/ops/metrics';
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

beforeAll(async () => {
  await server.listen();
  mcp = server.getWorker<McpEnv>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  env = await mcp.getEnv();
  // Listened here rather than inside the one test that uses it: a harness
  // started in a test body is a harness whose lifetime is not the file's, and
  // the `afterAll` below has to be able to close both.
  await poisonedCorpus.listen();
});

// Both of them, in one block. tests/discovery-link-headers.test.ts is the
// other suite here that boots two harnesses and it writes two `afterAll`s
// instead; either works, and one block is what keeps the pairing with the
// `beforeAll` above visible at a glance.
afterAll(async () => {
  await server.close();
  await poisonedCorpus.close();
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
 *
 * THE 1000 ms ON THE NEGATIVES IS SET AGAINST A MEASURED NUMBER, which the
 * budget itself does not say. The positive control -- a `suites: []` instance,
 * which mints, iterates nothing and revokes -- took 38 ms on 2026-09-18. A
 * second is therefore about twenty-five times the whole round trip this is
 * waiting to NOT see, which is the margin that makes "nothing started" a real
 * reading rather than a race won. It is not free: each negative assertion
 * spends its full second, because a negative never ends early, and there are
 * three of them in this file.
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

test('a real suite runs its case step and its record step under the step configs', async () => {
  // WHY THIS EXISTS: `CASE_STEP` and `RECORD_STEP`
  // (workers/mcp/src/evals-workflow.ts) were added to stop Cloudflare's default
  // five-retry policy from becoming a third retry layer on a path where each
  // extra attempt is another frontier-model call. A `StepConfig` that workerd
  // rejects would fail at the step rather than at the typecheck, and the
  // `suites: []` control above runs no steps at all, so nothing else here
  // would notice.
  //
  // `tier` IS THE ONLY SUITE THIS CAN DRIVE, and it can because it spends
  // nothing: no model call, no `AI` binding, just the handshake, two listings
  // and the no-argument tools over the real `SELF` service binding. The other
  // three would be a run of refusals at seams that are off (see the header).
  await env.EVALS_WORKFLOW.create({ params: { suites: ['tier'] } });

  const row = await until(
    () =>
      env.DB.prepare(
        "SELECT suite, status, total, passed, model FROM eval_runs WHERE suite = 'tier' ORDER BY id DESC",
      ).first<{ suite: string; status: string; total: number; passed: number; model: null }>(),
    (value) => value !== null,
    40_000,
  );

  // DELIBERATELY NOT ASSERTING `passed`. Whether the tier case passes is a fact
  // about what the public tier currently says, and that already has its own
  // tests -- tests/mcp-tools.test.ts and tests/tier-invisibility.test.ts scan
  // the same surfaces against the same patterns. Asserting it here would make
  // this file go red for a reason that has nothing to do with scheduling. What
  // is being asserted is that the run REACHED its row: the case step executed,
  // the record step executed, and `summarize()` wrote a suite that ran with
  // one case in it.
  expect(row?.status).toBe('ran');
  expect(row?.total).toBe(1);
  // `model` is written as an explicit NULL, exactly as evals/run.mjs writes it.
  expect(row?.model).toBeNull();
});

test('the run labels its own calls across the hop, and /ops leaves them out', async () => {
  // WHY THIS EXISTS. F1 changes what a PUBLIC page publishes, and its whole
  // correctness rests on two things holding at once: a `user-agent` set in
  // workers/mcp/src/evals-client.ts surviving a service-binding dispatch into
  // this Worker's own `fetch`, all the way to `mcp_tool_calls.user_agent`, and
  // `readOpsMetrics` keying its exclusion off that stored value. Until this
  // test, neither end was pinned on this path: the header was asserted against
  // an injected stub in tests/evals-client.test.ts, which never crosses a hop,
  // and the SQL was asserted against rows a test had inserted by hand in
  // tests/ops-metrics.test.ts, which never proves anything about what the
  // dispatch actually stores. The only evidence that the two met was a live
  // probe recorded in prose in src/lib/mcp/limits.ts.
  //
  // THE `tier` SUITE IS WHAT MAKES IT CHEAP. It spends no inference and calls
  // every no-required-argument PUBLIC tool over the real `SELF` binding, which
  // is exactly the traffic being excluded, so the rows this reads are the rows
  // the scheduled run really writes.
  //
  // THE CONTROL ROW IS WHAT KEEPS IT HONEST. A filter that dropped every row
  // would pass the exclusion half of this test and be catastrophically wrong,
  // so a row that is NOT the scheduled run has to survive the same query. Its
  // tool name is a fixture rather than a real tool, the same device
  // tests/ops-metrics.test.ts uses with its `bisect` suite, so it cannot
  // collide with whatever the tier suite happens to call.
  const VISITOR_TOOL = 'a_fixture_a_visitor_called';
  await env.DB.prepare(
    `INSERT INTO mcp_tool_calls (called_at, tool, args_hash, tier, audience, user_agent, outcome, duration_ms)
     VALUES (?, ?, 'h', 'public', NULL, 'Mozilla/5.0', 'ok', 11)`,
  )
    .bind(new Date().toISOString(), VISITOR_TOOL)
    .run();

  await env.EVALS_WORKFLOW.create({ params: { suites: ['tier'] } });

  // Polled like every other reading here: `recordToolCall` is handed to
  // `ctx.waitUntil` (workers/mcp/src/define.ts), so the row lands after the
  // response does.
  const labelled = await until(
    () =>
      env.DB.prepare('SELECT tool, tier FROM mcp_tool_calls WHERE user_agent = ?')
        .bind(EVALS_USER_AGENT)
        .all<{ tool: string; tier: string }>(),
    (rows) => rows.results.length > 0,
    20_000,
  );

  // THE HEADER SURVIVED THE HOP. Without this, the exclusion below is a filter
  // on a value nothing ever writes.
  expect(
    labelled.results.length,
    'no mcp_tool_calls row carries the scheduled run user agent',
  ).toBeGreaterThan(0);
  // And they are `public` rows, which is why they were a problem: they are the
  // exact rows /ops publishes, indistinguishable from a visitor's but for the
  // agent.
  for (const stored of labelled.results) expect(stored.tier).toBe('public');

  const metrics = await readOpsMetrics(env.DB, new Date(), 30);
  const published = metrics.toolCalls.map((published) => published.tool);
  for (const stored of labelled.results) {
    expect(published, `${stored.tool} reached /ops from the scheduled run`).not.toContain(
      stored.tool,
    );
  }
  // The control survived, so the query is reading this table and excluding on
  // the agent rather than answering with nothing.
  expect(published, 'the exclusion dropped a row that is not the scheduled run').toContain(
    VISITOR_TOOL,
  );
});

/**
 * The CODE of a TypeScript source, with its comments removed.
 *
 * Both halves are load-bearing for the scan below. Block comments go first
 * because `EvalsWorkflow.run`'s own doc deliberately writes out
 * `step.do('mint', ...)` in order to forbid it -- the same situation
 * tests/candidacy-patterns.ts's `SCAN_EXCEPTIONS` records, where a rule that
 * cannot name what it prohibits cannot be read by the next person to edit it.
 * Counting that sentence as a call site would make this test permanently red
 * against a comment that is doing its job.
 *
 * Whole-line `//` comments go too, which is also what keeps a stray bracket in
 * prose out of the bracket matcher. `https://` mid-line survives, because only
 * a line that STARTS with `//` is dropped.
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * The top-level arguments of the call whose opening `(` sits at `open`.
 *
 * A bracket matcher rather than a regex, because two of the three call sites
 * span several lines and one passes an arrow function whose body contains
 * commas, parentheses and a template literal. Only a comma at depth 1 splits.
 *
 * It fails LOUDLY rather than silently if it ever loses track -- a mismatched
 * bracket yields garbage in `args[1]`, and garbage is not one of the two
 * constant names the test demands. There is no reading of a corrupted scan
 * that passes.
 */
function argumentsAt(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(source.slice(start, index));
        return args;
      }
    } else if (char === ',' && depth === 1) {
      args.push(source.slice(start, index));
      start = index + 1;
    }
  }
  return args;
}

test('every step.do in the workflow carries one of the two step configs', async () => {
  // WHAT THIS PREVENTS, AND WHAT IT COSTS. A `step.do` with no config gets
  // Cloudflare's default retry policy -- five retries, ten seconds apart,
  // exponential backoff. On a case step that is five more `analyze_fit` calls
  // per failure, each an Opus call over the whole corpus, each doing its own
  // `RETRIES = 1` client retry, each of those fanning out at the gateway up to
  // four times. `CASE_STEP` and `RECORD_STEP` in
  // workers/mcp/src/evals-workflow.ts exist to stop that, and its own comment
  // explains the composition.
  //
  // THE HAZARD IS DRIFT, NOT THE CODE AS WRITTEN. The end-to-end `tier` test
  // above proves the two configs this branch wrote are ACCEPTED by workerd; it
  // cannot prove that a fourth `step.do` added later carries one, and an
  // unconfigured step reinstates the whole problem silently, with every other
  // test in this file still green. This repository pins that class of hazard
  // structurally rather than trusting the next edit to remember:
  // tests/mcp-env.test.ts regenerates the binding list, tests/site-crons.test.ts
  // compares two spellings of the cron list, tests/tier-invisibility.test.ts
  // fails on a word appearing in the code of three named files. This is the
  // same shape.
  //
  // THE DIRECTION IT FAILS IN is a call site without a config, which is the one
  // that costs money. It deliberately does NOT count call sites against a
  // number: a count goes stale the first time a step is legitimately added, and
  // a test that has to be edited to add a step is a test that gets edited
  // without being read.
  const code = codeOf(await readFile('workers/mcp/src/evals-workflow.ts', 'utf8'));

  const opens: number[] = [];
  for (const match of code.matchAll(/\bstep\.do\(/g)) {
    opens.push(match.index + match[0].length - 1);
  }
  // The one way this could go green while proving nothing: a pattern that
  // matches no call at all.
  expect(opens.length, 'no step.do call sites found').toBeGreaterThan(0);

  for (const open of opens) {
    const args = argumentsAt(code, open);
    const config = args[1]?.trim();
    // STRICTER THAN "has a second argument", deliberately. Requiring one of the
    // two NAMED constants keeps the reasoning in one place: a step needing a
    // third policy should add a third constant carrying its own argument, not
    // an inline object literal that says what it does and never why.
    expect(
      config,
      `a step.do near "${args[0]?.trim()}" does not pass CASE_STEP or RECORD_STEP`,
    ).toMatch(/^(CASE_STEP|RECORD_STEP)$/);
  }

  // If a second Workflow class is ever added to this Worker, widening this
  // read to every file that defines one is what keeps it honest; today
  // evals-workflow.ts is the only one.
});

/** What `instance.status()` answers with, narrowed to the two fields read here. */
interface InstanceStatus {
  status: string;
  error?: { message?: string } | null;
}

/**
 * The status of the instance `create` returned, once it stops moving.
 *
 * A workflow instance is asynchronous, so the status the moment after `create`
 * is `queued` whatever it is about to do. `errored` and `complete` are the two
 * terminal readings this file distinguishes.
 *
 * IT RETURNS THE ERROR AND NOT ONLY THE STATE, because the state alone cannot
 * tell the two payload tests below apart from the defect they exist to pin: a
 * malformed payload errored the instance BEFORE this change too, on a
 * `TypeError` deep inside the mint's own catch ("suites is not iterable"), and
 * on `summarize` reading `.filter` of undefined for an unknown suite name.
 * Both were measured on 2026-09-18. The improvement is entirely in what the
 * instance says happened, so that is what is asserted.
 */
async function settled(instance: {
  status: () => Promise<InstanceStatus>;
}): Promise<InstanceStatus> {
  const deadline = Date.now() + 20_000;
  let seen = await instance.status();
  while (seen.status !== 'errored' && seen.status !== 'complete' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    seen = await instance.status();
  }
  return seen;
}

test('a payload naming no suite list fails loudly and mints nothing', async () => {
  // NOT REACHABLE WITHOUT ACCOUNT ACCESS, and reachable by exactly the person
  // most likely to be there: `wrangler workflows trigger rlme-evals` with no
  // `--params` is what an operator reaches for after a red Sunday, and it
  // hands `run()` an undefined `suites`.
  //
  // WHAT IT USED TO DO. `suites.join` threw inside the mint's own `try`, and
  // the catch's `for (const suite of suites)` threw again on the same
  // undefined -- so the instance errored on a `TypeError` about a property of
  // undefined, having recorded nothing and said nothing an operator could act
  // on. What it does now is refuse before the mint, naming what arrived.
  const before = await tokenRows();
  const instance = await env.EVALS_WORKFLOW.create({
    params: {} as unknown as { suites: never[] },
  });
  const seen = await settled(instance);
  expect(seen.status).toBe('errored');
  expect(seen.error?.message, 'the instance errored without naming the payload').toContain(
    'no suite list',
  );
  // NOTHING MINTED. The refusal is ahead of the mint deliberately: a run that
  // cannot say what it is running has no reason to sign a credential first.
  expect(await tokenRows()).toBe(before);
});

test('an unrecognized suite name is refused and writes no row under that name', async () => {
  // THE SECOND HALF OF THE SAME PAYLOAD BUG. An unknown name fell through
  // `runSuite`'s switch, which returned `undefined`, and `summarize` then threw
  // on `results.filter` OUTSIDE the per-suite catch -- taking down the whole
  // run, including suites that had already produced results.
  //
  // AND NO ROW UNDER THE UNKNOWN NAME, which is the part worth asserting
  // rather than assuming. `eval_runs.suite` is TEXT and /ops renders the latest
  // row per suite on a PUBLIC page, so recording an `incomplete` row for a
  // mistyped name would publish "chatt -- did not run" under a heading reading
  // "Latest run per suite", permanently, with nothing that ever writes to that
  // suite again to displace it.
  const instance = await env.EVALS_WORKFLOW.create({
    params: { suites: ['chatt'] } as unknown as { suites: never[] },
  });
  const seen = await settled(instance);
  expect(seen.status).toBe('errored');
  expect(seen.error?.message, 'the instance errored without naming the suite').toContain('chatt');

  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM eval_runs WHERE suite = ?')
    .bind('chatt')
    .first<{ n: number }>();
  expect(row?.n).toBe(0);
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

test('the corpus refresh runs for its own cron, and for no other', async () => {
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
