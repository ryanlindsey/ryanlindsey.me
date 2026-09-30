import { expect, test, vi } from 'vitest';
import {
  CACHE_TTL_SECONDS,
  formatCount,
  OPS_CACHE_KEYS,
  publicToolCalls,
  readOpsReads,
  readOrNull,
  WINDOW_DAYS,
} from '../src/lib/ops/reads';
import type { OpsMetrics } from '../src/lib/ops/metrics';

/**
 * The /ops reads, moved out of the page so a second reader can share them.
 *
 * No harness: tests/ops-page.test.ts already proves the page renders the same
 * figures through these functions, and what is left to pin here is the
 * contract a second reader depends on, the keys, the window and the TTL.
 */

const metrics: OpsMetrics = {
  windowDays: 30,
  toolCalls: [],
  chatSessions: 0,
  chatTurns: 0,
  fitRuns: { started: 0, reports: 0, failed: 0, inProgress: 0, abandoned: 0 },
  evalRuns: [],
};

test('the cache keys, the TTL and the window are the ones the page has always used', () => {
  expect(OPS_CACHE_KEYS).toEqual({
    metrics: 'ops:metrics:v5',
    traffic: 'ops:traffic:v2',
    spend: 'ops:spend:v2',
    failures: 'ops:failures:v1',
  });
  expect(CACHE_TTL_SECONDS).toBe(60);
  expect(WINDOW_DAYS).toBe(30);
});

test('publicToolCalls sums the public tool rows', () => {
  expect(
    publicToolCalls({
      ...metrics,
      toolCalls: [
        { tool: 'a', calls: 2 },
        { tool: 'b', calls: 3 },
      ],
    }),
  ).toBe(5);
  expect(publicToolCalls({ ...metrics, toolCalls: [] })).toBe(0);
});

test('formatCount adds en-US separators and passes an absent figure through', () => {
  expect(formatCount(4242)).toBe('4,242');
  expect(formatCount(0)).toBe('0');
  expect(formatCount(null)).toBeNull();
  expect(formatCount(undefined)).toBeNull();
});

test('readOrNull degrades a rejected read to null and writes nothing', async () => {
  const get = vi.fn(async () => null);
  const put = vi.fn(async () => undefined);
  const kv = { get, put } as unknown as KVNamespace;
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  try {
    await expect(
      readOrNull(kv, 'ops:test', () => Promise.reject(new Error('D1 is down'))),
    ).resolves.toBeNull();
    expect(put).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('ops: ops:test could not be read', expect.any(Error));
  } finally {
    error.mockRestore();
  }
});

test('a rejected failure read leaves failures null and the metrics returned', async () => {
  // A fake D1 whose only failing statement is the one naming `failure_reason`,
  // which is what an unmigrated database does. Empty results are enough for
  // readOpsMetrics, which defaults every figure to zero.
  const db = {
    prepare: (sql: string) => {
      const statement = { sql, bind: () => statement };
      return statement;
    },
    batch: async (statements: { sql: string }[]) => {
      if (statements.some((s) => s.sql.includes('failure_reason'))) {
        throw new Error('no such column: failure_reason');
      }
      return statements.map(() => ({ results: [] }));
    },
  } as unknown as D1Database;
  const kv = { get: async () => null, put: async () => undefined } as unknown as KVNamespace;
  const env = {
    DB: db,
    KV_CACHE: kv,
    RLME_ANALYTICS_MODE: 'stub',
    RLME_ANALYTICS_TOKEN: { get: async () => null },
    RLME_ACCOUNT_ID: 'a',
    RLME_AI_GATEWAY_ID: 'g',
  } as unknown as Parameters<typeof readOpsReads>[0];
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const reads = await readOpsReads(env, new Date('2026-09-09T12:00:00.000Z'));
    expect(reads.failures).toBeNull();
    expect(reads.metrics).not.toBeNull();
    expect(reads.metrics?.chatTurns).toBe(0);
  } finally {
    error.mockRestore();
  }
});
