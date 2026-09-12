# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The source of [ryanlindsey.me](https://ryanlindsey.me): an Astro site on the Cloudflare developer platform, plus a second Worker serving a remote MCP server at `mcp.ryanlindsey.me`. One repository, two deployed Workers, one shared set of D1, KV, R2, Queues and Analytics Engine resources.

Deploys run on Workers Builds from `main`. CI has no deploy step and holds no Cloudflare credential.

## Commands

| Command                           | What it does                                                            |
| --------------------------------- | ----------------------------------------------------------------------- |
| `npm run dev`                     | `astro dev`, the fast loop for pages and styles                         |
| `npx wrangler dev`                | the site Worker against the last `npm run build` output                 |
| `npm run build`                   | `astro build`, writes `dist/client` and `dist/server/wrangler.json`     |
| `npm run check`                   | `astro check`, the typecheck                                            |
| `npm run lint` / `npm run format` | Prettier over the repo                                                  |
| `npm test`                        | `astro build && vitest run`                                             |
| `npm run typegen`                 | `wrangler types`, regenerates the committed `worker-configuration.d.ts` |
| `npm run evals`                   | the model evals, against a deployed endpoint (see `evals/README.md`)    |
| `npm run token`                   | mint, list and revoke scoped tokens                                     |
| `npm run private-doc`             | put one document into the private R2 bucket                             |

`npm test` does not typecheck. Run `npm run check` before pushing; CI runs check, lint, build and test in that order, and the typecheck catches what vitest never sees.

To run one suite, build first, because every harness suite boots the site Worker from `dist/server/wrangler.json`:

```sh
npm run build && npx vitest run tests/mcp-search.test.ts
npx vitest run tests/mcp-search.test.ts -t 'name of the test'
```

CI's `checks` workflow is the gate that matters. A red Cloudflare Workers Builds check on a pull request does not mean the build is broken.

## Architecture

### Two Workers, and why the split is not cosmetic

`ryanlindsey-me` (root `wrangler.jsonc`) serves the site: static assets, the on-demand routes, the queue consumer, and two daily crons at 05:17 UTC for the resume PDF refresh and 05:47 UTC for the retention sweep.

`ryanlindsey-me-mcp` (`workers/mcp/wrangler.jsonc`) serves the MCP protocol, the chat endpoint, the fit engine, the LLM judge, the rate limiter Durable Object, and a 05:32 UTC cron that refreshes the Vectorize corpus.

The `ai` and `vectorize` bindings live on the MCP Worker because an `ai` binding in the site's config makes `astro build` open a remote proxy session that credential-free CI cannot authenticate. That is the reason the split exists. Do not move either binding back.

The two Workers name each other: the site's `MCP` service binding forwards `/mcp`, `/fit` and `/chat` work, and the MCP Worker's `SITE` binding reads published documents back. The cycle is deliberate and legal, because a service binding resolves when it is called rather than when the Worker is defined. Its practical consequence is that any test harness booting one Worker must list the other, or workerd refuses to start.

### Static first

`output: 'static'`. Pages prerender by default and individual routes opt out with `export const prerender = false`. `src/worker.ts` only exists because at least one route is on-demand: with none, the adapter builds an assets-only Worker and the `scheduled()` and `queue()` handlers disappear from the deployment without an error anywhere.

### One authorization check

`src/lib/tier/grant.ts` resolves a request into a grant, and it runs on the MCP Worker only. Site routes treat the token as an opaque string and ask the MCP Worker over the service binding what it unlocks. Do not add a second verification on the site: one implementation of the boundary is the design, and a second copy that agrees with the first proves nothing.

`src/lib/tier/token.ts` answers whether a signature is real, `registry.ts` answers whether the credential is still live, and they are separate on purpose. Scopes are a closed set (`fit`, `profile`, `documents`, `narrative`, `evals`); an unknown scope is a malformed token.

The private tier is a partition rather than a filter. `R2_ASSETS` holds what the site publishes and `R2_PRIVATE` holds what a grant unlocks, `src/lib/tier/private-docs.ts` is the only reader of the second, and the public document layer's env interface does not name that bucket at all. `tests/tier-private-docs.test.ts` asserts it at the type level. A public code path cannot leak a private document by forgetting a filter, because it has no reference to the bucket.

Gated tools are registered only for a request whose grant carries the matching scope, so an unauthenticated `tools/list` cannot enumerate a name that exists.

### Traps worth knowing before editing

`src/pages/chat/send.ts` deliberately does not verify Turnstile. It forwards the response token to the MCP Worker, which verifies it there. A Turnstile response is single use, so adding a `verifyTurnstile` call to the site route consumes it and breaks chat completely while looking like defense in depth. `/fit` is the opposite arrangement and stays that way: it serves its own form and verifies it.

`tests/mcp-env.test.ts` regenerates the MCP binding list with `wrangler types` and fails when `McpEnv` drifts from `workers/mcp/wrangler.jsonc` in either direction. Adding a binding means editing both.

The `x-release-please-version` marker on one line of `workers/mcp/src/server.ts` is what keeps the version the MCP server advertises in step with `package.json`. Moving the version off that line, or letting a formatter split the line, strands it silently.

### Content

Collections are defined in `src/content.config.ts`: `posts` and `caseStudies` as MDX under `src/content/`, `resume` as one YAML file validated against a JSON Resume shape, and `governance` plus `riskRegister` loaded from `./governance`.

Every draft has a real route by design. `src/lib/unindexed-routes.mjs` is what keeps drafts and scoped `/fit/r/<id>` URLs out of the sitemap, so a new unpublished or token-bearing route needs a line there rather than trusting the listing pages.

## Tests

Vitest plus `createTestHarness` from wrangler, booting real Workers inside workerd. `tests/workers.ts` holds the shared worker lists and the reasoning behind each override; read it before adding a suite. The site Worker boots from the adapter's build output rather than from the source config, so the tests exercise the artifact that ships.

No test in this repo may reach Workers AI, Vectorize, Browser Rendering, `api.cloudflare.com` or a real secret. The mechanism is a set of override variables that no deployed config sets, where an unrecognized value throws and the only accepted value is the one `tests/workers.ts` passes: `RESUME_PDF_RENDERER`, `RLME_TURNSTILE_MODE`, `RLME_NOTIFY_MODE`, `RLME_ANALYTICS_MODE`, `CORPUS_REFRESH`, `MCP_SEARCH_EMBEDDER`, `RLME_TOKEN_KEY_SOURCE`, `FIT_ENGINE`, `CHAT_ENGINE` and `JUDGE_ENGINE`. Bindings with no local emulator resolve to the test-only Workers in `workers/mock-ai`, `workers/mock-browser` and `workers/mock-ae`.

Adding a feature that spends money or calls a remote service means adding a variable of the same shape, off by default in the harness and never declared in a deployed config.

## Evals

`npm run evals` scores the prompts in `prompts/` against golden cases in `evals/cases/`. It runs locally against a deployed endpoint, before merge, because CI holds no inference credential. Read `evals/README.md` before running it: minting and running must happen in one shell invocation, cases are paced twenty-five seconds apart to stay under AI Gateway's unpublished wholesale rate limit, and exit code 2 means a suite could not run rather than that everything passed.

Prompts are code. They change by pull request and this suite is what gates them.

## Owner-run scripts

`scripts/token.mjs` mints, lists and revokes scoped tokens through wrangler's own login, holding no credential of its own. Minting needs a temporary `/__sign` route inside a running Worker, because a Cloudflare Secrets Store value is write-only and only a binding can read it. The script's header carries the route to paste and the instruction to delete it before committing.

`scripts/private-doc.mjs` is invoked from the private planning repo, not from here. The mechanism is generic and lives in this repo; every document it deploys is authored elsewhere and never enters this repository's history.

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
