// The MCP rate limiter's seam (03 §3). `defineTool` (workers/mcp/src/define.ts)
// draws every tool call through `checkLimit`, so nothing here is optional for a
// tool: there is one registration path and it always limits.

/**
 * The bucket a tool draws from. `cheap` reads a published document; the site
 * origin would serve the same bytes to an anonymous GET, so the limit exists
 * to bound abuse rather than to ration the content. `inference` spends a
 * Workers AI call.
 */
export type ToolCost = 'cheap' | 'inference';

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
};

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
 * IP or nothing. Day 5's scoped tokens introduce a real identity; a token'd
 * call should key on the token, and only the anonymous remainder on the IP.
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
export function limitKeyFor(request: Request | undefined, tool: string): string {
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
): Promise<boolean> {
  const { limit, periodSeconds } = LIMITS[cost];
  const { success } = await env.RATE_LIMITER.getByName(limitKeyFor(request, tool)).consume(
    limit,
    limit / periodSeconds,
  );
  return success;
}
