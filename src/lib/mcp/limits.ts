// The MCP rate limiter's seam (03 §3). `defineTool` (workers/mcp/src/server.ts)
// draws every tool call through `limiterFor` and `limitKeyFor`, so nothing here
// is optional for a tool: there is one registration path and it always limits.

/**
 * The bucket a tool draws from. `cheap` reads a published document; the site
 * origin would serve the same bytes to an anonymous GET, so the limit exists
 * to bound abuse rather than to ration the content. `inference` spends a
 * Workers AI call.
 */
export type ToolCost = 'cheap' | 'inference';

/**
 * The bindings this module needs, narrower than `McpEnv`
 * (workers/mcp/src/env.ts) and declared here for the same reason
 * `DocumentsEnv` is: nothing under src/lib should depend on the shape of one
 * particular Worker's environment. `McpEnv` satisfies it structurally, so
 * `limiterFor(tc.env, cost)` typechecks at every call site without the
 * coupling.
 */
export interface LimitsEnv {
  RATE_LIMITER: RateLimit;
  RATE_LIMITER_SEARCH: RateLimit;
}

/**
 * The bucket for a cost class. The two are separate namespaces in
 * workers/mcp/wrangler.jsonc, so an agent that exhausts the embedding budget
 * can still read documents.
 */
export function limiterFor(env: LimitsEnv, cost: ToolCost): RateLimit {
  return cost === 'inference' ? env.RATE_LIMITER_SEARCH : env.RATE_LIMITER;
}

/**
 * The rate-limit key.
 *
 * `CF-Connecting-IP` is set by Cloudflare on every edge request and cannot be
 * spoofed by the client, which is what makes it usable here. It is used as a
 * bucket key and never persisted: the key is handed to the limiter binding and
 * discarded with the request, it is not written to `mcp_tool_calls` (see
 * migrations/0001_mcp_audit.sql -- there is no IP column), and /ai-policy
 * (06 §2) says the site does no fingerprinting beyond UA and route.
 *
 * Not hashed, and saying so rather than implying otherwise: the key never
 * outlives the request, so hashing it would buy no real privacy while making
 * this comment the only place the truth was written down.
 *
 * The tool name is in the key so one tool's limit cannot starve another's:
 * a client that exhausts search_writing can still read a case study.
 */
export function limitKeyFor(request: Request | undefined, tool: string): string {
  const ip = request?.headers.get('cf-connecting-ip') ?? 'unknown';
  return `${tool}:${ip}`;
}
