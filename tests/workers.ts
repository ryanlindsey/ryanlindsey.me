/**
 * Shared `createTestHarness` worker inputs. Every suite that boots the site
 * uses these, so the reasoning below lives in one place rather than five.
 */

/**
 * A host that resolves nowhere, standing in for the site's own origin.
 *
 * SITE_ORIGIN is what the Browser Run job navigates to, and it is a var rather
 * than something derived from `request.url` because
 * `--infer-origin-from-routes` defaults to true: with the custom-domain route
 * in wrangler.jsonc, `request.url` inside the Worker reads as
 * https://ryanlindsey.me/... even here. Overriding it to a sentinel is what
 * makes tests/resume-pdf.test.ts able to tell the two apart.
 */
export const TEST_SITE_ORIGIN = 'http://resume-pdf.test';

/**
 * The site Worker, booted from the ADAPTER'S BUILD OUTPUT rather than from the
 * repo's own ./wrangler.jsonc. That changed in day 3 Task 5. Until then the
 * site was assets-only: ./wrangler.jsonc had no `main`, so the harness had
 * nothing to bundle and could read the source config directly.
 *
 * ./wrangler.jsonc now sets `main: ./src/worker.ts`, which imports `handle`
 * from @astrojs/cloudflare/handler, which in turn imports virtual modules
 * (`virtual:astro-cloudflare:config`, `virtual:astro:app`, `astro:assets`)
 * that only exist inside Astro's own build. Pointed at the source config, the
 * harness tries to bundle that entry with esbuild and fails on all of them.
 *
 * `astro build` writes dist/server/wrangler.json with `main: entry.mjs` and
 * `no_bundle: true`, and records it in .wrangler/deploy/config.json -- which is
 * the config `wrangler deploy` itself resolves. Pointing the harness at the
 * same file means these tests exercise the artifact that ships rather than a
 * second build of the same sources. `npm test` is `astro build && vitest run`,
 * so it always exists by the time a suite starts.
 *
 * The BROWSER override and the 'stub' renderer are applied here, not only in
 * the PDF suite, so that NO test in this repo can reach a real browser binding.
 * Miniflare's Browser Run plugin is real and credential-free, but its first run
 * downloads 150-200 MB of Chrome-for-Testing, which has no place on a required
 * CI path -- and the way that would happen is some future test fetching
 * /resume.pdf without thinking about it.
 */
export const SITE_WORKER = {
  configPath: './dist/server/wrangler.json',
  vars: { SITE_ORIGIN: TEST_SITE_ORIGIN, RESUME_PDF_RENDERER: 'stub' },
  bindingOverrides: { BROWSER: 'mock-browser' },
};

/**
 * The MCP Worker is listed alongside the site in every harness that boots the
 * site: the site's `MCP` service binding names it, and workerd refuses to start
 * a Worker whose service binding names an undefined service.
 */
export const MCP_WORKER = { configPath: './workers/mcp/wrangler.jsonc' };

/** The Browser Run stand-in the override above resolves. Test-only, never deployed. */
export const MOCK_BROWSER_WORKER = { configPath: './workers/mock-browser/wrangler.jsonc' };

/**
 * All three, in the order every suite wants them: the site first, so it is the
 * primary Worker that relative `server.fetch()` URLs address and the one
 * `server.getWorker()` returns unnamed.
 */
export const SITE_HARNESS_WORKERS = [SITE_WORKER, MCP_WORKER, MOCK_BROWSER_WORKER];
