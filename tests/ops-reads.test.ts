import { expect, test, vi } from 'vitest';
import {
  CACHE_TTL_SECONDS,
  formatCount,
  OPS_CACHE_KEYS,
  publicToolCalls,
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
    metrics: 'ops:metrics:v4',
    traffic: 'ops:traffic:v1',
    spend: 'ops:spend:v1',
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

  await expect(
    readOrNull(kv, 'ops:test', () => Promise.reject(new Error('D1 is down'))),
  ).resolves.toBeNull();
  expect(put).not.toHaveBeenCalled();

  error.mockRestore();
});
