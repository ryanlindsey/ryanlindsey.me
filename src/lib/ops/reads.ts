import {
  readAnalytics,
  readSpend,
  type AgentTraffic,
  type AnalyticsEnv,
  type GatewaySpend,
} from './analytics';
import { cached } from './cache';
import { readOpsMetrics, type OpsMetrics } from './metrics';

/**
 * How long a figure on /ops may be, in one place: the KV entries below and
 * the `Cache-Control` header are the same number and must never be two.
 *
 * An intermediary holding the page longer than the cache holds its figures
 * would be publishing numbers this Worker has already replaced.
 */
export const CACHE_TTL_SECONDS = 60;

/** The window every counted figure on /ops is measured over. */
export const WINDOW_DAYS = 30;

/**
 * The KV key each of the three reads is cached under. The home page's band
 * reads these same keys, so a bump moves both.
 */
export const OPS_CACHE_KEYS = {
  // `v2` SINCE ISSUE #291, AND THE BUMP IS THE POINT RATHER THAN THE NUMBER.
  // `OpsMetrics` gained `status` (migrations/0005), and an entry written by
  // the previous build has no such field: `run.status === 'ran'` is false for
  // `undefined`, so every suite in the table would have rendered "did not
  // run" for the whole `CACHE_TTL_SECONDS` after the deploy. The page would
  // have been reporting a broken eval pipeline, from its own cache.
  //
  // THE SAME LESSON, ALREADY LEARNED ONCE HERE. CLAUDE.md records it about
  // `SEARCH_CACHE_VERSION`: `searchCacheKey` is built from the query alone,
  // so nothing in an entry names the shape or the index it came from, and
  // changing what an entry holds without changing the key keeps serving the
  // old one for a full TTL. This key has the same property and the same
  // remedy.
  //
  // `v3` SINCE ISSUE #353, for the same reason a second time. `fitRuns` went
  // from one number to four, and a `v2` entry's bare number has no `reports`
  // on it, so the fit tile would have rendered its absence, and its note
  // "null started", while D1 answered perfectly well. tests/ops-page.test.ts
  // once planted an entry under `ops:metrics:v2` and failed if the page
  // served it.
  //
  // `v4` SINCE ISSUE #428, a third time. Eval rows gained `unreached`
  // (migrations/0008), and a `v3` entry's rows have none. `undefined === 0`
  // is false, so every Couldn't-run cell would have rendered empty and in
  // warn ink, a column of unexplained amber on every row, where the column
  // promises a number. tests/ops-page.test.ts now plants an entry under
  // `ops:metrics:v3`.
  metrics: 'ops:metrics:v4',
  traffic: 'ops:traffic:v1',
  spend: 'ops:spend:v1',
} as const;

export interface OpsReadsEnv extends AnalyticsEnv {
  DB: D1Database;
  KV_CACHE: KVNamespace;
}

export interface OpsReads {
  metrics: OpsMetrics | null;
  traffic: AgentTraffic | null;
  spend: GatewaySpend | null;
}

/**
 * One read, cached under its own key, degrading to `null` on anything that
 * throws.
 *
 * THREE KEYS RATHER THAN ONE, which the plan spelled as a single `ops:v1`. The
 * key shape turned out to be load-bearing in two directions the single entry
 * got wrong, and neither is theoretical:
 *
 *   - IT MISLABELLED WHICH SYSTEM WAS BROKEN. One `try` around all three reads
 *     means a D1 rejection nulls `traffic` and `spend` as well, so the three
 *     Analytics Engine tiles fall through to their default absence -- "this
 *     needs the read-only analytics token" -- which is a FALSE sentence about
 *     what is wrong. That is the exact error `D1_ABSENT` in src/pages/ops.astro
 *     was invented to prevent, reintroduced one level up. It is harmless only
 *     while the token is unconfigured and becomes a live falsehood the day it
 *     is populated.
 *   - IT AMPLIFIED A D1 OUTAGE INTO AN API ONE. The `try` is outside `cached`
 *     (see below), so a rejection means NOTHING is written -- including the
 *     analytics half that answered perfectly well. Every request during a D1
 *     blip would then re-run `readAnalytics`'s three api.cloudflare.com queries
 *     uncached, against a rate-limited token, which is precisely the
 *     amplification src/lib/ops/cache.ts exists to prevent.
 *
 * Per-key caching also restores the property that module documents and the
 * single entry silently lost: `cached` never stores a bare `null`, so an
 * unconfigured or failed read is retried on the next request rather than pinned
 * as "not configured" for the whole TTL. Folded into a composite object, a
 * `null` half was just a field and was stored with the rest.
 *
 * THE TRY IS AROUND THE CACHE CALL RATHER THAN INSIDE IT, and that placement is
 * still the point. `readOpsMetrics` returns `Promise<OpsMetrics>`, not `| null`,
 * and carries no internal try -- deliberately, since a caller that wants the
 * numbers should hear about a D1 outage rather than receive a shape that looks
 * like zero traffic. /ops is the caller, and what it wants is to degrade:
 * an unhandled rejection here is a 500 on a public page whose entire premise is
 * that it tells you what it knows.
 *
 * WHAT THE PLACEMENT DOES NOT BUY, recorded rather than deleted because an
 * earlier version of this comment claimed it did (final-review Minor 6): it is
 * not what keeps a failed read out of the cache. `cached` awaits `fn` before it
 * writes anything, so a rejection leaves the function before the `put` no
 * matter where the caller's `try` sits. Not being pinned is
 * src/lib/ops/cache.ts's own structure, and so is the separate property that a
 * bare `null` is never stored. The 500 is the whole reason this `try` is here.
 */
export async function readOrNull<T>(
  kv: KVNamespace,
  key: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await cached<T | null>(kv, key, CACHE_TTL_SECONDS, read);
  } catch (error) {
    // The operator gets the exception in Workers observability; the reader gets
    // a sentence saying that figure is not available. A stack trace on a public
    // page would be both a worse answer and a disclosure.
    console.error(`ops: ${key} could not be read`, error);
    return null;
  }
}

/** The three reads, each cached and degraded on its own. */
export async function readOpsReads(env: OpsReadsEnv, now: Date): Promise<OpsReads> {
  const [metrics, traffic, spend] = await Promise.all([
    readOrNull(env.KV_CACHE, OPS_CACHE_KEYS.metrics, () =>
      readOpsMetrics(env.DB, now, WINDOW_DAYS),
    ),
    readOrNull(env.KV_CACHE, OPS_CACHE_KEYS.traffic, () => readAnalytics(env, now, WINDOW_DAYS)),
    readOrNull(env.KV_CACHE, OPS_CACHE_KEYS.spend, () => readSpend(env, now, WINDOW_DAYS)),
  ]);
  return { metrics, traffic, spend };
}

/** Every public tool call in the window, summed across the tools. */
export function publicToolCalls(metrics: OpsMetrics): number {
  return metrics.toolCalls.reduce((total, row) => total + row.calls, 0);
}

/** A figure with thousands separators, or `null` when there is no figure. */
export function formatCount(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toLocaleString('en-US');
}
