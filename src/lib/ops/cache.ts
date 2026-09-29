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
 * How long an entry outlives its freshness, in seconds: a day.
 *
 * AN ENTRY IS KEPT PAST ITS TTL SO THAT A VISITOR NEVER WAITS FOR THE READ.
 * Until 2026-09-28 an entry expired when it stopped being fresh, and the
 * site's traffic is thin enough that most visitors arrived more than a minute
 * after the last, so most paid for the D1 batch and two api.cloudflare.com
 * round trips inline. Measured that day, the home page's server island
 * answered in 0.72s and 0.87s on an expired entry and 0.2s to 0.4s on a live
 * one. A stale entry is now served at once and recomputed behind the response.
 *
 * A day is the bound on how wrong a figure can be, for a page that went a day
 * without a visitor: its first reader sees yesterday's number, and the next
 * sees today's.
 */
export const STALE_SECONDS = 86_400;

/** What is stored under a key: the value, and when it was computed. */
interface Entry<T> {
  at: number;
  value: T;
}

function isEntry<T>(hit: unknown): hit is Entry<T> {
  return (
    typeof hit === 'object' &&
    hit !== null &&
    typeof (hit as { at?: unknown }).at === 'number' &&
    'value' in hit
  );
}

export interface CachedOptions {
  /**
   * Keeps the background refresh alive past the response: `waitUntil` from
   * `cloudflare:workers`. Without it a stale entry is read inline, as a miss,
   * because a refresh nothing waits for may be cancelled before it writes.
   */
  defer?: (refresh: Promise<unknown>) => void;
  /** How long an entry is kept at all. Defaults to `STALE_SECONDS`. */
  staleSeconds?: number;
  /** The clock, for tests. */
  now?: () => number;
}

/**
 * Returns the cached value under `key`, or computes, stores and returns it.
 *
 * `freshSeconds` IS HOW LONG A VALUE IS SERVED WITHOUT BEING RECOMPUTED, not
 * how long it is kept. An entry older than that and younger than
 * `staleSeconds` is returned as it stands, and `options.defer` is handed the
 * refresh that replaces it, so the reader who finds it stale is answered from
 * KV and the reader after them gets the new value.
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
 * pinned as a "not configured" section for the whole TTL. The same holds for a
 * background refresh: a `null` or a rejection leaves the stale entry standing
 * rather than replacing a number with nothing.
 */
export async function cached<T>(
  kv: KVNamespace,
  key: string,
  freshSeconds: number,
  fn: () => Promise<T>,
  options: CachedOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const staleSeconds = options.staleSeconds ?? STALE_SECONDS;

  const store = async (fresh: T) => {
    if (fresh === null || fresh === undefined) return;
    const entry: Entry<T> = { at: now(), value: fresh };
    try {
      await kv.put(key, JSON.stringify(entry), {
        expirationTtl: Math.max(MIN_TTL_SECONDS, staleSeconds),
      });
    } catch (error) {
      // The value is already computed and is returned regardless. A page that
      // failed because it could not WRITE a cache entry would be the cache
      // causing the outage it exists to prevent.
      console.error(`ops: the cache could not be written at ${key}`, error);
    }
  };

  try {
    const hit = await kv.get<unknown>(key, 'json');
    // An entry in any other shape, including the bare value this module stored
    // before it kept a timestamp, is a miss rather than a value.
    if (isEntry<T>(hit)) {
      if (now() - hit.at < freshSeconds * 1000) return hit.value;
      if (options.defer !== undefined) {
        options.defer(
          fn().then(store, (error: unknown) => {
            console.error(`ops: the stale entry at ${key} could not be refreshed`, error);
          }),
        );
        return hit.value;
      }
    }
  } catch (error) {
    // Falls through to the fresh read rather than returning: an unreadable
    // cache is a cold cache.
    console.error(`ops: the cache could not be read at ${key}`, error);
  }

  const fresh = await fn();
  await store(fresh);
  return fresh;
}
