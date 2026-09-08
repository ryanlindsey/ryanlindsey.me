import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import type { LimitsEnv } from '../src/lib/mcp/limits';
import { MCP_WORKER, MOCK_AI_WORKER } from './workers';

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
const server = createTestHarness({ workers: [MCP_WORKER, MOCK_AI_WORKER] });

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
 * The numbers are chosen so the wait is short and the margin is wide: a
 * capacity of 1 refilling at 100/second needs 10ms to recover one token, and
 * the test waits 150ms. A refill rate this test could plausibly race is a
 * refill rate the assertion would not be measuring.
 */
test('refills the bucket over time', async () => {
  const stub = (await limiter()).getByName('refill-test');

  expect((await stub.consume(1, 100)).success).toBe(true);
  expect((await stub.consume(1, 100)).success).toBe(false);

  await new Promise((resolve) => setTimeout(resolve, 150));

  expect((await stub.consume(1, 100)).success).toBe(true);
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
