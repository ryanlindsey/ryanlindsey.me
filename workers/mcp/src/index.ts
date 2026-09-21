import { createMcpHandler } from 'agents/mcp/server';
import { recordAgentEvent } from '../../../src/lib/agent-intel/record';
import { corpusRefreshEnabled, refreshCorpus, type CorpusEnv } from '../../../src/lib/corpus';
import { CORPUS_CRON, evalsRunEnabled, suitesForCron } from '../../../src/lib/evals/plan';
import { buildMcpDiscovery, buildMcpRobotsTxt } from '../../../src/lib/mcp/discovery';
import { forwardedBySite } from '../../../src/lib/mcp/via';
import { buildMcpServerCard } from '../../../src/lib/discovery/server-card';
import { buildProtectedResource } from '../../../src/lib/discovery/protected-resource';
import { handleChat } from './chat';
import { handleGrantContext } from './grant-context';
import { mcpAgentEvent } from './mcp-agent-event';
import { handleSiteSearch } from './search';
import { resolveGrant } from '../../../src/lib/tier/grant';
import { type McpEnv } from './env';
import { MCP_ORIGIN } from './origin';
import { createServer } from './server';

// The rate limiter's Durable Object (03 §3), re-exported from this module
// because a DO class has to be exported from the Worker's ENTRYPOINT to be
// instantiable -- `class_name` in wrangler.jsonc is looked up on the module
// `main` names, not on the file that happens to define it. Defining it in
// ./rate-limiter.ts and forgetting this line is a deploy that fails on "Class
// RateLimiter not found", which is at least loud; the quiet failure it
// replaces is #29's, so see that file for why the limiter is an object at all.
export { RateLimiter } from './rate-limiter';

// The scheduled eval run's Workflow class (issue #291), re-exported for
// exactly the reason the Durable Object above is: `class_name` in
// wrangler.jsonc's `workflows` entry is looked up on the module `main` names,
// not on the file that defines the class. Defining it in ./evals-workflow.ts
// and forgetting this line deploys a Worker whose weekly cron cannot start
// anything.
export { EvalsWorkflow } from './evals-workflow';

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
 * Issue #170 (epic #165, "agent readiness"): this origin's own `Link` header,
 * set in code because `public/_headers` -- the site's mechanism for the same
 * header -- does not apply here at all; it decorates only responses the SITE
 * Worker's asset server serves, and none of this Worker's responses come from
 * one.
 *
 * Two relations, not the site's four: this origin serves no API catalog and
 * no agent skills index -- `api-catalog` and `describedby` would each name a
 * document this origin returns 404 for, the exact failure mode the epic's
 * global constraints call worse than no header at all. `service-desc` points
 * at THIS origin's own server-card branch below (MCP_ORIGIN-absolute, per the
 * global constraint that a builder takes its origin as an argument rather than
 * reading `request.url`); `service-doc` points at the site's own /llms.txt,
 * since this Worker publishes no service document of its own.
 *
 * `service-doc`'s target is SITE-absolute, not `MCP_ORIGIN`-absolute -- task
 * 6's brief literally says "MCP_ORIGIN-absolute targets" for this whole
 * header, and this one line does not fit that sentence. Deliberate anyway,
 * and not a drift from it: there is no document at this origin to be
 * MCP_ORIGIN-absolute ABOUT, and pointing a `service-doc` relation at
 * something this origin does not serve would be the exact 404 problem this
 * whole header exists to avoid. `src/lib/mcp/discovery.ts`'s own
 * `buildMcpDiscovery` already sets this same precedent (its `documentation`
 * field is this identical literal, on THIS origin's `/.well-known/mcp.json`
 * response), so this is the second instance of an existing pattern, not a
 * new one.
 */
function discoveryLinkHeader(): string {
  return [
    `<${MCP_ORIGIN}/.well-known/mcp/server-card.json>; rel="service-desc"`,
    `<https://ryanlindsey.me/llms.txt>; rel="service-doc"`,
  ].join(', ');
}

/**
 * The server itself is built in ./server.ts, one instance per HTTP request:
 * `createMcpHandler` is stateless, and `defineTool` needs `env`, `ctx` and
 * the original request in scope to limit and audit the call. `requestInfo`
 * is the SDK's own handle on that request and is preferred over the
 * closed-over `request` for exactly the case where they differ -- a legacy
 * fallback instance the handler constructs for a request of its own.
 */
async function dispatch(request: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response> {
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
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Link: discoveryLinkHeader(),
      },
    });
  }

  // Issue #166 (epic #165, "agent readiness"): the MCP Server Card
  // (SEP-1649), this origin's own copy -- same reasoning as the
  // `/.well-known/mcp.json` branch immediately above, and it has to sit
  // here for the same reason: HANDLER_OPTIONS answers exactly `route:
  // '/mcp'` and 404s everything else it sees.
  if (pathname === '/.well-known/mcp/server-card.json') {
    return new Response(JSON.stringify(buildMcpServerCard(MCP_ORIGIN), null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Link: discoveryLinkHeader(),
      },
    });
  }

  // Issue #167 (epic #165, "agent readiness"): RFC 9728 protected-resource
  // metadata, served from THIS origin because it is where MCP's own
  // authorization discovery sends a client -- an agent that reached
  // mcp.ryanlindsey.me and wants to know what a bearer token here would
  // unlock looks for this document on THIS origin, not on ryanlindsey.me,
  // which independently serves the same document SHAPE describing ITS OWN
  // `/mcp` (src/pages/.well-known/oauth-protected-resource.ts) -- not a
  // copy of this one. `buildProtectedResource` takes the serving origin
  // and derives `resource` from it (epic-165 follow-up review, finding B):
  // RFC 9728 §2 requires `resource` to identify the origin a client
  // fetched the document FROM, so the two origins' copies cannot share one
  // hard-coded value without one of them failing that validation. Same
  // reason it has to sit here rather than fall through to
  // createMcpHandler: HANDLER_OPTIONS answers exactly `route: '/mcp'` and
  // 404s everything else it sees. `/auth.md`, the prose half, stays
  // site-only -- there is no reason for this Worker to carry a second copy
  // of static markdown it does not otherwise serve.
  if (pathname === '/.well-known/oauth-protected-resource') {
    return new Response(JSON.stringify(buildProtectedResource(MCP_ORIGIN), null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Link: discoveryLinkHeader(),
      },
    });
  }

  // Day 6 (04 §1): grounded chat. Routed here for the same reason
  // /.well-known/mcp.json is -- HANDLER_OPTIONS answers exactly `/mcp` and
  // 404s everything else it sees. It lives on THIS Worker rather than the
  // site because it needs `ai` and `vectorize`, and those bindings cannot
  // exist in a config `astro build` instantiates (see both wrangler.jsonc
  // files for the CI failure that settled it).
  if (pathname === '/chat') return handleChat(request, env, ctx);

  // `GET /search` (issue #146, epic #143), routed here for the same reason
  // `/chat` is -- HANDLER_OPTIONS answers exactly `/mcp` and 404s everything
  // else it sees. It lives on THIS Worker because the `ai_search` binding
  // cannot exist in a config `astro build` instantiates: #144 measured that
  // wrangler classifies it exactly as it classifies `ai`, so declaring it
  // opens a remote proxy session at boot rather than at the call. The
  // retrieval, the spend, the cache and the rate limiter are all already
  // here too, so the site route is a renderer that holds none of them.
  if (pathname === '/search') return handleSiteSearch(request, env);

  // `POST /grant` (04 §2): what one bearer unlocks, answered here for the
  // same reason `/chat` is -- HANDLER_OPTIONS answers exactly `/mcp` and
  // 404s everything else it sees.
  //
  // A refusal returns `null` rather than a Response (see grant-context.ts's
  // own doc for why), and falls through to the `createMcpHandler` call at
  // the end of this function -- which answers the genuine unrouted 404 for
  // any path that is not `/mcp`, `/grant` included. That fallthrough is
  // cheap: agents@0.23.0's `serve` checks `requestUrl.pathname !== route`
  // before it does anything else, so a refused `/grant` never reaches the
  // async factory below and never calls `resolveGrant` a second time.
  if (pathname === '/grant') {
    const granted = await handleGrantContext(request, env);
    if (granted !== null) return granted;
    // fall through: the MCP handler below IS the unrouted 404
  }

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
}

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const response = await dispatch(request, env, ctx);
    // ONE row per DIRECT `/mcp` request, and no other path on this Worker.
    // `/chat` and `/search` write their own rows inside their handlers with
    // their own surfaces, the discovery documents write none, and a `/mcp`
    // the site forwarded is already the site's row (src/lib/mcp/via.ts).
    // After the response so `status` is the real one, as src/worker.ts does.
    //
    // "DIRECT" INCLUDES THIS SYSTEM'S OWN TRAFFIC, which the paragraph above
    // does not say and a reader would otherwise have to discover from the
    // panel. Two first-party callers reach `/mcp` unmarked, both READ OFF
    // THEIR CALL SITES on 2026-09-20 rather than measured on /ops:
    //
    //   - the scheduled eval run, over the `SELF` binding. Every `/mcp` call
    //     it makes goes through ./evals-client.ts's `rpc`; `runTierCase`
    //     (./evals-run.ts) alone is four requests per case plus one per
    //     argumentless tool, daily. `ask` targets `/chat` instead, so the
    //     chat and leak suites land on that surface, not this one.
    //   - each `analyze_fit` the site runs, over its own `MCP` binding
    //     (src/lib/fit/client.ts's `rpc`). `grantContext` there targets
    //     `/grant` and so writes nothing here.
    //
    // Both send a `ryanlindsey-me-` user agent, so `FIRST_PARTY`
    // (src/lib/agent-intel/classify.ts) labels them agent `first-party` with
    // `agentClass: 'agent'` -- which is exactly what /ops's agent breakdown
    // groups by, so they appear there under that name.
    //
    // KEPT, DELIBERATELY. Ruling 1, quoted in ./chat.ts's `firstOfSession`
    // doc, is that the AE row stays UNCONDITIONAL so evals and every direct
    // caller stay visible in /ops, and a filter here would be the first thing
    // on this path deciding whose traffic counts as real. What that costs is
    // worth naming rather than leaving to be found: the two halves of /ops
    // disagree about first-party traffic. Its D1 metrics exclude the EVAL
    // runner in SQL (src/lib/ops/metrics.ts, the `EVALS_AGENT` prefix and
    // `EVALS_SURFACE`) and do not exclude the fit caller; its Analytics
    // Engine panels (src/lib/ops/analytics.ts) exclude neither, and have no
    // equivalent filter. So a "did the panel move after my call" check can be
    // satisfied by this Worker's own housekeeping: read the `first-party` row
    // before believing a visitor moved it.
    if (new URL(request.url).pathname === '/mcp' && !forwardedBySite(request)) {
      recordAgentEvent(env, mcpAgentEvent(request, response.status, Date.now() - started));
    }
    return response;
  },

  /**
   * This Worker's cron jobs (`triggers.crons` in wrangler.jsonc): the corpus
   * refresh at 05:32, and the eval suites at 05:52 daily and 07:07 on Mondays.
   *
   * IT BRANCHES ON `controller.cron` NOW, AND THAT IS A REAL CHANGE TO AN
   * EXISTING PATH. Until issue #291 this handler ran the corpus refresh for
   * EVERY trigger, which was correct only because there was one -- and which
   * would have quietly re-embedded the whole corpus twice more a week the
   * moment a second expression was declared. tests/site-crons.test.ts's own
   * comment named this Worker as the one that did not need a cron switch "the
   * day it gains a second trigger", and this is that day;
   * tests/evals-schedule.test.ts pins the pair from both ends.
   *
   * The mapping from an expression to the suites it asks for lives in
   * src/lib/evals/plan.ts rather than here, because evals/run.mjs's own
   * ordering (`leak` last, deliberately) and the cron constants are the same
   * facts, and a second copy of either would be a second thing to keep in step.
   *
   * The publishing corpus's embedding refresh (Task 15), below, is unchanged
   * apart from the guard that now precedes it.
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
  scheduled(controller, env, ctx) {
    if (controller.cron === CORPUS_CRON) {
      const corpus = corpusEnv(env);
      if (corpusRefreshEnabled(corpus)) ctx.waitUntil(refreshCorpus(corpus));
      return;
    }

    const suites = suitesForCron(controller.cron);
    if (suites.length === 0) {
      // The same arm src/worker.ts's cron switch carries, and for the same
      // reason: a trigger that fires with no job registered is a deploy that
      // succeeded and does nothing, which is otherwise silent forever.
      console.error(`scheduled: no job is registered for the cron "${controller.cron}"`);
      return;
    }

    // ORDER MATTERS: `evalsRunEnabled` THROWS on an unrecognised value, so it
    // is asked only once a cron has actually asked for a suite. A typo in the
    // seam should surface on the trigger it disables, not on the corpus
    // refresh that has nothing to do with it.
    if (evalsRunEnabled(env)) {
      ctx.waitUntil(env.EVALS_WORKFLOW.create({ params: { suites } }));
    }
  },
} satisfies ExportedHandler<McpEnv>;
