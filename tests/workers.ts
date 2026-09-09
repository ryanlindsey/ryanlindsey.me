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
 * one more fact about `env.VECTORIZE` here: whatever it is, it is not
 * `ryanlindsey-me-corpus`. Running the embedding job here would therefore need
 * a stub embedder feeding something that is not the real index, and would
 * report success while the real corpus stayed empty -- a green run that proves
 * nothing, which is the specific failure this repo has now been bitten by often
 * enough to name. So the job does not run here. Its pure half (the chunker, the
 * source list, the hash, the refresh plan) is covered directly in
 * tests/corpus.test.ts with no bindings at all; its embed/upsert/query round
 * trip is verified by hand against the live index.
 *
 * Day 3 wrote that sentence as "`env.VECTORIZE` is a LOCAL SIMULATION", from
 * workers/mcp/wrangler.jsonc's note on `vectorize` defaulting to local. Day 4
 * Task 9 MEASURED it and it is not: `env.VECTORIZE.query(...)` under this
 * harness throws `Binding VECTORIZE needs to be run remotely`, from inside the
 * Worker as well as through `getEnv()`. There is no index here at all, empty or
 * otherwise. That strengthens the conclusion above rather than changing it, and
 * the correction is written out in full in wrangler.jsonc beside the binding.
 *
 * `MCP_SEARCH_EMBEDDER: 'stub'` (day 4 Task 9) is the same seam pointed at the
 * read side of that corpus. `search_writing` is a tool rather than a cron job,
 * so it DOES run here -- but its embedding call cannot, for exactly the reason
 * above: the `AI` override is a SERVICE binding, so `env.AI` is a `Fetcher`
 * and `env.AI.run()` is a TypeError rather than a response. Under the stub the
 * tool skips the embedding call and queries with a fixed vector.
 *
 * Given the throw, `search_writing` cannot complete here at ANY setting of this
 * var, and a test asserting on retrieved citations would be asserting on a
 * thrown binding. What the stub still buys is that the failure lands at the
 * Vectorize call with a well-formed query rather than one step earlier at a
 * TypeError on `env.AI`, so the query-shaping code is on the executed path and
 * the tool goes green with no test edit the day a usable Vectorize exists here.
 *
 * The query-side embedding call is asserted at the call site in
 * tests/mcp-search.test.ts with a stub `Ai`, which is what workers/mock-ai's
 * doc comment asks for instead of teaching that Worker to impersonate Workers
 * AI. The retrieval round trip is verified by hand against the live index.
 *
 * `SITE_ORIGIN: TEST_SITE_ORIGIN` is overridden here as of issue #28, and it was
 * NOT before -- measured while writing that fix, not inferred:
 * tests/mcp.smoke.test.ts booted this Worker and `getEnv().SITE_ORIGIN` read
 * `https://ryanlindsey.me`, straight out of workers/mcp/wrangler.jsonc. It never
 * mattered, because no suite that booted this Worker WITHOUT overriding the var
 * also read a document -- the one that does (tests/mcp-tools.test.ts) sets it to
 * the harness's own measured address in `beforeAll`, and still does. But "it
 * never mattered" was a property of which tests happened to exist, and the
 * failure it was one test away from is the worst kind: a suite quietly reading
 * the LIVE PRODUCTION SITE and passing because production agrees with the
 * fixture. The sentinel makes that impossible by default and leaves any
 * deliberate override to say so out loud. Since #28 it does a second job in
 * tests/mcp.smoke.test.ts: a document read that succeeds against an origin
 * resolving nowhere is the proof that the read is a binding and not a fetch.
 */
export const MCP_WORKER = {
  configPath: './workers/mcp/wrangler.jsonc',
  vars: {
    CORPUS_REFRESH: 'off',
    MCP_SEARCH_EMBEDDER: 'stub',
    SITE_ORIGIN: TEST_SITE_ORIGIN,
    /**
     * Day 5's signing-key seam (src/lib/tier/grant.ts's `signingKey`). Same
     * shape and the same reasoning as `CORPUS_REFRESH` and
     * `MCP_SEARCH_EMBEDDER` above: no deployed config declares this var, an
     * unrecognised value throws, and `'test'` selects a committed constant
     * that says in its own name it is not a secret.
     *
     * It exists because miniflare simulates `secrets_store_secrets` against a
     * LOCAL store that credential-free CI has never populated, so
     * `env.RLME_TOKEN_SIGNING_KEY.get()` throws here. Without this, no gated
     * test could run without account access.
     */
    RLME_TOKEN_KEY_SOURCE: 'test',
  },
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

/**
 * The same four Workers with the MCP Worker FIRST, for a suite whose subject is
 * the MCP Worker and which therefore wants it as the primary one.
 *
 * The list used to be `[MCP_WORKER, MOCK_AI_WORKER]` in tests/mcp.smoke.test.ts,
 * and the site's absence there was not an oversight -- nothing in that suite
 * read a document. Day 4 issue #28's fix makes the site MANDATORY for every
 * harness that boots the MCP Worker: `workers/mcp/wrangler.jsonc` now declares a
 * `SITE` service binding naming `ryanlindsey-me`, and workerd refuses to start a
 * Worker whose service binding names an undefined service. That is the exact
 * mirror of the constraint the `MCP_WORKER` comment above already records in the
 * other direction, and the two together are a deliberate binding CYCLE (site ->
 * MCP for the `/mcp` forward, MCP -> site for document reads). Cycles are legal:
 * a service binding is resolved when it is called rather than when the Worker is
 * defined, so the graph never has to be topologically sorted. Measured here --
 * this harness boots both Workers with the cycle in place. There is no runtime
 * loop either: the MCP Worker only ever asks the site for `/llms.txt`,
 * `/resume.json` and `/{writing,work}/*.md`, never `/mcp`.
 *
 * MOCK_BROWSER_WORKER comes along because SITE_WORKER's `bindingOverrides` names
 * it, by the same rule.
 */
export const MCP_HARNESS_WORKERS = [MCP_WORKER, SITE_WORKER, MOCK_BROWSER_WORKER, MOCK_AI_WORKER];
