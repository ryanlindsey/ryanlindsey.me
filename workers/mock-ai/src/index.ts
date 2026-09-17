/**
 * Test-only stand-in for the TWO always-remote bindings on the MCP Worker:
 * `ai` and, since issue #144, `ai_search`. See wrangler.jsonc in this directory
 * for why it exists and how it is wired.
 *
 * It emulates NOTHING, deliberately. Its entire job is to be a LOCAL service
 * that an always-remote binding can resolve to, so that booting a Worker under
 * the test harness does not open a remote proxy session against the real
 * account. Nothing in the suite calls `env.AI` or `env.AI_SEARCH` today.
 *
 * Answering everything with 501 rather than a plausible empty embedding is the
 * point: a future test that reaches one of those bindings should fail loudly
 * and say why, not receive a well-formed vector of zeros and go on to assert
 * something untrue about similarity.
 *
 * Note what this override is NOT. `bindingOverrides` installs a *service*
 * binding, which hands the Worker a `Fetcher`, not an `Ai` -- so `env.AI.run()`
 * is a TypeError here before it is ever a 501. That is the intended shape, and
 * it is why this file does not try to parse a model name or return a vector.
 * Code that needs its embedding path exercised should inject a fake at the call
 * site -- the way every seam var in this repo does, and the way
 * `RESUME_PDF_RENDERER: 'stub'` did for the résumé PDF until #186 deleted the
 * renderer -- rather than asking this Worker to impersonate Workers AI.
 *
 * SHARPENED 2026-09-17 (issue #144), because the sentence above is true of the
 * CALL and was quietly read as true of the property, which is how a guard gets
 * written that does not guard. A `Fetcher` answers every property access with
 * an RPC stub, so `typeof env.AI.run` is `'function'` here, not `undefined`,
 * and the TypeError arrives only when the returned promise is awaited:
 *   await env.AI_SEARCH.search({ query: 'turnstile' })
 *   -> TypeError: The RPC receiver does not implement the method "search".
 * Measured from inside a Worker and again through `getEnv()`. So code asking
 * "is the real service reachable here" must ask a var rather than probe the
 * binding, which is what every `*_ENGINE` and `*_MODE` seam in this repo is
 * for.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    return new Response(
      `mock-ai emulates neither Workers AI nor AI Search. A test reached a ` +
        `binding overridden to this Worker (${request.method} ${pathname}). ` +
        `Inject a fake at the call site instead.\n`,
      { status: 501 },
    );
  },
};
