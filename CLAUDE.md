# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The source of [ryanlindsey.me](https://ryanlindsey.me): an Astro site on the Cloudflare developer platform, plus a second Worker serving a remote MCP server at `mcp.ryanlindsey.me`. One repository, two deployed Workers, one shared set of D1, KV, R2, Queues and Analytics Engine resources.

Deploys run on Workers Builds from `main`. CI has no deploy step. It holds exactly one Cloudflare credential, an R2 token that reaches one bucket, described under [The one credential in CI](#the-one-credential-in-ci).

## Commands

| Command                           | What it does                                                            |
| --------------------------------- | ----------------------------------------------------------------------- |
| `npm run dev`                     | `astro dev`, the fast loop for pages and styles                         |
| `npx wrangler dev`                | the site Worker against the last `npm run build` output                 |
| `npm run build`                   | `astro build`, writes `dist/client` and `dist/server/wrangler.json`     |
| `npm run check`                   | `astro check`, the typecheck                                            |
| `npm run lint` / `npm run format` | Prettier over the repo                                                  |
| `npm test`                        | `astro build && vitest run`                                             |
| `npm run preview:fit`             | serve `/fit` and `/fit/r/<id>` locally, with a forged grant             |
| `npm run typegen`                 | `wrangler types`, regenerates the committed `worker-configuration.d.ts` |
| `npm run evals`                   | the model evals, against a deployed endpoint (see `evals/README.md`)    |
| `npm run token`                   | mint, list and revoke scoped tokens                                     |
| `npm run private-doc`             | put one document into the private R2 bucket                             |
| `npm run resume:pdf`              | `astro build` then render the résumé sheet and its golden extraction    |
| `npm run resume:gate`             | assert the rendered sheet, needs poppler and a prior render             |

`npm test` does not typecheck. Run `npm run check` before pushing; CI runs check, lint, build and test in that order, and the typecheck catches what vitest never sees.

To run one suite, build first, because every harness suite boots the site Worker from `dist/server/wrangler.json`:

```sh
npm run build && npx vitest run tests/mcp-search.test.ts
npx vitest run tests/mcp-search.test.ts -t 'name of the test'
```

CI's `checks` workflow is the gate that matters on a pull request. A red Cloudflare Workers Builds check on a pull request does not mean the build is broken. The `resume-pdf` workflow gates as well, on pushes to `main` and on manual dispatch rather than on pull requests, and it runs the same résumé gate again before it uploads anything.

## Architecture

### Two Workers, and why the split is not cosmetic

`ryanlindsey-me` (root `wrangler.jsonc`) serves the site: static assets, the on-demand routes, the queue consumer, and one daily cron at 05:47 UTC for the retention sweep. A second cron at 05:17 UTC refreshed the résumé PDF until issue 06 (#186) moved that render into GitHub Actions.

`ryanlindsey-me-mcp` (`workers/mcp/wrangler.jsonc`) serves the MCP protocol, the chat endpoint, the fit engine, the LLM judge, the rate limiter Durable Object, and three crons: 05:32 UTC refreshes the Vectorize corpus, 05:52 UTC runs the `tier` eval suite daily, and 06:07 UTC on Mondays runs `fit`, `chat` and `leak`, the three suites that spend inference (issue #291). `scheduled()` branches on which cron fired, so the corpus refresh now runs only for its own expression, a change from running for every trigger when this Worker had only one.

The `ai`, `vectorize` and `ai_search` bindings live on the MCP Worker because an `ai` binding in the site's config makes `astro build` open a remote proxy session that credential-free CI cannot authenticate. That is the reason the split exists. Do not move any of them back. `ai_search` was added by issue 01 (#144), which measured that wrangler classifies it exactly as it classifies `ai`: no local emulator, remote no matter what `remote` says, and a failure at boot rather than at the call.

The two Workers name each other: the site's `MCP` service binding forwards `/mcp`, `/fit` and `/chat` work, and the MCP Worker's `SITE` binding reads published documents back. The cycle is deliberate and legal, because a service binding resolves when it is called rather than when the Worker is defined. Its practical consequence is that any test harness booting one Worker must list the other, or workerd refuses to start.

The MCP Worker also binds itself: `SELF`, a service binding pointing at `ryanlindsey-me-mcp`, so the scheduled eval run reaches `/mcp` and `/chat` the way any other client does, through this Worker's whole `fetch` handler and the one `resolveGrant` check rather than skipping either. This is a deliberate re-entrant dispatch, not an accident of naming, and it rests on a measurement taken 2026-09-18: a request over the binding carrying a deliberately bad bearer answered `200` with the public tool list, meaning the bad token was refused and the caller was served the public tier, which is exactly `resolveGrant`'s designed behavior toward a caller it does not trust.

### Static first

`output: 'static'`. Pages prerender by default and individual routes opt out with `export const prerender = false`. `src/worker.ts` only exists because at least one route is on-demand: with none, the adapter builds an assets-only Worker and the `scheduled()` and `queue()` handlers disappear from the deployment without an error anywhere.

### One authorization check

`src/lib/tier/grant.ts` resolves a request into a grant, and it runs on the MCP Worker only. Site routes treat the token as an opaque string and ask the MCP Worker over the service binding what it unlocks. Do not add a second verification on the site: one implementation of the boundary is the design, and a second copy that agrees with the first proves nothing.

`src/lib/tier/token.ts` answers whether a signature is real, `registry.ts` answers whether the credential is still live, and they are separate on purpose. Scopes are a closed set (`fit`, `profile`, `documents`, `narrative`, `evals`, `authoring`); an unknown scope is a malformed token. The last two are withheld from public metadata: `evals` opens `judge_answer` and admission to `POST /chat`, and `authoring` opens `get_narrative_brief`.

The private tier is a partition rather than a filter. `R2_ASSETS` holds what the site publishes and `R2_PRIVATE` holds what a grant unlocks, `src/lib/tier/private-docs.ts` is the only reader of the second, and the public document layer's env interface does not name that bucket at all. `tests/tier-private-docs.test.ts` asserts it at the type level. A public code path cannot leak a private document by forgetting a filter, because it has no reference to the bucket.

Gated tools are registered only for a request whose grant carries the matching scope, so an unauthenticated `tools/list` cannot enumerate a name that exists.

### Traps worth knowing before editing

`src/pages/chat/send.ts` deliberately does not verify Turnstile. It forwards the response token to the MCP Worker, which verifies it there. A Turnstile response is single use, so adding a `verifyTurnstile` call to the site route consumes it and breaks chat completely while looking like defense in depth. `/fit` is the opposite arrangement and stays that way: it serves its own form and verifies it.

`tests/mcp-env.test.ts` regenerates the MCP binding list with `wrangler types` and fails when `McpEnv` drifts from `workers/mcp/wrangler.jsonc` in either direction. Adding a binding means editing both.

The `x-release-please-version` marker on one line of `workers/mcp/src/server.ts` is what keeps the version the MCP server advertises in step with `package.json`. Moving the version off that line, or letting a formatter split the line, strands it silently.

`.github/workflows/resume-pdf.yml` is the only writer of the résumé PDF, and `/resume.pdf` is the only reader. The Worker rendered the sheet itself until issue 06 (#186): a Browser Rendering call behind a KV manifest, a KV lock and a daily 05:17 cron, about 700 lines whose whole job was deciding whether the résumé source had moved since the last render. The PDF is a pure function of the commit, so git answers that question and the render happens on the push that causes it.

The route reads two keys and reports which one answered in `x-resume-pdf-state`. `exact` is `resume/<hash>.pdf`, the sheet built from this commit's own source. `fallback` is `resume/latest.pdf`, the alias the workflow writes with the same bytes, which covers a deploy that lands before the publish job finishes. `missing` is neither, and answers 503 rather than 404, because the document is unpublished rather than absent. There is no render behind any of them.

Two things follow. A résumé change is live only once the workflow has run on `main`, so a red or skipped `resume-pdf` run means the sheet the site serves is one publish behind, and a dispatch with `force` republishes both keys. And `RESUME_PDF_CONTRACT_VERSION` in `src/lib/resume-pdf-contract.ts` now moves the key the workflow publishes to and the key the route reads from together, so bumping it without a matching golden fails the `contract` check in `scripts/resume-gate.mjs`.

Measured on 2026-09-15, before the workflow had ever run: the hashed key already held a nine-page, 215 KB render from Browser Rendering carrying no Author and no Subject, and `resume/latest.pdf` did not exist. That is why `scripts/resume-publish.mjs` probes both keys rather than the hashed one alone, and the probe is kept for the plainer reason that the two uploads are separate calls and the second can fail on its own.

### Content

Collections are defined in `src/content.config.ts`: `posts` and `caseStudies` as MDX under `src/content/`, `resume` as one YAML file validated against a JSON Resume shape, and `governance` plus `riskRegister` loaded from `./governance`.

Every draft has a real route by design. `src/lib/unindexed-routes.mjs` is what keeps drafts and scoped `/fit/r/<id>` URLs out of the sitemap, so a new unpublished or token-bearing route needs a line there rather than trusting the listing pages.

### DNS, which this repository does not manage

The `ryanlindsey.me` zone carries two DNS-AID entrypoint records, added by hand in the Cloudflare dashboard. `_index._agents` is a ServiceMode SVCB record targeting the apex, and the document it stands for is `/.well-known/ai-catalog.json`. `_mcp._agents` targets `mcp.ryanlindsey.me`, and the endpoint path comes from the server card at `/.well-known/mcp/server-card.json`.

Neither record names its own path, and not by choice. The draft defines a `well-known` service parameter for exactly that job, and Cloudflare rejects it: the parameter has no assigned IANA key number, and an unknown key fails validation. So each record carries `alpn` and `port`, and the path lives one fetch away in the document its target serves. Moving or renaming either document breaks a DNS record that no test in this repository can see.

### The AI Search instance, which this repository also does not manage

`/search` reads `ryanlindsey-me-search`, and six of its settings are decisions this code depends on and cannot see. They are set in the Cloudflare dashboard, `wrangler ai-search update` exposes flags for only some of them, and `wrangler ai-search get` serves a cached copy, so `wrangler ai-search list` is how you read one back after a write.

| Setting            | Value           | What breaks without it                                                                                    |
| ------------------ | --------------- | --------------------------------------------------------------------------------------------------------- |
| `parse_type`       | `sitemap`       | the sitemap stops being the allowlist, and `src/lib/unindexed-routes.mjs` stops governing what is indexed |
| path filter        | excludes `/fit` | the second of the epic's three gates keeping `/fit/r/<id>` tokens out of the index                        |
| `content_selector` | `**` to `main`  | the skip link returns to every chunk, and reranking makes it win queries (#250)                           |
| `sync_interval`    | `86400`         | `SEARCH_CACHE_TTL_SECONDS` is matched to this number and has to follow it down                            |
| `reranking`        | `true`          | `durable objects` returns nothing, on five pages that carry the phrase (#148)                             |
| `max_num_results`  | `20`            | the handler asks for twenty and is served the instance's number instead (#249)                            |

Three things follow, and the third is the one that bites.

**A content selector matching nothing is not an error anybody sees.** Cloudflare marks the item errored, the job log still reports a clean batch, and only the dashboard's Items tab says otherwise, so the page leaves the index in silence. `tests/seo.test.ts` holds the site's half of that contract: every page the sitemap lists renders exactly one `<main>`, with its `<h1>` inside it and the skip link outside.

**A selector reaches the body only, so it is not a general answer to crawled boilerplate.** Cloudflare's HTML pipeline extracts the meta tags and the JSON-LD before the selector runs, and both land in the markdown regardless: every chunk set still opens with a synthesised frontmatter fence and closes with a fenced JSON-LD block. `excerptFrom` in `src/lib/search/results.ts` is the only thing that removes the first and nothing removes the second.

**Changing what the index holds means changing `SEARCH_CACHE_VERSION` too, and in that order.** `searchCacheKey` is built from the query alone, so nothing in a cached entry names the index or the instance configuration. Apply the instance change, wait for the sync it triggers to finish, then deploy the bump: entries written before that point are discarded. Deploying first writes entries from the old index and keeps each for a full day.

## Tests

Vitest plus `createTestHarness` from wrangler, booting real Workers inside workerd. `tests/workers.ts` holds the shared worker lists and the reasoning behind each override; read it before adding a suite. The site Worker boots from the adapter's build output rather than from the source config, so the tests exercise the artifact that ships.

No test in this repo may reach Workers AI, Vectorize, Browser Rendering, `api.cloudflare.com` or a real secret. The mechanism is a set of override variables that no deployed config sets, where an unrecognized value throws and the only accepted value is the one `tests/workers.ts` passes: `RLME_TURNSTILE_MODE`, `RLME_NOTIFY_MODE`, `RLME_ANALYTICS_MODE`, `CORPUS_REFRESH`, `MCP_SEARCH_EMBEDDER`, `RLME_TOKEN_KEY_SOURCE`, `FIT_ENGINE`, `CHAT_ENGINE`, `JUDGE_ENGINE`, `SEARCH_ENGINE` and `EVALS_RUNNER`. Bindings with no local emulator resolve to the test-only Workers in `workers/mock-ai` and `workers/mock-ae`. `RESUME_PDF_RENDERER` and `workers/mock-browser` were a variable of the same shape and a third mock until issue 06 (#186) deleted the renderer they stood in front of; the `BROWSER` binding is still declared, and nothing calls it.

Adding a feature that spends money or calls a remote service means adding a variable of the same shape, off by default in the harness and never declared in a deployed config.

## Evals

`npm run evals` scores the prompts in `prompts/` against golden cases in `evals/cases/`. It runs locally against a deployed endpoint, before merge, because CI holds no inference credential. Read `evals/README.md` before running it: minting and running must happen in one shell invocation, cases are paced twenty-five seconds apart to stay under AI Gateway's unpublished wholesale rate limit, and exit code 2 means a suite could not run rather than that everything passed.

The same suites also run on a Cloudflare schedule inside the MCP Worker, in `EvalsWorkflow` (`workers/mcp/src/evals-workflow.ts`): `tier` daily and `fit`, `chat` and `leak` weekly, each run minting its own short-lived token scoped to `evals` and `fit` from the Secrets Store signing key rather than holding a credential anywhere. `eval_runs` now carries a `status` column, `ran` or `incomplete`, and `/ops` renders a non-`'ran'` row as "did not run" instead of publishing an older pass. See `evals/README.md`'s section on the schedule for what the schedule does not replace.

Prompts are code. They change by pull request and this suite is what gates them.

## Owner-run scripts

`scripts/token.mjs` mints, lists and revokes scoped tokens through wrangler's own login, and sources no credential of its own. Minting signs in process from `RLME_TOKEN_SIGNING_KEY`, which the owner injects with `op run` and the script never reads from anywhere itself, so no Worker has to be running. A Cloudflare Secrets Store value is write-only and only a binding can read it, which is why the Cloudflare copy cannot be the one that signs here. Signing locally makes the two copies of the key able to diverge, so `mint` ends by presenting the fresh token to the deployed Worker at `POST /grant` and refuses to report success unless it comes back honored, carrying the audience just written. It asks `/grant` rather than `tools/list` because the public tools answer every caller: a refused token is not rejected, it is served the public tier, so `tools/list` cannot tell a diverged key from a good mint. Minting needed a temporary `/__sign` route inside a running Worker until issue 04 (#220).

`scripts/preview-fit.mts` is how you look at `/fit` and `/fit/r/<id>` before shipping a change to either, and `npm run dev` is not. Both routes are on-demand and grant-gated, so astro dev serves them the flattened 404 and nothing else: there is no token its grant check will honor and no `fit_reports` row to read. The script boots the same harness the suite boots, which is the only thing here that can forge a grant, then mints a `fit`-scoped token, inserts a report, and prints the three URLs. It reaches no credential and no remote service. Read the header before trusting it, in particular why minting a token in a public repository gives nobody anything, and what the preview deliberately cannot do.

`scripts/private-doc.mjs` is invoked from the directory holding the document, not from here. The mechanism is generic and lives in this repo; every document it deploys is authored outside every repository, so nothing it writes enters any history rather than merely staying out of this one.

## The one credential in CI

`.github/workflows/resume-pdf.yml` publishes the résumé sheet to R2, and it is the only workflow in this repository that authenticates to Cloudflare. It holds two secrets, `RLME_R2_ACCESS_KEY_ID` and `RLME_R2_SECRET_ACCESS_KEY`, an R2 credential pair carrying object read and write on the `ryanlindsey-me-assets` bucket and on nothing else. `scripts/resume-publish.mjs` hands them to the AWS CLI, which GitHub's runner image already ships, and talks to `<account>.r2.cloudflarestorage.com`. The account id is the endpoint's hostname and stays a public value, already committed in both `wrangler.jsonc` files.

The narrow scope is the point, and an account-wide credential would defeat it. The private tier is a partition rather than a filter: `R2_PRIVATE` holds what a grant unlocks, `src/lib/tier/private-docs.ts` is its only reader, and the public document layer's env interface does not name that bucket at all, which `tests/tier-private-docs.test.ts` asserts at the type level. A credential in CI that could reach `ryanlindsey-me-private` would be the first thing in this repository holding a reference to that bucket, and the guarantee would then rest on nobody writing the request rather than on nobody being able to.

That sentence is why this is an S3 pair rather than a Bearer token, and the distinction cost four failed runs to learn (issue 07, #205). The workflow shipped in #185 calling `wrangler r2 object` with `CLOUDFLARE_API_TOKEN`, and never once succeeded.

The reason is one line of Cloudflare's own documentation, at [r2/api/tokens](https://developers.cloudflare.com/r2/api/tokens/): **`Object Read & Write` and `Object Read only` are supported only by the S3-compatible API, not the Cloudflare REST API.** `wrangler r2 object` speaks the REST API, so a token carrying object permissions fails every REST call. Measured in the runner against the stored secret, it failed even on `r2/buckets`, which merely lists, and failed identically for both accounts on the login. That is what makes the failure so misleading: a permission-type mismatch answers `403` with `10000 Authentication error`, the same shape a revoked or malformed token gives, which sends you hunting the value and the scope instead.

`Admin Read & Write` would have worked over the REST API and kept wrangler. It is not bucket-scopable, though, and only object-level permissions are, so wrangler and least privilege cannot both be had here. Choosing least privilege is what forced the S3 client. The mechanism came from `scripts/private-doc.mjs`, which shells out to wrangler and works because it runs behind the owner's OAuth login, an account-level credential. Copying the mechanism without its credential is the whole bug.

**The two secrets are one credential, which matters before revoking anything.** The same page records that the Access Key ID is the API token's `id` and the Secret Access Key is the SHA-256 hash of the token's `value`. They are a projection of one token rather than two independent objects, so deleting or rolling that token invalidates both and breaks this workflow. To invalidate an exposed value without an outage, roll the token and re-set both secrets in the same pass. Prefer an **Account** API token over a **User** one: a user token dies if that user is removed from the account, and this credential belongs to CI rather than to a person.

Three things follow. Rotation happens in the Cloudflare dashboard and needs no change here, though it moves two values that must be re-set together. The credentials cannot deploy a Worker, so Workers Builds still owns deploys and still mints its own. And `10 §2.4` in the private docs repo states that CI holds zero Cloudflare credentials, which is now false there as well; correcting it is a separate change in that repository.

## The private docs repo

Comments and prompts cite sections like `03 §3`, `09 §2` and `10 §2.3`. Those are files in `docs/plan/` of the private `ryanlindsey.me.docs` repository, cloned next to this one at `../ryanlindsey.me.docs`, numbered `00-overview.md` through `10-guardrails.md`. When a comment cites a section, that document is the authority and this code is the implementation of it.

Two rules from there that bite in this repo: audience-specific meaning arrives as runtime data and never as code, so no campaign, company or posting appears in any source file; and candidacy vocabulary is banned in anything a client can read, including MCP instruction strings and tool descriptions.

## Prose

Use the `house-style` skill for any prose in this repository, including post and case study content, page copy and frontmatter descriptions, and including requests that never mention style. The mechanical half is checkable:

```sh
node .claude/skills/house-style/scripts/check-prose.mjs src/content/**/*.mdx
```

Prose is written unwrapped, one line per paragraph. Never reflow a file as a side effect of another change.

## Comments

This codebase documents why rather than what, records what was measured and on what date, and sometimes records that an earlier version of a comment was wrong and what the mistake taught. Those corrections are the record of what was already tried; do not delete them while editing nearby code. When behavior changes, update the comment in the same change rather than leaving a true-when-written note to mislead the next reader.

## Releases

release-please watches `main` and keeps a release pull request open. Pull requests are squash-merged, so the pull request title is the commit subject release-please reads, and a title without a recognized `type(scope): summary` prefix is skipped silently: no version bump, no changelog entry. The full type list is `changelog-sections` in `release-please-config.json`.

`CHANGELOG.md` and `.release-please-manifest.json` are in `.prettierignore` because release-please rewrites them in a format Prettier disagrees with. Leave both alone.
