/**
 * Test-only stand-in for the Workers AI binding. See wrangler.jsonc in this
 * directory for why it exists and how it is wired.
 *
 * It emulates NOTHING, deliberately. Its entire job is to be a LOCAL service
 * that the site's `AI` binding can resolve to, so that booting the site under
 * the test harness does not open a remote proxy session against the real
 * account. Nothing in the suite calls `env.AI` today.
 *
 * Answering everything with 501 rather than a plausible empty embedding is the
 * point: a future test that reaches for `env.AI` should fail loudly and say
 * why, not receive a well-formed vector of zeros and go on to assert something
 * untrue about similarity.
 *
 * Note what this override is NOT. `bindingOverrides` installs a *service*
 * binding, which hands the Worker a `Fetcher`, not an `Ai` -- so `env.AI.run()`
 * is a TypeError here before it is ever a 501. That is the intended shape, and
 * it is why this file does not try to parse a model name or return a vector.
 * Code that needs its embedding path exercised should inject a fake at the call
 * site, the way `RESUME_PDF_RENDERER: 'stub'` does for the PDF path, rather
 * than asking this Worker to impersonate Workers AI.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    return new Response(
      `mock-ai does not emulate Workers AI. A test reached the AI binding ` +
        `(${request.method} ${pathname}). Inject a fake at the call site instead.\n`,
      { status: 501 },
    );
  },
};
