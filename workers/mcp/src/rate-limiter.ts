import { DurableObject } from 'cloudflare:workers';
import type { RateLimiterObject } from '../../../src/lib/mcp/limits';
import type { McpEnv } from './env';

/**
 * The object that actually enforces the MCP rate limits (03 §3).
 *
 * WHY THIS EXISTS RATHER THAN A `ratelimits` BINDING -- the whole of #29.
 * Cloudflare's Workers Rate Limiting binding was the original mechanism, it
 * was configured correctly, it deployed correctly, and it enforced NOTHING in
 * production. MEASURED against the live Worker on 2026-09-08, version
 * f7634c05 (whose bindings `wrangler versions view` shows as
 * `env.RATE_LIMITER (60 requests/60s)`, so this is not a config or a deploy
 * defect):
 *
 *   150 STRICTLY SEQUENTIAL get_contact calls, 22s wall clock, one 60s
 *   window, 120 of them served by a single Cloudflare location (SJC, read off
 *   `cf-ray`) -- against a 60-per-60s bucket. Refusals: 0. All 150 audited
 *   `ok`, so every one reached the seam. An earlier 90-sequential run and the
 *   issue's own 140-parallel run: also 0.
 *
 * That is 2x the limit in one location in under half a window, and the
 * binding never said no. Cloudflare's own documentation says why, and says it
 * plainly enough that this should be read as the binding working as designed
 * rather than as a bug: the Rate Limiting API is "permissive, eventually
 * consistent, and intentionally designed to not be used as an accurate
 * accounting system", its counters are "cached on the same machine that your
 * Worker runs in, and updated asynchronously in the background", and each
 * limit is per Cloudflare location. A Worker at this site's traffic level
 * spreads consecutive requests across cold isolates, and a cold isolate's
 * cached counter has nothing in it yet. 03 §3 does not ask for a hint; it
 * says every public tool call is rate limited. The binding cannot promise
 * that, so it is not the mechanism any more.
 *
 * WHY A DURABLE OBJECT. A rate limit is a counter that has to be right under
 * concurrency, which is the one thing a Durable Object is for: all calls for a
 * given key reach ONE object, single-threaded, and its storage is on the same
 * thread as the code. The pairing that makes this safe is the KEY: one object
 * per `<tool>:<ip>` (see `limitKeyFor`), so the sharding is natural and there
 * is no global instance. Cloudflare's own "Rules of Durable Objects" names the
 * opposite -- a single DO doing global rate limiting -- as the anti-pattern to
 * avoid, and it is avoided here by construction rather than by care.
 *
 * The cost of being right is one extra object hop per tool call. That is
 * accepted deliberately: every call on this surface already awaits a document
 * fetch over the public origin or a Workers AI embedding, and neither is in
 * the same order of magnitude.
 */
// `DurableObject<McpEnv>` even though this object reads NO binding: the base
// class's type parameter defaults to the SITE Worker's ambient `Env` (the one
// `wrangler types` writes to worker-configuration.d.ts from ./wrangler.jsonc),
// which is not the environment this class is constructed with. Left to the
// default, `super(ctx, env)` is a type error, and the tempting fix -- widening
// the parameter to `unknown` -- is the same error read backwards. Naming
// `McpEnv` says which Worker owns this class, which is also the thing the
// `export` in ./index.ts depends on being true.
export class RateLimiter extends DurableObject<McpEnv> implements RateLimiterObject {
  #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: McpEnv) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    // Synchronous, so it needs no `blockConcurrencyWhile`: SQLite in a Durable
    // Object runs on the object's own thread, and `ctx.storage.sql.exec` returns
    // a cursor rather than a promise. Wrapping it would suspend the object on
    // every construction to await something that never yields.
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS bucket (
         id         INTEGER PRIMARY KEY CHECK (id = 0),
         tokens     REAL    NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  /**
   * Spend one token, and say whether there was one.
   *
   * A TOKEN BUCKET rather than a fixed window, and the difference is not
   * cosmetic -- it is the reason the tests for this can assert an exact
   * number. A fixed, wall-clock-aligned window lets a burst straddle a
   * boundary and be allowed twice over: tests/mcp-tools.test.ts used to carry
   * a `burstSize` helper that sent `2 * limit + 1` calls purely to out-vote
   * that, with a comment measuring the resulting flake at 1-4% of runs. A
   * bucket has no boundary to straddle. From full, exactly `capacity` calls
   * succeed; the next fails; and tokens return at a steady
   * `refillPerSecond` rather than all at once on a minute tick.
   *
   * The parameters are passed per call rather than stored, so the limits live
   * in ONE place (`LIMITS` in src/lib/mcp/limits.ts) and a change to them
   * takes effect without a migration or a stale-state problem. That is safe
   * only because the cost class is implied by the key: `limitKeyFor` puts the
   * tool name in it and each tool declares exactly one `cost`, so no two
   * callers of one object can disagree about its capacity.
   *
   * `Math.max(0, ...)` on the elapsed time is deliberate: `Date.now()` inside
   * a Durable Object is not guaranteed to be monotonic across a relocation,
   * and a negative interval would otherwise DRAIN the bucket by refilling it
   * backwards -- refusing a caller who had done nothing.
   */
  async consume(capacity: number, refillPerSecond: number): Promise<{ success: boolean }> {
    const now = Date.now();
    const [row] = this.#sql
      .exec<{
        tokens: number;
        updated_at: number;
      }>('SELECT tokens, updated_at FROM bucket WHERE id = 0')
      .toArray();

    const elapsedSeconds = row ? Math.max(0, now - row.updated_at) / 1000 : 0;
    const available = Math.min(
      capacity,
      (row?.tokens ?? capacity) + elapsedSeconds * refillPerSecond,
    );
    const success = available >= 1;

    this.#sql.exec(
      `INSERT INTO bucket (id, tokens, updated_at) VALUES (0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
      success ? available - 1 : available,
      now,
    );

    // A TTL, not a nicety. The key is `<tool>:<ip>`, so every distinct client
    // that ever calls a tool mints an object, and an object that keeps a row
    // for ever is a storage bill that only grows -- with the size of the leak
    // set by how many strangers find the endpoint, which is exactly the number
    // this Worker cannot control. The alarm below deletes the bucket once it
    // could only have refilled to full anyway, at which point the row says
    // nothing a cold start would not say. `setAlarm` REPLACES any existing
    // alarm, so calling it on every consume simply keeps pushing the deletion
    // out while the client is active.
    await this.ctx.storage.setAlarm(now + this.#idleMs(capacity, refillPerSecond));
    return { success };
  }

  /**
   * How long this object has to sit untouched before its state is worthless.
   *
   * A bucket emptied to zero is indistinguishable from a cold one after
   * `capacity / refillPerSecond` seconds, because that is how long a full
   * refill takes. Doubled for margin, floored at a minute so a very fast
   * refill cannot schedule an alarm storm, and given a finite answer when
   * `refillPerSecond` is 0 -- a bucket that never refills would otherwise
   * divide to `Infinity` and hand `setAlarm` a value it cannot use.
   */
  #idleMs(capacity: number, refillPerSecond: number): number {
    const refillMs = refillPerSecond > 0 ? (capacity / refillPerSecond) * 1000 : 60_000;
    return Math.max(60_000, refillMs * 2);
  }

  /** Drops the bucket. See `consume`'s note on why this object has a TTL. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
