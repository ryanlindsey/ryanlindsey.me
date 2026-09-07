/**
 * Shared `createTestHarness` worker inputs. Every suite that boots the site
 * uses these, so the reasoning below lives in one place rather than five.
 */

/**
 * A host that resolves nowhere, standing in for the site's own origin.
 *
 * SITE_ORIGIN is what the Browser Run job navigates to, and it is a var rather
 * than something derived from `request.url` because
 * `--infer-origin-from-routes` defaults to true: under `wrangler dev` and in
 * production, the custom-domain route in wrangler.jsonc makes `request.url`
 * inside the Worker read as https://ryanlindsey.me/... A render URL derived
 * from it would make local dev silently render production.
 *
 * NOT here, though: `createTestHarness` sets `inferOriginFromRoutes: false`
 * (wrangler-dist/cli.js), so under this harness `request.url` is the loopback
 * address. So these tests cannot reproduce the production hazard -- what
 * overriding SITE_ORIGIN to a sentinel buys is that the assertion in
 * tests/resume-pdf.test.ts still catches a swap to `request.url`, because the
 * loopback host is not this sentinel either.
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
 *
 * The AI override that used to sit here has gone WITH the binding, to
 * MCP_WORKER below. ./wrangler.jsonc no longer declares `ai` at all: an
 * always-remote binding in the site's config made `astro build` open that proxy
 * session one layer earlier than the harness, which is the failure that broke
 * CI. There is nothing left on this Worker to override, and an override naming a
 * binding this config does not have would be a comment pretending to be code.
 */
export const SITE_WORKER = {
  configPath: './dist/server/wrangler.json',
  vars: { SITE_ORIGIN: TEST_SITE_ORIGIN, RESUME_PDF_RENDERER: 'stub' },
  bindingOverrides: { BROWSER: 'mock-browser' },
};

/**
 * The MCP Worker, which is where the `ai` and `vectorize` bindings and the
 * corpus cron now live.
 *
 * It is listed alongside the site in every harness that boots the site: the
 * site's `MCP` service binding names it, and workerd refuses to start a Worker
 * whose service binding names an undefined service.
 *
 * The AI override moved here with the binding, for exactly the reason it existed
 * on the site: Workers AI has no local emulator, so an `ai` binding with no
 * explicit `remote` is remote, and booting this Worker would try to open a real
 * remote proxy session -- which fails on "More than one account available but
 * unable to select one in non-interactive mode". Pointing the binding at a local
 * service Worker means no remote session is opened at all. See
 * workers/mock-ai/wrangler.jsonc for why this is not `"remote": false` instead.
 * Any harness that lists this Worker must therefore list MOCK_AI_WORKER too.
 *
 * `CORPUS_REFRESH: 'off'` (day 3 Task 15) follows from that AI override and from
 * one more fact: an unset `remote` resolves the OPPOSITE way for `vectorize`
 * than it does for `ai`, so `env.VECTORIZE` under this harness is a LOCAL
 * SIMULATION rather than `ryanlindsey-me-corpus`. Running the embedding job here
 * would therefore need a stub embedder feeding a simulated index, and would
 * report success while the real corpus stayed empty -- a green run that proves
 * nothing, which is the specific failure this repo has now been bitten by often
 * enough to name. So the job does not run here. Its pure half (the chunker, the
 * source list, the hash, the refresh plan) is covered directly in
 * tests/corpus.test.ts with no bindings at all; its embed/upsert/query round
 * trip is verified by hand against the live index.
 */
export const MCP_WORKER = {
  configPath: './workers/mcp/wrangler.jsonc',
  vars: { CORPUS_REFRESH: 'off' },
  bindingOverrides: { AI: 'mock-ai' },
};

/** The Browser Run stand-in the override above resolves. Test-only, never deployed. */
export const MOCK_BROWSER_WORKER = { configPath: './workers/mock-browser/wrangler.jsonc' };

/** The Workers AI stand-in the override above resolves. Test-only, never deployed. */
export const MOCK_AI_WORKER = { configPath: './workers/mock-ai/wrangler.jsonc' };

/**
 * All four, in the order every suite wants them: the site first, so it is the
 * primary Worker that relative `server.fetch()` URLs address and the one
 * `server.getWorker()` returns unnamed.
 */
export const SITE_HARNESS_WORKERS = [SITE_WORKER, MCP_WORKER, MOCK_BROWSER_WORKER, MOCK_AI_WORKER];
