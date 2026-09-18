/**
 * Shared `createTestHarness` worker inputs. Every suite that boots the site
 * uses these, so the reasoning below lives in one place rather than five.
 */

/**
 * A host that resolves nowhere, standing in for the site's own origin.
 *
 * It is named for the route that first needed it: SITE_ORIGIN was what the
 * Browser Run job navigated to, a var rather than something derived from
 * `request.url` because `--infer-origin-from-routes` defaults to true -- under
 * `wrangler dev` and in production the custom-domain route in wrangler.jsonc
 * makes `request.url` inside the Worker read as https://ryanlindsey.me/..., and
 * a render URL derived from it would have made local dev render production.
 * `createTestHarness` sets `inferOriginFromRoutes: false`, so this harness never
 * could reproduce that hazard; the sentinel was what let tests/resume-pdf.test.ts
 * catch a swap to `request.url` anyway, because the loopback host is not this
 * host either.
 *
 * #186 deleted that renderer, and the site Worker now reads SITE_ORIGIN nowhere
 * at all. This value still matters for the MCP Worker below, which reads it on
 * every citation URL it builds -- and it stays UNROUTABLE on purpose there, so
 * that a document read escaping the `SITE` service binding onto the public
 * internet fails rather than quietly succeeding (tests/mcp.smoke.test.ts).
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
 * THIS WORKER NOW HAS NO BINDING OVERRIDES, and the one it had is worth a note
 * because its absence looks like an omission. `BROWSER` was overridden to a
 * mock Worker so that NO test in this repo could reach a real browser binding:
 * miniflare's Browser Run plugin is real and credential-free, but its first run
 * downloads 150-200 MB of Chrome-for-Testing, which has no place on a required
 * CI path -- and the way that would have happened is some future test fetching
 * /resume.pdf without thinking about it.
 *
 * #186 removed the renderer, so /resume.pdf is now an R2 read and there is no
 * code path left that can call the binding. The binding itself stays declared
 * (see wrangler.jsonc), but a mock in front of a binding nothing calls is a
 * moving part that protects nothing, so workers/mock-browser went with it.
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
  vars: {
    SITE_ORIGIN: TEST_SITE_ORIGIN,
    /**
     * Day 5 Task 12's siteverify seam (src/lib/turnstile.ts's
     * `verifyTurnstile`). No deployed config declares it, an unrecognised value
     * throws, and 'stub' is the only accepted value here -- the shape every
     * seam in this repo follows, and which `RESUME_PDF_RENDERER` carried until
     * #186 deleted the renderer it stood in front of.
     *
     * It exists because the harness has neither a populated local secrets
     * store (so `RLME_TURNSTILE_SECRET_KEY.get()` would throw, same failure
     * mode as `RLME_TOKEN_SIGNING_KEY` in tests/tier-grant.test.ts) nor
     * outbound network access to challenges.cloudflare.com. The real request
     * shaping this stub skips -- that `secret`, `response` and `remoteip` all
     * reach the wire correctly -- is asserted in tests/turnstile.test.ts with
     * an injected `fetch`, not here.
     */
    RLME_TURNSTILE_MODE: 'stub',
    /**
     * Day 6 Task 3's notification seam (src/lib/agent-intel/notify.ts's
     * `sendNotification`). The same shape as the two above: no deployed config
     * declares it, an unrecognised value throws, and 'stub' is the only
     * accepted value here.
     *
     * It exists for the same two reasons as `RLME_TURNSTILE_MODE` -- the
     * harness has no populated local secrets store, so
     * `RLME_NOTIFY_ADDRESS.get()` would throw, and it has no Email Routing
     * binding that can deliver. Under 'stub' the consumer runs its validation
     * and its batching and then stops before both, which is what keeps
     * `handleEventBatch`'s drop path reachable here while leaving the send
     * itself to Task 13's live check.
     */
    RLME_NOTIFY_MODE: 'stub',
    /**
     * Day 6 Task 10's /ops analytics seam (src/lib/ops/analytics.ts's
     * `readAnalytics`). The same shape as the three above: no deployed config
     * declares it, an unrecognised value throws, and 'stub' is the only
     * accepted value here.
     *
     * WHAT IT IS NOT FOR, said first because the obvious reading is wrong:
     * this seam is not what keeps the harness off the network. `readAnalytics`
     * reads the Secrets Store secret BEFORE it fetches and returns `null` from
     * that read's catch, and miniflare simulates `secrets_store_secrets`
     * against a local store nothing has populated, so `.get()` raises
     * `Secret "..." not found` here (measured in day 5 Task 2, recorded in
     * tests/tier-grant.test.ts). Without this var the harness would therefore
     * issue ZERO requests to api.cloudflare.com, not three -- an earlier
     * version of this comment claimed three, which the module's own order of
     * operations contradicts.
     *
     * WHAT IT IS FOR: keeping a future emulator release from turning this
     * credential-free suite into one that calls api.cloudflare.com, and pinning
     * the harness's /ops state at "not configured" by a var this repo controls
     * rather than as a side effect of how a simulated binding happens to fail.
     *
     * The `null` above is real but incidental: it depends on miniflare
     * continuing to THROW on an unpopulated store, which is emulator behaviour
     * nobody here owns. An emulator that answered a NON-EMPTY PLACEHOLDER
     * STRING instead -- the plausible alternative, since the point of a
     * simulated secret is to hand back something -- would pass `readToken`'s
     * `typeof`/non-empty check, and `readAnalytics` would then issue its three
     * real POSTs to api.cloudflare.com from CI, with a junk bearer token, plus
     * `readSpend`'s GraphQL POST as a fourth, without a line of this repo
     * changing. That is what this var buys, and it is why the seam earns its
     * place.
     *
     * `''` AND `undefined` WOULD NOT DO THAT, and an earlier version of this
     * sentence claimed they would "change which branch these tests take":
     * `readToken` returns `null` for both, so nothing observable moves. The
     * true justification is the placeholder-string one above; it was recorded
     * as the weaker, false one (final-review Minor 5). Under 'stub' the answer
     * comes from the first three lines of the function and cannot drift either
     * way.
     *
     * So what a page test under this harness sees is /ops's "not configured"
     * rendering, and that is the only /ops state any test in this repo
     * exercises. No test here calls the real service, and none ever should --
     * but the envelopes are no longer guesses to be tested against: both were
     * measured on 2026-09-11 (src/lib/ops/analytics.ts records the bodies), and
     * tests/ops-analytics.test.ts parses copies of the recorded responses
     * through an injected `fetch`, with everything else asserted to fail closed.
     */
    RLME_ANALYTICS_MODE: 'stub',
  },
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
 * `AI_SEARCH` IS OVERRIDDEN TO THE SAME MOCK, AND IT IS THE LEAST OPTIONAL
 * OVERRIDE IN THIS FILE. Issue #144 added the `ai_search` binding to find out
 * what it does to this harness, having assumed it would behave like
 * `VECTORIZE`: boot cleanly, throw when called. It does not. wrangler
 * classifies `ai_search` exactly as it classifies `ai` --
 * "DO-NOT-USE-this-resource-will-never-have-a-local-simulator" -- so declaring
 * it makes booting this Worker open a real remote proxy session, and the
 * failure is at startup rather than at the call. MEASURED 2026-09-17 with the
 * override removed: `npm test` went from 80 files green to 32 failed and 48
 * passed, which is every suite that boots this Worker and most that never
 * mention search. `"remote": false` does not help either, measured the same
 * day: wrangler's validator that would reject it sits on the `wrangler dev`
 * path, and this harness never reaches it, so the flag is ignored rather than
 * refused. The full measurement, including what the binding looks like under
 * this override, is beside the binding in workers/mcp/wrangler.jsonc.
 *
 * So the rule the `AI` override already implied is now a hard one: any harness
 * that boots this Worker must carry BOTH overrides, which is the argument for
 * every suite going through this file rather than assembling its own list.
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
    /**
     * Day 5's fit engine (src/lib/fit/engine.ts's `analyzeFit`), off. Same
     * shape as the three seams above, and the same cause as
     * `MCP_SEARCH_EMBEDDER: 'stub'`: the `AI` override below is a SERVICE
     * binding, so `env.AI` is a `Fetcher` here and `env.AI.run()` is a
     * TypeError rather than a response. The engine spends a frontier-model
     * call through AI Gateway, so there is a second reason as well -- a test
     * suite must not be one edit away from spending real money.
     *
     * Unlike the embedder stub, this one does not shape a call it cannot
     * complete: `analyzeFit` refuses on the seam before it reads the breaker,
     * the corpus or the model. That is deliberate and it is what makes
     * tests/mcp-gated.test.ts's limiter test affordable -- seven calls that
     * each cost a round trip and nothing else. Everything AROUND the model
     * call is exercised there; the call itself is exercised with a stub `Ai`
     * at the call site in tests/fit-engine.test.ts, which is what
     * workers/mock-ai's own doc comment asks for.
     */
    FIT_ENGINE: 'off',
    /**
     * Day 6's chat engine (src/lib/chat/engine.ts's `startAnswer`), off. The
     * same seam shape and the same cause as `FIT_ENGINE` above, doubled: the
     * `AI` override below is a service binding, so `env.AI.run()` is a
     * TypeError here, AND `VECTORIZE` throws `needs to be run remotely` under
     * miniflare -- so retrieval could not run even if the model could.
     *
     * `startAnswer` refuses on this seam AFTER its shape checks and before the
     * breaker, the corpus or the model. That order is load-bearing for
     * tests/chat-endpoint.test.ts: the `empty` and `too-long` refusals are
     * reachable there precisely because the seam is not checked first.
     */
    CHAT_ENGINE: 'off',
    /**
     * Day 6. `POST /chat` verifies its own bot check (workers/mcp/src/chat.ts),
     * so this Worker needs the same seam `SITE_WORKER` already carries and for
     * the same two reasons: the harness has no populated local secrets store,
     * and it has no outbound access to challenges.cloudflare.com.
     *
     * The stub still REFUSES AN ABSENT TOKEN -- `verifyTurnstile` checks for
     * one before the stub short-circuit, deliberately -- which is what keeps
     * the endpoint's `bot-check` branch reachable by a test rather than
     * hidden behind the seam.
     */
    RLME_TURNSTILE_MODE: 'stub',
    /**
     * Day 6's judge (src/lib/judge/engine.ts), off. Same seam shape and same
     * cause as `FIT_ENGINE` and `CHAT_ENGINE`: `env.AI` is a service binding
     * under the harness, so `env.AI.run()` is a TypeError. Under the seam,
     * `judge_answer` exercises the scope gate, the argument schema, the limiter
     * and the error shape; the model call is exercised only by `npm run evals`
     * against a deployed endpoint.
     */
    JUDGE_ENGINE: 'off',
    /**
     * Issue #146's `/search` handler (workers/mcp/src/search.ts), stubbed.
     * Same seam shape as the seven above, and the one whose absence would leave
     * a route with no executable path at all rather than merely an expensive
     * one: the `AI_SEARCH` override below is a SERVICE binding, so
     * `env.AI_SEARCH.search()` here is an RPC call into a Worker that does not
     * implement the method and throws at the await.
     *
     * `'stub'` rather than `'off'`, unlike `FIT_ENGINE`, `CHAT_ENGINE` and
     * `JUDGE_ENGINE`, and the difference is what sits behind each of them. An
     * engine that refuses is still a truthful answer for a tool whose caller
     * is an agent. What sits behind this one is a page a person looks at, so
     * the thing worth exercising is the whole route with results on it -- the
     * cache, the limiter, the mapping and the response shape -- rather than a
     * refusal at the seam. The fixture is `SEARCH_STUB_RESULTS` in
     * src/lib/search/engine.ts, and it deliberately names a draft so #147's
     * join has something it must drop.
     *
     * Retrieval quality itself proves nothing here and is not meant to: the
     * ranking and the excerpts are verified by hand against the live instance,
     * which is what #145's baselines exist for.
     */
    SEARCH_ENGINE: 'stub',
    /**
     * Issue #291's scheduled eval run (src/lib/evals/plan.ts's
     * `evalsRunEnabled`), off. The ninth seam of this shape on this Worker: no
     * deployed config declares it, an unrecognised value throws, and `'off'` is
     * the only accepted value here.
     *
     * TWO REASONS, and they are independent -- either alone would be enough.
     *
     * The run SPENDS: `fit`, `chat` and `leak` are fifteen frontier-model
     * calls through AI Gateway, on top of the judge call each one can trigger.
     * A test suite must not be one edit away from spending real money, which
     * is the same sentence `FIT_ENGINE` above already earns its place with.
     *
     * And it could not COMPLETE here anyway. The `AI` override below is a
     * service binding, so `env.AI.run()` is a TypeError, and `FIT_ENGINE`,
     * `CHAT_ENGINE` and `JUDGE_ENGINE` are all already `'off'` -- so every
     * case an instance started here could reach would be refused at a seam,
     * and the run would write a red `eval_runs` row about a suite that never
     * ran. That is the failure this repo keeps naming: a result that proves
     * nothing, recorded where somebody will later read it as one that does.
     *
     * The one instance this harness CAN complete is driven directly rather
     * than by a cron: tests/evals-schedule.test.ts creates one with `suites:
     * []`, which mints, iterates nothing and revokes, and is what makes the
     * "no instance started" assertions there mean something.
     */
    EVALS_RUNNER: 'off',
  },
  bindingOverrides: { AI: 'mock-ai', AI_SEARCH: 'mock-ai' },
};

/** The Workers AI stand-in the override above resolves. Test-only, never deployed. */
export const MOCK_AI_WORKER = { configPath: './workers/mock-ai/wrangler.jsonc' };

/**
 * A THIRD mock lives in `workers/mock-ae`, for the `AE` (Analytics Engine)
 * binding -- NOT exported here and not in `MCP_HARNESS_WORKERS` below, unlike
 * its two siblings above. `tests/chat-endpoint.test.ts` and
 * `tests/mcp-site-search.test.ts` are the only suites that need a readable
 * `AE` (the second arrived with #146), so each builds its own worker list
 * (`bindingOverrides: { AE: 'mock-ae' }` merged onto `MCP_WORKER`) rather than
 * widening this shared config for two files' sake -- see their own
 * top-of-file comments for the reasoning, and workers/mock-ae's own
 * wrangler.jsonc for why the mock exists at all. Noted here only so a reader
 * of this file discovers it exists (task-13a-findings-final.md item 8).
 */

/**
 * All three, in the order every suite wants them: the site first, so it is the
 * primary Worker that relative `server.fetch()` URLs address and the one
 * `server.getWorker()` returns unnamed.
 *
 * It was four until #186 retired `MOCK_BROWSER_WORKER` along with the renderer
 * that made it necessary.
 */
export const SITE_HARNESS_WORKERS = [SITE_WORKER, MCP_WORKER, MOCK_AI_WORKER];

/**
 * The same three Workers with the MCP Worker FIRST, for a suite whose subject
 * is the MCP Worker and which therefore wants it as the primary one.
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
 * MOCK_BROWSER_WORKER used to come along too, because SITE_WORKER's
 * `bindingOverrides` named it and that same rule applies to an override's
 * target. #186 removed the override, so the list is one Worker shorter.
 */
export const MCP_HARNESS_WORKERS = [MCP_WORKER, SITE_WORKER, MOCK_AI_WORKER];

/**
 * Puts a stand-in résumé PDF where /resume.pdf will find it.
 *
 * NEEDED BY EVERY SUITE THAT EXPECTS THAT ROUTE TO ANSWER 200, and before #186
 * none of them did: the route rendered on a cold miss, so fetching it produced
 * bytes whether or not anything had seeded R2, and four assertions across three
 * suites were relying on that without saying so. The route only reads now, so
 * an unseeded bucket is a 503 -- correctly, because an unseeded bucket is
 * exactly what a deployment with no published sheet has.
 *
 * It writes the CONTENT-ADDRESSED key, so what those suites exercise is the
 * `exact` path. tests/resume-pdf.test.ts owns the other two states; this is
 * here so that a suite whose subject is routing or negotiation does not have to
 * know which key answered.
 *
 * DYNAMIC IMPORTS, in a module that otherwise has none. Everything above this
 * line is plain data, so nearly every suite in the repo imports this file and
 * pays for whatever it pulls in. A static import of ../src/lib/resume-pdf
 * would put the résumé YAML and its `?raw` transform in that path for all of
 * them, to serve the three that call this. Deferring to call time is the whole
 * reason, and it is not a pattern to copy into a suite that needs the module
 * anyway -- tests/resume-pdf.test.ts imports it statically and should.
 */
export async function seedResumePdf(env: { R2_ASSETS: R2Bucket }): Promise<void> {
  const { resumeSourceHash } = await import('../src/lib/resume-pdf');
  const { RESUME_PDF_HTTP_METADATA, resumePdfKey } = await import('../src/lib/resume-pdf-contract');
  const body = new TextEncoder().encode('%PDF-1.7 seeded');
  await env.R2_ASSETS.put(resumePdfKey(await resumeSourceHash()), body, {
    httpMetadata: { ...RESUME_PDF_HTTP_METADATA },
  });
}
