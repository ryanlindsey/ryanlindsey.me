// The MCP rate limiter's seam (03 §3). `defineTool` (workers/mcp/src/define.ts)
// draws every tool call through `checkLimit`, so nothing here is optional for a
// tool: there is one registration path and it always limits.

/**
 * The bucket a tool draws from. `cheap` reads a published document; the site
 * origin would serve the same bytes to an anonymous GET, so the limit exists
 * to bound abuse rather than to ration the content. `inference` spends a
 * Workers AI call. `expensive` spends a frontier-model call through AI
 * Gateway -- day 5's private tier, and the only bucket here whose overspend
 * costs real money rather than quota. `conversation` is day 6's chat turn --
 * one Workers AI embedding call plus one Sonnet call -- and is the one entry
 * here that is not a tool at all (see `LIMITS` below).
 */
export type ToolCost = 'cheap' | 'inference' | 'expensive' | 'conversation';

/**
 * What each cost class is allowed.
 *
 * These used to live in `workers/mcp/wrangler.jsonc` as two `ratelimits`
 * entries, which is where a `ratelimits` binding's limits have to live. They
 * are here now because the mechanism changed (#29 -- see
 * workers/mcp/src/rate-limiter.ts for the measurement that forced it), and
 * because config was the wrong home for them: a number no test could read
 * meant the assertion in tests/mcp-tools.test.ts that `cost: 'inference'`
 * routes to the SMALLER bucket had to hard-code `10` in a comment and hope.
 *
 * `inference` is a tenth of `cheap` for the reason day 3 wrote into the old
 * config: `search_writing` spends a Workers AI embedding call per query (24
 * prompt tokens, measured), and it is the only tool here whose cost scales
 * with a stranger's enthusiasm. Document reads are asset fetches against an
 * origin that would serve the same bytes to an anonymous GET, so 60/minute is
 * generous on purpose -- an agent exploring the portfolio should never meet a
 * limit.
 */
export const LIMITS: Record<ToolCost, { limit: number; periodSeconds: number }> = {
  cheap: { limit: 60, periodSeconds: 60 },
  inference: { limit: 10, periodSeconds: 60 },
  /**
   * One Opus call per invocation, through AI Gateway, over the whole public
   * corpus (04 §2's "tight caps (Opus calls)"). Six per five minutes is
   * deliberately not per-minute: a fit report is read, not skimmed, and a
   * person iterating on a description does so in minutes rather than seconds.
   * A tighter per-minute cap would refuse a legitimate second attempt while a
   * looser one would let a leaked link spend real money before the daily
   * breaker (src/lib/fit/engine.ts) noticed.
   */
  expensive: { limit: 6, periodSeconds: 300 },
  /**
   * Chat (04 §1's "per-session and daily global caps", the per-caller half).
   * One Workers AI embedding call plus one Sonnet call per message.
   *
   * NOT A TOOL, and this is the one entry in this table that is not. Chat is an
   * HTTP route on the MCP Worker (workers/mcp/src/chat.ts) rather than a
   * registered tool, because 04 §1 requires a streamed answer and a tool result
   * is one payload -- but it draws from this limiter through the same
   * `checkLimit`, keyed `chat:<ip>`, so "everything that spends inference is
   * limited" stays true with no second mechanism.
   *
   * Twelve per five minutes rather than a per-minute cap, for the same reason
   * `expensive` is shaped that way: a conversation is a handful of turns over
   * several minutes, and a per-minute cap either refuses a fast follow-up or is
   * loose enough to be no cap at all. `retryHint` derives the wait from these
   * two numbers -- 25 seconds here -- so a refusal tells the caller something
   * true without a second constant.
   */
  conversation: { limit: 12, periodSeconds: 300 },
};

/**
 * How long a refused caller should actually wait, as a phrase to put in the
 * refusal.
 *
 * DERIVED, and derived from the right quantity, which is not the obvious one.
 * The wait is `periodSeconds / limit` -- the time this bucket takes to return
 * ONE token -- not `periodSeconds`, which is how long a full refill takes and
 * would tell an `analyze_fit` caller to wait 5 minutes for something that is
 * ready in 50 seconds. `consume` (workers/mcp/src/rate-limiter.ts) succeeds at
 * one whole token, and tokens return continuously rather than on a window
 * tick, so one token is the whole of what a retry needs.
 *
 * MEASURED against the three classes, since the arithmetic is what makes this
 * worth having: cheap 60/60s returns a token in 1s, inference 10/60s in 6s,
 * expensive 6/300s in 50s. Day 5 is what made the fixed string this replaces
 * ("Try again in a minute.") worth revisiting -- and worth recording that it
 * was never actually WRONG, because 60 seconds buys 1.2 tokens even on the
 * slowest bucket. It was true by luck, of numbers it did not read. This is
 * true by construction, and stays true when `LIMITS` changes.
 */
export function retryHint(cost: ToolCost): string {
  const { limit, periodSeconds } = LIMITS[cost];
  const seconds = Math.ceil(periodSeconds / limit);
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/**
 * The limiter object's RPC contract, declared HERE rather than in the Worker
 * that implements it.
 *
 * The direction matters. `workers/mcp/src/rate-limiter.ts` imports this and
 * declares `implements RateLimiterObject`; nothing under src/lib imports that
 * file. That keeps the rule this module was already written to -- nothing
 * under src/lib depends on the shape of one particular Worker's environment --
 * true of the Durable Object as well, and it is what lets `LimitsEnv` below
 * name a typed DO namespace without reaching into workers/mcp.
 */
export interface RateLimiterObject extends Rpc.DurableObjectBranded {
  consume(capacity: number, refillPerSecond: number): Promise<{ success: boolean }>;
}

/**
 * The bindings this module needs, narrower than `McpEnv`
 * (workers/mcp/src/env.ts) and declared here for the same reason
 * `DocumentsEnv` is. `McpEnv` satisfies it structurally, so
 * `checkLimit(tc.env, ...)` typechecks at every call site without the
 * coupling.
 *
 * ONE binding now, where there were two. The two existed because a
 * `ratelimits` binding carries its limit in its own config, so two limits
 * meant two bindings (`RATE_LIMITER` and `RATE_LIMITER_SEARCH`, namespaces
 * 1001 and 1002). A Durable Object's separation comes from its NAME instead,
 * and `limitKeyFor` already puts the tool in the name -- so `search_writing`
 * has had a bucket of its own all along, by the same mechanism that gives
 * `get_post` one. The second binding was buying nothing the key was not
 * already buying, and the limits it carried are in `LIMITS` above.
 */
export interface LimitsEnv {
  RATE_LIMITER: DurableObjectNamespace<RateLimiterObject>;
}

/**
 * The rate-limit key, and therefore the name of the Durable Object that
 * enforces it.
 *
 * `CF-Connecting-IP` is set by Cloudflare on every edge request and cannot be
 * spoofed by the client, which is what makes it usable here. It is used as a
 * bucket key and never persisted: the key names an object and is discarded
 * with the request, it is not written to `mcp_tool_calls` (see
 * migrations/0001_mcp_audit.sql -- there is no IP column), and /ai-policy
 * (06 §2) says the site does no fingerprinting beyond UA and route.
 *
 * Not hashed, and saying so rather than implying otherwise: the key never
 * outlives the request, so hashing it would buy no real privacy while making
 * this comment the only place the truth was written down.
 *
 * The tool name is in the key so one tool's limit cannot starve another's: a
 * client that exhausts search_writing can still read a case study. It is also
 * what makes ONE Durable Object class enough for both cost classes -- each
 * tool has exactly one `cost`, so no two callers of one object can disagree
 * about its capacity.
 *
 * Cloudflare's rate-limiting docs recommend AGAINST keying on an IP, since
 * one address can front many users. That advice is noted and not taken, for a
 * reason that is specific to this tier and should be re-read the day it stops
 * being true: the public tier is unauthenticated by design (03 §1), so there
 * is no user id, tenant id or API key to key on instead -- the choice is an
 * IP or nothing.
 *
 * Day 5 introduced the real identity that paragraph anticipated. A granted
 * call keys on the token's `jti`, not the IP: the whole reason Cloudflare's
 * own guidance argues against IP keys is that one address fronts many users,
 * and a token names exactly one holder. Two consequences worth stating,
 * because both are choices:
 *
 *   - A token holder behind a shared IP is no longer starved by strangers.
 *   - A token holder cannot escape their own bucket by changing networks,
 *     which is what makes the `expensive` cap on `analyze_fit` mean anything.
 *
 * The anonymous remainder still keys on the IP, unchanged, because there is
 * still nothing else to key it on.
 *
 * MEASURED 2026-09-08, because #29 suspected the apex origin lost this header
 * across the site Worker's `env.MCP.fetch(request)` hop and collapsed every
 * caller into one `<tool>:unknown` bucket: a request to
 * https://ryanlindsey.me/mcp carrying `User-Agent: rlme-probe-apex/1.0`
 * arrived with that user agent intact in `mcp_tool_calls.user_agent`.
 * `clientIdentity` reads `user-agent` off the very same `tc.request` object
 * this function reads `cf-connecting-ip` off, so the request reaching this
 * Worker over the service binding IS the client's, with the client's headers
 * on it. That is strong evidence rather than proof for `CF-Connecting-IP`
 * specifically, which the edge adds rather than the client sending -- see the
 * note in tests/mcp-rate-limit.test.ts about what a deploy still has to
 * confirm.
 */
export function limitKeyFor(
  request: Request | undefined,
  tool: string,
  grant: { jti: string } | null,
): string {
  if (grant !== null) return `${tool}:g:${grant.jti}`;
  const ip = request?.headers.get('cf-connecting-ip') ?? 'unknown';
  return `${tool}:${ip}`;
}

/**
 * Spend one call's worth of this client's allowance, and say whether it was
 * there. `false` means refuse.
 *
 * The refill rate is derived rather than configured: `limit` tokens per
 * `periodSeconds` IS `limit / periodSeconds` per second, and deriving it means
 * a bucket cannot be given a capacity and a rate that disagree.
 */
export async function checkLimit(
  env: LimitsEnv,
  cost: ToolCost,
  request: Request | undefined,
  tool: string,
  grant: { jti: string } | null,
): Promise<boolean> {
  const { limit, periodSeconds } = LIMITS[cost];
  const { success } = await env.RATE_LIMITER.getByName(limitKeyFor(request, tool, grant)).consume(
    limit,
    limit / periodSeconds,
  );
  return success;
}

/**
 * Caps that belong to a FEATURE rather than to a caller (04 §1's "daily global
 * cap"). Same Durable Object class, same `consume` call; the only difference is
 * that the object's name is a constant instead of being derived from the
 * request, so every caller in the world shares one bucket.
 *
 * A DURABLE OBJECT RATHER THAN A KV COUNTER, and the alternative is written
 * down because it was the first design: KV has no counter primitive, so a cap
 * there is read-compare-write against an eventually-consistent store and can be
 * overshot by roughly the number of concurrent requests. That is the same
 * approximate-limiter trap #29 already cost this repo a day on
 * (workers/mcp/src/rate-limiter.ts), and there is no reason to re-enter it when
 * the exact mechanism is already deployed and one call away.
 *
 * 500 messages a day at Sonnet prices over ~8 retrieved passages is the number
 * the breaker exists to make survivable rather than the number the budget
 * expects; if it is ever reached in ordinary use, that is a signal to publish on
 * /ops, not a limit to quietly raise.
 */
export const GLOBAL_LIMITS = {
  chat: { limit: 500, periodSeconds: 86_400 },
} as const;

/**
 * Spend one unit of a feature-wide allowance. `false` means refuse.
 *
 * The bucket's name is `global:<feature>`, which cannot collide with
 * `limitKeyFor`'s output: that always contains a tool name followed by `:` and
 * either an address or `g:`, and no tool is called `global`.
 */
export async function checkGlobalLimit(
  env: LimitsEnv,
  name: keyof typeof GLOBAL_LIMITS,
): Promise<boolean> {
  const { limit, periodSeconds } = GLOBAL_LIMITS[name];
  const { success } = await env.RATE_LIMITER.getByName(`global:${name}`).consume(
    limit,
    limit / periodSeconds,
  );
  return success;
}
