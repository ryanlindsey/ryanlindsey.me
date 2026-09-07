import { createMcpHandler } from 'agents/mcp/server';
import { corpusRefreshEnabled, refreshCorpus, type CorpusEnv } from '../../../src/lib/corpus';
import { type McpEnv } from './env';
import { createServer } from './server';

/**
 * The corpus job's view of this Worker, assembled explicitly rather than spread
 * from `env` -- `SITE` is not a binding and could not come from one.
 *
 * The site Worker used to hand `refreshCorpus` its own `ASSETS` binding. This
 * Worker has no assets, and giving it a copy of the site's would mean uploading
 * the whole site twice and rebuilding it before every MCP deploy, so the
 * documents are read over the public origin instead. `mcp.ryanlindsey.me` and
 * `ryanlindsey.me` are different hostnames on different Workers, so this is an
 * ordinary subrequest to the site rather than a fetch that could loop back into
 * this Worker.
 *
 * Wrapped in an arrow rather than passed as `{ fetch }`: global `fetch` is not
 * a method of anything here, and handing it over as a bare reference is the kind
 * of unbound-`this` hazard that costs an hour when it does bite.
 */
function corpusEnv(env: McpEnv): CorpusEnv {
  return {
    SITE: { fetch: (input, init) => fetch(input, init) },
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
