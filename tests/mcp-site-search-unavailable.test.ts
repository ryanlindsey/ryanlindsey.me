import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS, MCP_WORKER } from './workers';
import { searchCacheKey } from '../src/lib/search/engine';
import type { McpEnv } from '../workers/mcp/src/env';

/**
 * `GET /search` when retrieval fails, which is the one branch the ordinary
 * suite cannot reach.
 *
 * A SECOND HARNESS, AND THE REASON IS THE SEAM ITSELF. tests/workers.ts sets
 * `SEARCH_ENGINE: 'stub'` on the MCP Worker, so every test in
 * tests/mcp-site-search.test.ts answers from the fixture and the binding is
 * never touched. Dropping that one var here makes `searchEngineMode` return
 * `'live'` and the handler call `env.AI_SEARCH.search()` for real -- and
 * `AI_SEARCH` is still overridden to workers/mock-ai, a Worker that does not
 * implement the method, so the RPC rejects at the await. #144 measured exactly
 * that rejection.
 *
 * WHICH MAKES THIS THE REAL FAILURE, not a simulated one. The production
 * shapes this stands in for are an instance that is paused or mid-reindex, a
 * validation error such as AI Search's `7070`, and an exhausted quota. All of
 * them arrive here the same way: the promise rejects and the handler has to
 * answer something a page can render.
 *
 * Its own file rather than a second harness inside the first, because
 * `createTestHarness` is per module and the two configurations differ by one
 * var that decides every assertion in both.
 */
const { SEARCH_ENGINE: _stubbed, ...liveVars } = MCP_WORKER.vars;

const server = createTestHarness({
  workers: [
    { ...MCP_WORKER, vars: liveVars },
    ...MCP_HARNESS_WORKERS.filter((worker) => worker !== MCP_WORKER),
  ],
});
let env: McpEnv;

beforeAll(async () => {
  await server.listen();
  env = await server.getWorker<McpEnv>('ryanlindsey-me-mcp').getEnv();
});

afterAll(async () => {
  await server.close();
});

const search = (query: string) =>
  server.getWorker('ryanlindsey-me-mcp').fetch(`/search?q=${query}`, {
    headers: { 'cf-connecting-ip': '198.51.100.201' },
  });

describe('GET /search when the index cannot answer', () => {
  test('the seam is genuinely off, so the binding is genuinely reached', () => {
    expect(env.SEARCH_ENGINE).toBeUndefined();
  });

  test('a retrieval failure is a 503 with a sentence, never a 500', async () => {
    const response = await search('unavailable-probe');
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('unavailable');
    expect(body.message.length).toBeGreaterThan(0);
  });

  test('a failure is not cached, so the next request tries again', async () => {
    // The whole of review finding 1. `retrieval.return_on_failure` defaults to
    // TRUE, which turns an index-side failure into an empty result set rather
    // than a throw -- and an empty result set cached for 24 hours is a query
    // that answers "nothing found" for a day, spending nothing and logging
    // nothing unusual. src/lib/ops/cache.ts's own comment is explicit that a
    // failed read must never be stored, for exactly this reason.
    await search('uncached-failure-probe');
    const stored = await env.KV_CACHE.get(await searchCacheKey('uncached-failure-probe'), 'json');
    expect(stored).toBeNull();
  });
});
