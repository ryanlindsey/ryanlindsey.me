import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { LIMITS, GLOBAL_LIMITS, retryHint, type LimitsEnv } from '../src/lib/mcp/limits';
import { MCP_WORKER, MOCK_AI_WORKER, MOCK_BROWSER_WORKER, SITE_WORKER } from './workers';

/**
 * The rate limiter's own guarantee, tested against the object that carries it
 * rather than through a tool call.
 *
 * This file exists because of #29. Until then the limiter was Cloudflare's
 * `ratelimits` binding, and the only tests it had were the three
 * burst-a-tool-and-count-refusals tests in tests/mcp-tools.test.ts. Those pass
 * under Miniflare's simulation -- which always enforces -- and passed for the
 * whole time production was enforcing nothing at all. The tests were not
 * wrong; they were testing the wiring, and the wiring was fine. What had no
 * test was the PROPERTY: that N calls on one key yield at most `capacity`
 * successes.
 *
 * So the property is tested here, directly, on a Durable Object whose
 * behaviour is the same locally and in production because it is the same
 * single-threaded object either way. See src/lib/mcp/limits.ts for why the
 * binding could not be that object.
 */
/**
 * The site Worker and its own mock-browser dependency are booted here even
 * though nothing in this file reads a document, and that is not defensive
 * padding -- it is a hard requirement of the harness the moment #28's fix
 * lands alongside this one. That change gives the MCP Worker a `SITE` service
 * binding naming `ryanlindsey-me`, and workerd refuses to START a Worker whose
 * service binding names a service the harness has not defined:
 *
 *   Worker "core:user:ryanlindsey-me-mcp"'s binding "SITE" refers to a service
 *   "core:user:ryanlindsey-me", but no such service is defined.
 *
 * MEASURED 2026-09-07 by merging the two branches and running this suite: it
 * is a runtime start-up failure of the whole file, not a failed assertion, so
 * it takes every test here down at once. Listing them is correct with or
 * without that binding present -- an unused Worker in the list only costs a
 * boot -- which is what keeps this file independent of the order the two
 * fixes merge in. MOCK_BROWSER_WORKER comes along because `SITE_WORKER`'s
 * `bindingOverrides` names it.
 *
 * The MCP Worker stays first so it remains the primary one, though this suite
 * does not rely on that: it reaches its Worker by name below.
 */
const server = createTestHarness({
  workers: [MCP_WORKER, SITE_WORKER, MOCK_BROWSER_WORKER, MOCK_AI_WORKER],
});

beforeAll(async () => {
  await server.listen();
});
afterAll(async () => {
  await server.close();
});

async function limiter() {
  return (await server.getWorker<LimitsEnv>('ryanlindsey-me-mcp').getEnv()).RATE_LIMITER;
}

/**
 * A bucket with NO refill, which is what makes this deterministic: with
 * `refillPerSecond: 0` the bucket starts full and never recovers, so the
 * boundary is exactly `capacity` and no wall-clock reading can move it. Every
 * other test in this file that needs time says so explicitly.
 *
 * This is the assertion the old binding could not have passed in production
 * and did not have to pass anywhere: 140 calls, 3 allowed.
 */
test('allows exactly the bucket capacity on one key, then refuses', async () => {
  const stub = (await limiter()).getByName('capacity-test');

  const outcomes: boolean[] = [];
  for (let i = 0; i < 6; i++) outcomes.push((await stub.consume(3, 0)).success);

  expect(outcomes).toEqual([true, true, true, false, false, false]);
});

/**
 * THE ONE THAT MATTERS, and the closest thing this suite has to #29's repro.
 *
 * The issue's evidence was 140 PARALLEL requests completing in a second with
 * zero refusals, and the binding's documented excuse for that shape is
 * genuine: its counters are cached per machine and reconciled asynchronously,
 * so a burst can outrun them. A Durable Object has no such excuse, because
 * concurrency is not something it tolerates -- every call for one key reaches
 * one single-threaded object, so twenty simultaneous calls are twenty
 * sequential ones with the same arithmetic.
 *
 * Sent as one `Promise.all` rather than a loop, deliberately: an `await` per
 * call would serialise them in the TEST and prove nothing about concurrency.
 * `refillPerSecond: 0` again, so the expected count is exact rather than a
 * range that depends on how long the burst took.
 */
test('allows no more than the capacity when the whole burst arrives at once', async () => {
  const stub = (await limiter()).getByName('parallel-test');

  const outcomes = await Promise.all(Array.from({ length: 20 }, () => stub.consume(5, 0)));

  expect(outcomes.filter((o) => o.success)).toHaveLength(5);
});

/**
 * One object per key, which is what stops one client -- or one tool --
 * exhausting the limit for everybody. `limitKeyFor` builds these names as
 * `<tool>:<ip>`, so this is the property behind both "a client that exhausts
 * search_writing can still read a case study" and "one caller cannot starve
 * the endpoint".
 */
test('keeps a separate bucket per key', async () => {
  const namespace = await limiter();
  const exhausted = namespace.getByName('key-a');
  for (let i = 0; i < 3; i++) await exhausted.consume(2, 0);

  expect((await exhausted.consume(2, 0)).success).toBe(false);
  expect((await namespace.getByName('key-b').consume(2, 0)).success).toBe(true);
});

/**
 * Tokens come back over time rather than all at once on a window tick, which
 * is the property that lets a refused client recover without waiting out a
 * whole period -- and the reason the tool tests no longer need the
 * `2 * limit + 1` fudge that a fixed, wall-clock-aligned window forced on them.
 *
 * THE REFILL RATE IS SLOW ON PURPOSE, and the first version of this test got
 * that backwards. It used `refillPerSecond: 100` against a capacity of 1,
 * reasoning that a 10ms recovery let the test wait a comfortable 150ms. The
 * wait was comfortable; the REFUSAL was not. A bucket that recovers a full
 * token in 10ms is empty for 10ms, so the second call had to complete its RPC
 * round trip inside that window or find the bucket full again -- and the
 * assertion that it would be refused was really an assertion about how fast
 * the harness is.
 *
 * MEASURED 2026-09-08 on CI run 34238740033, which failed here with `expected
 * true to be false`: the sibling capacity test spent 362ms on 6 consume calls,
 * so a round trip on that runner is ~60ms against a 10ms window -- not a race
 * it could lose, a race it could not win. Locally the first call took 9ms of
 * the 10ms, which is why it passed here and only here. Reproduced on this
 * machine by putting a 15ms sleep between the two calls: `true`, the CI
 * failure exactly.
 *
 * So both margins are stated in the same unit now, and both are wide. At
 * `refillPerSecond: 2` one token takes 500ms, which is the budget the second
 * call has to arrive within -- ~8x the round trip CI just measured. Recovery
 * needs at most that same 500ms, and the test waits 1000ms. Neither number is
 * near anything this suite has been observed to do.
 */
test('refills the bucket over time', async () => {
  const stub = (await limiter()).getByName('refill-test');

  expect((await stub.consume(1, 2)).success).toBe(true);
  expect((await stub.consume(1, 2)).success).toBe(false);

  await new Promise((resolve) => setTimeout(resolve, 1000));

  expect((await stub.consume(1, 2)).success).toBe(true);
});

/**
 * The feature-wide cap (04 §1's daily global cap) is a bucket like any other,
 * and the only thing that makes it global is its NAME being a constant. This
 * pins the property that follows from that and is easy to lose: `global:chat`
 * and a per-caller `chat:<ip>` bucket are different objects, so exhausting the
 * day's allowance must not refuse a caller who has spent nothing, and a single
 * enthusiastic caller must not drain the day.
 *
 * Named directly rather than through `checkGlobalLimit`, for the reason the
 * closing note below gives about every other test here: the harness sets no
 * `CF-Connecting-IP`, so routing this through the real helpers would compare
 * `global:chat` against `chat:unknown` and prove less than it appears to.
 */
test('the global chat cap is a different bucket from any per-caller one', async () => {
  const namespace = await limiter();
  const global = namespace.getByName('global:chat');
  for (let i = 0; i < 3; i++) await global.consume(2, 0);

  expect((await global.consume(2, 0)).success).toBe(false);
  expect((await namespace.getByName('chat:203.0.113.7').consume(2, 0)).success).toBe(true);
});

/**
 * The cost table itself, pinned whole.
 *
 * Pure -- no harness, no Durable Object. It is here rather than in a file of
 * its own because these four numbers are the ones every test above is really
 * about, and a table that can be edited without a single assertion moving is a
 * table that will be.
 */
test('every cost class states the allowance the code and the docs both quote', () => {
  expect(LIMITS).toEqual({
    cheap: { limit: 60, periodSeconds: 60 },
    inference: { limit: 10, periodSeconds: 60 },
    expensive: { limit: 6, periodSeconds: 300 },
    conversation: { limit: 30, periodSeconds: 300 },
  });
  expect(GLOBAL_LIMITS).toEqual({ chat: { limit: 500, periodSeconds: 86_400 } });
});

/**
 * `retryHint` is derived from `LIMITS`, so this is the arithmetic rather than a
 * second copy of the numbers -- 300/12 is 25. Day 6 added `conversation`, and
 * the hint it produces is what a refused chat message tells its reader.
 */
test('the retry hint is one token of wait, per cost class', () => {
  expect(retryHint('cheap')).toBe('1 second');
  expect(retryHint('inference')).toBe('6 seconds');
  expect(retryHint('expensive')).toBe('50 seconds');
  expect(retryHint('conversation')).toBe('10 seconds');
});

/**
 * WHAT THIS FILE STILL CANNOT PROVE, written down rather than implied.
 *
 * These tests run against Miniflare's Durable Objects, which -- unlike its
 * rate-limiting simulation -- is the same workerd implementation that runs in
 * production, so the arithmetic above is the deployed arithmetic. What they do
 * not exercise is the EDGE: that `CF-Connecting-IP` is present on the request
 * this Worker receives, and that it survives the site Worker's
 * `env.MCP.fetch(request)` hop from https://ryanlindsey.me/mcp. The harness
 * sets no such header, so every key here would be `<tool>:unknown` if it were
 * read from a request at all, and these tests name their keys directly to
 * avoid pretending otherwise.
 *
 * The evidence that stands today is a live probe recorded in `limitKeyFor`'s
 * own comment: a `User-Agent` sent to the apex origin arrived intact in
 * `mcp_tool_calls.user_agent`, and that column is read from the same
 * `tc.request` the key is read from. That proves the request survives the hop
 * with the caller's headers on it. It does not prove the EDGE-ADDED
 * `CF-Connecting-IP` specifically does. After the deploy that ships this, the
 * check is one differential probe: exhaust one tool from one client and
 * confirm a second client is still served -- which is only a meaningful probe
 * now that exhausting is possible at all.
 */
