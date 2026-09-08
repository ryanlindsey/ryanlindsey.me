import { createMcpHandler } from 'agents/mcp/server';
import { corpusRefreshEnabled, refreshCorpus, type CorpusEnv } from '../../../src/lib/corpus';
import { buildMcpDiscovery, buildMcpRobotsTxt } from '../../../src/lib/mcp/discovery';
import { type McpEnv } from './env';
import { createServer } from './server';

// The rate limiter's Durable Object (03 §3), re-exported from this module
// because a DO class has to be exported from the Worker's ENTRYPOINT to be
// instantiable -- `class_name` in wrangler.jsonc is looked up on the module
// `main` names, not on the file that happens to define it. Defining it in
// ./rate-limiter.ts and forgetting this line is a deploy that fails on "Class
// RateLimiter not found", which is at least loud; the quiet failure it
// replaces is #29's, so see that file for why the limiter is an object at all.
export { RateLimiter } from './rate-limiter';

/**
 * The corpus job's view of this Worker, assembled explicitly rather than spread
 * from `env` -- it is a deliberate subset, and `refreshCorpus` should not be
 * handed bindings it has no business touching.
 *
 * THE DAY-3 COMMENT THAT USED TO BE HERE WAS WRONG BY THE TIME IT SHIPPED, and
 * it is worth writing out what it said rather than quietly replacing it, because
 * it was wrong in the way comments usually are -- true when written, falsified
 * by a change nobody thought to re-read it against. It said:
 *
 *   "`mcp.ryanlindsey.me` and `ryanlindsey.me` are different hostnames on
 *    different Workers, so this is an ordinary subrequest to the site rather
 *    than a fetch that could loop back into this Worker."
 *
 * Day 4 Task 13 then made the SITE forward `ryanlindsey.me/mcp` into this Worker
 * over its `MCP` service binding, with the request's URL and `Host` untouched.
 * From that deploy on, a request could arrive here already bearing
 * `Host: ryanlindsey.me` -- and the global `fetch('https://ryanlindsey.me/...')`
 * this function used to build was then a fetch to the hostname of the request
 * being served. `ryanlindsey.me` is a Cloudflare CUSTOM DOMAIN for the site
 * Worker, and Cloudflare's Error 522 page says exactly that case returns 522.
 * Issue #28: seven of eight tools and `resources/list` failed on the endpoint
 * 03 §1 calls PRIMARY, while `mcp.ryanlindsey.me` -- where the target really is
 * a different hostname -- kept working, which is what made it look like a site
 * outage rather than a routing rule. Nothing re-read this comment for two days
 * because nothing had to.
 *
 * `env.SITE` is a service binding to `ryanlindsey-me` (workers/mcp/wrangler.jsonc),
 * and it is not merely a fix for that arrival path -- it removes the class. A
 * service-binding dispatch never reaches Cloudflare's edge, so there is no
 * hostname for it to collide with and no arrival path that can change its
 * behaviour. The site is still the source of truth for what is published
 * (this Worker has no assets and must not grow a copy of them), so the corpus
 * still embeds exactly what a reader is served; only the transport changed.
 */
function corpusEnv(env: McpEnv): CorpusEnv {
  return {
    SITE: env.SITE,
    AI: env.AI,
    VECTORIZE: env.VECTORIZE,
    KV_CACHE: env.KV_CACHE,
    SITE_ORIGIN: env.SITE_ORIGIN,
    CORPUS_REFRESH: env.CORPUS_REFRESH,
  };
}

/**
 * Handler options shared by every request.
 *
 * `allowedOriginHostnames: '*'` is a DELIBERATE opening, measured before it
 * was made: `agents`' stateless handler otherwise validates `Origin` against
 * `localhostAllowedOrigins()` (`localhost`, `127.0.0.1`, `[::1]`) and answers
 * a browser client on any other origin with
 * `403 {"code":-32000,"message":"Invalid Origin: <host>"}`. Verified against
 * production on 2026-09-06: `Origin: https://claude.ai` -> 403,
 * `Origin: http://localhost:6274` (MCP Inspector) -> 200. A request with NO
 * `Origin` header always passed, which is why curl and Claude Code worked and
 * a browser connector did not.
 *
 * Why opening it is safe HERE, stated so day 5 can check whether it still
 * holds: this tier is unauthenticated and read-only, it returns only
 * documents already published at https://ryanlindsey.me, and it carries no
 * ambient credential -- no cookies, no session the browser attaches on its
 * own. Origin validation exists to stop a page using a victim's ambient
 * authority; there is none to borrow, so a cross-origin fetch obtains exactly
 * what the attacker's own server could have fetched.
 *
 * DAY 5 MUST RE-READ THIS. Scoped tokens arrive then. The property that keeps
 * this safe is that a token is supplied EXPLICITLY by the client on each
 * call. If a token is ever accepted from a cookie, or cached per-origin, this
 * setting becomes a real cross-origin read of gated data and must change.
 */
const HANDLER_OPTIONS = {
  route: '/mcp',
  allowedOriginHostnames: '*',
  corsOptions: {
    origin: '*',
    methods: 'GET, POST, OPTIONS',
    // `mcp-session-id` and `mcp-protocol-version` are the transport's own
    // headers; without them in the preflight allowlist a browser client
    // cannot send them and the session header is dropped before it is read.
    headers: 'content-type, accept, mcp-session-id, mcp-protocol-version, authorization',
    exposeHeaders: 'mcp-session-id',
    maxAge: 86400,
  },
} as const;

/**
 * This Worker's own vanity domain (workers/mcp/wrangler.jsonc's `routes`
 * entry), a literal for the same reason src/pages/llms.txt.ts's own
 * `MCP_ENDPOINT` is one: this Worker has no var naming its own hostname
 * (`SITE_ORIGIN` in McpEnv names the SITE's origin, for the corpus job's
 * fetches, not this one), and `request.url` reads as the test harness's
 * loopback address under `createTestHarness` rather than the real custom
 * domain (tests/workers.ts's own note on `inferOriginFromRoutes`) -- deriving
 * this from the request would silently answer with the wrong endpoint under
 * every suite that boots this Worker.
 */
const MCP_ORIGIN = 'https://mcp.ryanlindsey.me';

export default {
  /**
   * The server itself is built in ./server.ts, one instance per HTTP request:
   * `createMcpHandler` is stateless, and `defineTool` needs `env`, `ctx` and
   * the original request in scope to limit and audit the call. `requestInfo`
   * is the SDK's own handle on that request and is preferred over the
   * closed-over `request` for exactly the case where they differ -- a legacy
   * fallback instance the handler constructs for a request of its own.
   */
  fetch(request, env, ctx) {
    // Day 4 Task 14 (roadmap "/.well-known + discovery"; 03 §5): routed
    // BEFORE the MCP handler, deliberately. HANDLER_OPTIONS above answers
    // exactly `route: '/mcp'` and 404s everything else it sees, so these two
    // discovery surfaces have to be intercepted here or they never reach
    // anything that could answer them.
    const { pathname } = new URL(request.url);

    if (pathname === '/robots.txt') {
      return new Response(buildMcpRobotsTxt(), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (pathname === '/.well-known/mcp.json') {
      return new Response(JSON.stringify(buildMcpDiscovery(MCP_ORIGIN), null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return createMcpHandler(
      (mcpCtx) => createServer({ env, ctx, request: mcpCtx.requestInfo ?? request }),
      HANDLER_OPTIONS,
    )(request, env, ctx);
  },

  /**
   * The publishing corpus's embedding refresh (Task 15), on this Worker's own
   * daily cron (`triggers.crons` in wrangler.jsonc).
   *
   * It is here rather than on the site Worker because the `ai` binding it runs
   * on is always-remote to @cloudflare/vite-plugin, and its presence in the
   * site's config made `astro build` open a remote proxy session that
   * credential-free CI cannot authenticate. Nothing in CI builds this Worker.
   * The pairing is not arbitrary either: day 4's semantic search runs over this
   * same index from this same Worker, so the Worker that queries the corpus is
   * the one that fills it.
   *
   * `waitUntil`, not `await`: the job outlives the handler's return, exactly as
   * the résumé-PDF job does on the site Worker.
   *
   * `corpusRefreshEnabled` is the test seam, not a feature flag: it reads a var
   * no deployed environment sets, so the deployed default is "run". See its doc
   * in src/lib/corpus.ts for why the harness turns it off rather than pointing
   * it at a stub -- short version, the harness's Vectorize is a local simulation
   * and a green run against one would prove nothing.
   */
  scheduled(_controller, env, ctx) {
    const corpus = corpusEnv(env);
    if (corpusRefreshEnabled(corpus)) ctx.waitUntil(refreshCorpus(corpus));
  },
} satisfies ExportedHandler<McpEnv>;
