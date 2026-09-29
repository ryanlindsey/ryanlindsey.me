import { expect, test, vi } from 'vitest';
import { cached, MIN_TTL_SECONDS, STALE_SECONDS } from '../src/lib/ops/cache';

/**
 * The /ops read-through cache.
 *
 * A file of its own rather than a section of tests/ops-changelog.test.ts (the
 * plan pairs the two modules in one step but names only three test files): the
 * subject here is failure behaviour under a binding that misbehaves, which is a
 * different kind of test from a parser's, and tests/ops-metrics.test.ts's own
 * split is the precedent.
 *
 * No harness and no real KV: every property this module has is a property of
 * how it treats the binding's return values and its exceptions, and a stub is
 * the only way to make a `get` throw on demand.
 */

type KvGet = (key: string, type: 'json') => Promise<unknown>;
type KvPut = (key: string, value: string, options?: KVNamespacePutOptions) => Promise<void>;

const kv = (over: { get?: KvGet; put?: KvPut } = {}) => {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn<KvGet>(over.get ?? (async (key) => JSON.parse(store.get(key) ?? 'null') as unknown)),
    put: vi.fn<KvPut>(
      over.put ??
        (async (key, value) => {
          store.set(key, value);
        }),
    ),
  };
};

const asNamespace = (stub: ReturnType<typeof kv>) => stub as unknown as KVNamespace;

/** An entry as `cached` stores it, written `ageSeconds` before `NOW`. */
const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const entry = (value: unknown, ageSeconds: number) =>
  JSON.stringify({ at: NOW - ageSeconds * 1000, value });

test('a miss computes, stores and returns', async () => {
  const store = kv();
  const fn = vi.fn(async () => ({ requests: 7 }));

  expect(await cached(asNamespace(store), 'ops:traffic', 60, fn)).toEqual({ requests: 7 });
  expect(fn).toHaveBeenCalledTimes(1);
  expect(store.put).toHaveBeenCalledWith('ops:traffic', expect.any(String), {
    expirationTtl: STALE_SECONDS,
  });
  expect(JSON.parse(store.store.get('ops:traffic') ?? 'null')).toMatchObject({
    value: { requests: 7 },
  });
});

test('a hit returns the stored value and does NOT call the reader', async () => {
  const store = kv();
  store.store.set('ops:traffic', entry({ requests: 7 }, 10));
  const fn = vi.fn(async () => ({ requests: 999 }));
  const defer = vi.fn();

  expect(
    await cached(asNamespace(store), 'ops:traffic', 60, fn, { defer, now: () => NOW }),
  ).toEqual({ requests: 7 });
  expect(fn).not.toHaveBeenCalled();
  expect(defer).not.toHaveBeenCalled();
});

test('a stale hit returns the stored value at once and refreshes it in the background', async () => {
  // THE REASON THE ENTRY OUTLIVES ITS FRESHNESS. The site's traffic is thin
  // enough that most visitors arrive more than a minute after the last, and a
  // miss costs the visitor the D1 batch and two api.cloudflare.com round trips
  // (0.72s and 0.87s measured on 2026-09-28, against 0.2s to 0.4s for a hit).
  const store = kv();
  store.store.set('ops:traffic', entry({ requests: 7 }, 120));
  const fn = vi.fn(async () => ({ requests: 8 }));
  const deferred: Promise<unknown>[] = [];

  expect(
    await cached(asNamespace(store), 'ops:traffic', 60, fn, {
      defer: (p) => deferred.push(p),
      now: () => NOW,
    }),
  ).toEqual({ requests: 7 });
  expect(deferred).toHaveLength(1);
  await Promise.all(deferred);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(store.store.get('ops:traffic') ?? 'null')).toEqual({
    at: NOW,
    value: { requests: 8 },
  });
});

test('a stale hit with nowhere to defer the refresh is read inline, as a miss', async () => {
  const store = kv();
  store.store.set('ops:traffic', entry({ requests: 7 }, 120));

  expect(
    await cached(asNamespace(store), 'ops:traffic', 60, async () => ({ requests: 8 }), {
      now: () => NOW,
    }),
  ).toEqual({ requests: 8 });
});

test('a background refresh that fails keeps the stale entry and rejects nothing', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = kv();
  const stale = entry({ requests: 7 }, 120);
  store.store.set('ops:traffic', stale);
  const deferred: Promise<unknown>[] = [];

  const read = async () => {
    throw new Error('D1 is unreachable');
  };
  expect(
    await cached(asNamespace(store), 'ops:traffic', 60, read, {
      defer: (p) => deferred.push(p),
      now: () => NOW,
    }),
  ).toEqual({ requests: 7 });
  await expect(Promise.all(deferred)).resolves.toBeDefined();
  expect(store.store.get('ops:traffic')).toBe(stale);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

test('an entry in the old bare shape is a miss, not a value', async () => {
  const store = kv();
  store.store.set('ops:traffic', '{"requests":7}');

  expect(
    await cached(asNamespace(store), 'ops:traffic', 60, async () => ({ requests: 8 })),
  ).toEqual({ requests: 8 });
});

test('a TTL below the KV floor is raised rather than silently rejected', async () => {
  // KV rejects an `expirationTtl` under 60 seconds, and this module swallows
  // every put failure -- so passing 30 would produce a cache that never stores
  // anything and says nothing about it. Raising the value is the lesser
  // surprise, and this test is where a reader finds that out.
  const store = kv();
  await cached(asNamespace(store), 'ops:traffic', 30, async () => 1, { staleSeconds: 30 });
  expect(store.put).toHaveBeenCalledWith('ops:traffic', expect.any(String), {
    expirationTtl: MIN_TTL_SECONDS,
  });
});

test('a cache that cannot be READ degrades to a slow page, not an error', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = kv({
    get: async () => {
      throw new Error('KV is unreachable');
    },
  });

  expect(await cached(asNamespace(store), 'ops:traffic', 60, async () => 'fresh')).toBe('fresh');
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

test('a cache that cannot be WRITTEN still returns the value it computed', async () => {
  // The failure that would be the cache causing the outage it exists to
  // prevent: a page that 500s because it could not write a cache entry.
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = kv({
    put: async () => {
      throw new Error('KV is unreachable');
    },
  });

  expect(await cached(asNamespace(store), 'ops:traffic', 60, async () => 'fresh')).toBe('fresh');
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

test('a null result is returned and NEVER stored', async () => {
  // `readAnalytics` and `readSpend` return `null` for "this page cannot say".
  // Storing that would pin a "not configured" section for the whole TTL, and it
  // could not be read back as anything but a miss anyway -- `kv.get` answers
  // `null` for both. So the next request retries instead.
  const store = kv();
  expect(await cached(asNamespace(store), 'ops:spend', 60, async () => null)).toBeNull();
  expect(store.put).not.toHaveBeenCalled();
});

test('the reader is called once per miss, not once per caller', async () => {
  const store = kv();
  const fn = vi.fn(async () => 1);
  await cached(asNamespace(store), 'ops:metrics', 60, fn);
  await cached(asNamespace(store), 'ops:metrics', 60, fn);
  expect(fn).toHaveBeenCalledTimes(1);
});

test('the value survives the JSON round trip it is actually subjected to', async () => {
  // WHAT THIS PINS is the module's own warning: the value is stringified on the
  // way in and parsed on the way out, so a type that does not survive that
  // changes shape on the SECOND request and not the first. A Date is the
  // example, and it is asserted here so the constraint is a failing test rather
  // than a comment nobody reads.
  const store = kv();
  const read = async () => ({ at: new Date('2026-09-09T12:00:00.000Z') });
  const first = await cached(asNamespace(store), 'ops:dated', 60, read);
  const second = await cached(asNamespace(store), 'ops:dated', 60, read);

  expect(first.at).toBeInstanceOf(Date);
  expect(second.at).not.toBeInstanceOf(Date);
  expect(String(second.at)).toBe('2026-09-09T12:00:00.000Z');
});
