import { createMcpHandler } from 'agents/mcp/server';
import { corpusRefreshEnabled, refreshCorpus, type CorpusEnv } from '../../../src/lib/corpus';
import { buildMcpDiscovery, buildMcpRobotsTxt } from '../../../src/lib/mcp/discovery';
import { handleChat } from './chat';
import { resolveGrant } from '../../../src/lib/tier/grant';
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
 * DAY 5 RE-READ THIS, as the paragraph above told it to, and it still holds --
 * but only because of a choice made to keep it holding. Scoped tokens have
 * arrived. `bearerFrom` (src/lib/tier/grant.ts) reads a token from the
 * `Authorization` header and from NOWHERE else -- not a cookie, not a query
 * parameter -- and `resolveGrant` runs per request with no cache keyed on the
 * origin or on the token string. So the property this opening rests on is
 * unchanged: a token is presented EXPLICITLY by a client that already had it,
 * and there is still no ambient credential for a hostile page to borrow.
 * tests/tier-invisibility.test.ts (Task 16) pins half of that structurally
 * rather than trusting the next edit to remember it: it fails if the word
 * `cookie` appears in the CODE of this file, of src/lib/tier/grant.ts, or of
 * ./define.ts -- comments may still discuss the word, which is how this one
 * does.
 *
 * THE CONDITION IS UNCHANGED. If a token is ever accepted from a cookie, or a
 * resolved grant is ever cached per origin, this setting becomes a real
 * cross-origin read of gated data and must change in the same commit. The
 * obligation transfers rather than expires.
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

    // Day 6 (04 §1): grounded chat. Routed here for the same reason
    // /.well-known/mcp.json is -- HANDLER_OPTIONS answers exactly `/mcp` and
    // 404s everything else it sees. It lives on THIS Worker rather than the
    // site because it needs `ai` and `vectorize`, and those bindings cannot
    // exist in a config `astro build` instantiates (see both wrangler.jsonc
    // files for the CI failure that settled it).
    if (pathname === '/chat') return handleChat(request, env, ctx);

    return createMcpHandler(
      // ASYNC, and the factory's contract permits it: `McpServerFactory` is
      // `(ctx) => McpServer | Server | Promise<McpServer | Server>` -- READ
      // from @modelcontextprotocol/server 2.0.0's own declaration, the type
      // agents@0.22.0's `createMcpHandler` takes, and exercised end to end in
      // tests/tier-grant.test.ts rather than trusted.
      //
      // The grant is resolved HERE, once per HTTP request, rather than inside
      // a tool -- so every tool and every resource in one request sees the
      // same tier, and one D1 read serves the whole batch. That factory doc
      // is explicit about the unit and about the one exception, which is not
      // ours: "one serving unit: one HTTP request under createMcpHandler, or
      // one connection (or one discarded `server/discover` probe) under
      // serveStdio" (createMcpHandler-CLhGwQTn.d.mts:3801-3808). The probe
      // belongs to `serveStdio`; this Worker serves HTTP and never calls it.
      async (mcpCtx) => {
        const httpRequest = mcpCtx.requestInfo ?? request;
        const { grant, refusal } = await resolveGrant(
          env,
          httpRequest,
          Math.floor(Date.now() / 1000),
        );
        if (refusal !== null) {
          // Logged, not answered with an error: a stale token should still get
          // the public tier rather than a broken connection.
          //
          // The log line names the REASON -- every member of `GrantRefusal`
          // (src/lib/tier/grant.ts), whichever one was reached; what the
          // caller is told does not. That asymmetry is the whole design: an
          // operator running a revocation drill (09 §3 item 6) reads this line
          // and knows exactly which check bit, while the holder gets one
          // unspecific sentence that is no use for probing which state a token
          // string is in.
          //
          // Deliberately NOT a list of those members. An earlier draft of this
          // comment wrote out five of them and then called them "those four
          // states" -- wrong twice over, since `GrantRefusal` is `TokenFailure`
          // plus three and has seven. A hand-copied enumeration in a comment
          // rots the first time a member is added, and it rots in the place an
          // operator reading a drill's output would trust it. The type is the
          // list.
          console.warn(`mcp/grant: refused a presented token (${refusal})`);
        }
        // `refusal` is passed rather than dropped, and that second argument is
        // the only thing that makes a refusal visible to the CALLER rather
        // than only in the log above -- `buildInstructions` (./server.ts) has
        // no other source for it, because the grant it would otherwise infer
        // from is `null` for a refused token and for an ordinary public caller
        // alike. Those two must not be told the same thing.
        return createServer({ env, ctx, request: httpRequest, grant }, refusal);
      },
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
