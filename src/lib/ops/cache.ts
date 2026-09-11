// The read-through KV cache /ops's figures are served from (06 §1).
//
// It exists because every number on that page costs either a D1 batch or two
// HTTPS round trips to api.cloudflare.com, and the page is public: a crawler
// that finds it, or one link that does well, must not turn into one analytics
// API call per request against a token with a rate limit.
//
// A CACHE THAT FAILS MUST DEGRADE TO A SLOW PAGE, NEVER TO AN ERROR. Every KV
// failure here -- an unreachable namespace, a value that is not the JSON that
// was written, a `put` that is rejected -- ends with the fresh value being
// computed and returned. The page is correct and slower, which is the only
// acceptable way for a cache to be wrong.

/**
 * KV's documented floor for `expirationTtl`, in seconds.
 *
 * A shorter TTL is not a shorter cache: `put` REJECTS it, this module swallows
 * that rejection like any other, and the result is a cache that silently never
 * stores anything. Raising the value is the lesser surprise of the two, and it
 * is said out loud here so the next person does not spend an afternoon on it.
 */
export const MIN_TTL_SECONDS = 60;

/**
 * Returns the cached value under `key`, or computes, stores and returns it.
 *
 * `T` MUST SURVIVE A JSON ROUND TRIP, because that is literally what happens to
 * it: the value is stored with `JSON.stringify` and read back with `get(key,
 * 'json')`. A `Date` goes in and a string comes out, and it comes out that way
 * only on a cache HIT -- so the bug appears on the second request, not the
 * first, which is the worst shape a bug can have. /ops's readers return plain
 * numbers, strings and arrays for this reason.
 *
 * A `null` RESULT IS NEVER CACHED, and that is deliberate rather than an
 * oversight in the hit test. `kv.get` returns `null` for a miss, so a stored
 * `null` and an absent key are the same value on the way back and cannot be
 * told apart. That falls out in the direction this page wants: `readAnalytics`
 * and `readSpend` return `null` to mean "this page cannot say", and a failed or
 * unconfigured read is therefore retried on the next request instead of being
 * pinned as a "not configured" section for the whole TTL.
 */
export async function cached<T>(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await kv.get<T>(key, 'json');
    if (hit !== null) return hit;
  } catch (error) {
    // Falls through to the fresh read rather than returning: an unreadable
    // cache is a cold cache.
    console.error(`ops: the cache could not be read at ${key}`, error);
  }

  const fresh = await fn();
  if (fresh === null || fresh === undefined) return fresh;

  try {
    await kv.put(key, JSON.stringify(fresh), {
      expirationTtl: Math.max(MIN_TTL_SECONDS, ttlSeconds),
    });
  } catch (error) {
    // The value is already computed and is returned regardless. A page that
    // failed because it could not WRITE a cache entry would be the cache
    // causing the outage it exists to prevent.
    console.error(`ops: the cache could not be written at ${key}`, error);
  }
  return fresh;
}
