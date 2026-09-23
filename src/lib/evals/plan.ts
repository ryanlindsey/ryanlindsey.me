// Pacing and scheduling for the eval suites (04 §4). Pure constants and pure
// mappings: nothing here sleeps, fetches, or reads a binding. The pacing
// numbers were measured against evals/run.mjs's actual runs against the
// deployed MCP Worker, and both runners -- evals/run.mjs today, the MCP
// Worker's scheduled runner in Task 4 -- read the same numbers rather than
// each tuning its own, because a quota measured once should not need
// re-discovering twice.
//
// IT ALSO HOLDS THE TWO STRINGS THE SCHEDULED RUN IDENTIFIES ITSELF BY, which
// are constants of the same kind and belong here for the same reason: three
// modules in two Workers have to agree on them, and none of the three is a
// sensible home for the other two to import from. See `EVALS_USER_AGENT`.

/**
 * What every request the SCHEDULED runner makes says it is.
 *
 * WHY ANY OF THIS EXISTS. The scheduled run is deliberately indistinguishable
 * from a stranger in every way that matters to authorization: the `tier` suite
 * calls anonymously because that is what it asserts, and the `/chat` turns
 * present a grant exactly as any other client would. That is the design and it
 * stays. The consequence is that its traffic lands in the same tables /ops
 * publishes as a visitor's, and a header is the only thing that can tell them
 * apart afterwards.
 *
 * The precedent is src/pages/chat/send.ts's `ryanlindsey-me-chat/1` and
 * src/lib/fit/client.ts's `ryanlindsey-me-fit/1`, both set so the transcript
 * and /ops can tell one caller from another, and this follows their naming.
 *
 * THREE MODULES READ THESE. workers/mcp/src/evals-client.ts sets the header on
 * every request; workers/mcp/src/chat.ts maps it to the `chat_turns.surface`
 * value below; src/lib/ops/metrics.ts excludes both in SQL. A request that
 * arrives without this header is published as visitor traffic, which is the
 * failure the whole arrangement exists to prevent.
 */
export const EVALS_AGENT = 'ryanlindsey-me-evals';
export const EVALS_USER_AGENT = `${EVALS_AGENT}/1`;

/**
 * The `chat_turns.surface` value a scheduled run's turn is stored under
 * (migrations/0004). A THIRD VALUE OF AN EXISTING COLUMN rather than a new
 * column: `surface` already exists to say which caller a turn came from, and
 * `'site'` and `'direct'` were already two answers to that question.
 *
 * The version prefix is deliberately NOT in it. `EVALS_USER_AGENT` carries one
 * because a user agent conventionally does; a stored discriminator a query
 * matches on should not change the day the client's version does.
 */
export const EVALS_SURFACE = 'evals';

/**
 * ONE client retry, and the number is small because it is not the first one.
 *
 * WHAT IS BEING RETRIED, measured 2026-09-10: the AI Gateway answers `2018:
 * Invalid User Credentials` when a rate limit is hit -- an auth error's wording
 * on a rate-limit fault, recorded in 10 §5 -- and `handleChat` maps it to the
 * `unreachable` code, which is the one code the `TRANSIENT` set matches. That
 * set is spelled twice, once in evals/run.mjs and once in
 * workers/mcp/src/evals-client.ts, and both are named here because neither
 * file's name is guessable from a constant in this one. The gateway
 * dashboard attributed 19 HTTP 429s to that afternoon's runs, so it is rate
 * limiting rather than a broken credential, whatever the message says.
 *
 * THE GATEWAY ALREADY RETRIES. The `ryanlindsey-me` gateway has a retry rule --
 * up to 4 attempts, 2s delay, exponential backoff -- so a single call from here
 * is already up to FIVE upstream requests spread over ~30 seconds, and a failure
 * that reaches this process is one the gateway has already given up on.
 *
 * Retries compose rather than add: at the four client retries this file briefly
 * had, one failing case was up to 5 x 5 = 25 upstream attempts. Whether those
 * attempts each count against the wholesale rate limit is NOT DOCUMENTED --
 * Cloudflare's request-handling page specifies the knobs (`cf-aig-max-attempts`,
 * capped at 5) and says nothing about what triggers a retry, how a retried
 * request is counted, or whether retry runs before or after rate limiting. So
 * the cost of a high client retry count is known to be latency and unknown to be
 * quota.
 *
 * One retry is chosen on the part that does NOT depend on that unknown: the
 * gateway already implements this, a failure reaching here is one it has already
 * given up on, and a second mechanism at a second layer is harder to reason
 * about than either alone. Ten seconds so the attempt lands past the window
 * rather than inside it.
 *
 * The real remedy is `PACE_MS` below. Fewer requests is the only thing that
 * helps a quota, and unlike the above that is true whatever the counting is.
 */
export const RETRIES = 1;
export const BACKOFF_MS = 10_000;

/**
 * How long to wait between CASES.
 *
 * THE CEILING IS CLOUDFLARE'S, NOT OURS, and that is why this exists instead of
 * a bigger number in the gateway settings. The 429s say:
 *
 *   Wholesale rate limit exceeded for this gateway.
 *   Please reduce request rate or use BYOK.
 *
 * "Wholesale" is the platform's own limit on Unified Billing, separate from the
 * per-gateway rate limit in the dashboard -- which is why failures appeared at
 * roughly six requests a minute against a fifty-a-minute setting, and why
 * raising that setting to three hundred did not clear them. Cloudflare does not
 * publish the wholesale number, so this is tuned by observation rather than
 * derived: the failures cluster at the TAIL of a run, which is the shape of a
 * sliding window filling up.
 *
 * Twenty-five seconds between cases, on top of the seconds each streamed answer
 * already takes. MEASURED, 2026-09-10: at 5s, three of eight leak probes died to
 * `2018: Invalid User Credentials`; at 25s, all eight got real answers.
 *
 * TWELVE GAPS, NOT THIRTEEN MINUTES. The count is `cases - 1` summed: 2 from 3
 * fit cases, 3 from 4 chat cases, 7 from 8 leak probes -- twelve. Twelve gaps
 * cost exactly one minute at the old 5s (matching the "about a minute"
 * evals/run.mjs used to gain) and five minutes at 25s, not the thirteen minutes
 * Day 1's 25-30s estimate implied.
 *
 * TWO RUNNERS IMPLEMENT THAT "MINUS ONE", and neither is THE mechanism. This
 * paragraph described one of them as though it were, which was true until issue
 * #291 and is now a sentence a reader cannot place. In evals/run.mjs, `runFit`
 * and `runChat` each skip the first case of their suite with a flag, and
 * `runLeak` skips the first probe of each case FILE it loads with an
 * `index > 0` test. In the Worker, `runPaced`
 * (workers/mcp/src/evals-workflow.ts) has a single `index > 0` test that serves
 * all three, and `runSuite` restarts it per leak case file so the two runners
 * agree. Per file and per suite are the same thing only because
 * `evals/cases/leak/` holds exactly one file today, which is why both spell it
 * the same way rather than either one simplifying.
 *
 * `--suite <name>`, which is evals/run.mjs's own flag, is the iteration path
 * when the full run's five minutes is too slow to run on every change -- that
 * is what keeps the full run a gate people still run rather than one they route
 * around. The scheduled runner has no equivalent and needs none: which suites
 * it runs is decided by which cron fired, through `suitesForCron` below.
 *
 * PACING IS THE REAL FIX and the retry above is the fallback, not the other way
 * round. Fewer requests is the only thing that helps a quota; see `RETRIES`.
 *
 * NOT paced: the judge call that follows each answer. It is the second half of
 * one case, and separating it would double the wall clock to buy back a request
 * the retry already covers.
 */
export const PACE_MS = 25000;

/**
 * The four suites, in the order a full run executes them. `leak` runs LAST
 * deliberately (evals/README.md): it is the private-tier disclosure gate, and
 * a failure there should be the last thing on screen rather than scrolled
 * past.
 */
export const SUITE_ORDER = ['tier', 'fit', 'chat', 'leak'] as const;
export type SuiteName = (typeof SUITE_ORDER)[number];

/**
 * Type guard for `SuiteName`, the same shape and the same reason as `isScope`
 * in src/lib/tier/token.ts: a caller holding an `unknown` value can narrow it
 * against `SUITE_ORDER` without repeating the cast `Array.prototype.includes`
 * otherwise forces on a `readonly SuiteName[]`.
 *
 * ITS CALLER IS A TRUST BOUNDARY, which is why a guard exists rather than a
 * cast at the one call site. `EvalsWorkflow` (workers/mcp/src/evals-workflow.ts)
 * is handed its suites as workflow params, and `wrangler workflows trigger`
 * will pass whatever JSON it is given: the TypeScript type on the params says
 * what a caller SHOULD send and enforces nothing at runtime.
 */
export function isSuiteName(value: unknown): value is SuiteName {
  return (SUITE_ORDER as readonly unknown[]).includes(value);
}

/**
 * The corpus refresh's own cron (workers/mcp/wrangler.jsonc's `triggers`),
 * named here rather than left implicit: a caller asking "does this
 * expression want evals" needs a way to tell "no, deliberately" from "this
 * mapping forgot to list it", and this constant is that answer for the one
 * cron on the MCP Worker that runs today and asks for no suite at all.
 */
export const CORPUS_CRON = '32 5 * * *';

/**
 * `tier` alone, daily: the cheapest suite, needs no token, and is the one
 * check the deployed private tier can fail silently between the runs a person
 * remembers to do by hand.
 */
export const EVALS_DAILY_CRON = '52 5 * * *';

/**
 * `fit`, `chat` and `leak`, weekly: the suites that spend inference and need
 * `RLME_EVAL_TOKEN`-equivalent access, run less often for the same reason
 * evals/README.md paces cases twenty-five seconds apart -- fewer requests is
 * what a shared quota actually wants.
 *
 * NINETY-FIVE MINUTES BEHIND `CORPUS_CRON`, AND THAT NUMBER IS SLACK RATHER
 * THAN MEASUREMENT. Two of these three suites are graded against the Vectorize
 * index the corpus job re-embeds and upserts the same morning, and a Vectorize
 * `upsert` is asynchronous: it returns a mutation id and the index reflects the
 * change some time afterwards. A `chat` case carrying a `min_sources`
 * expectation that queries a still-applying index goes red with no regression
 * behind it, on the one Sunday of the year when the answer matters.
 *
 * src/lib/corpus.ts is incremental, so most Sundays the refresh is close to
 * instant and any gap would do. The Sunday after content lands is the one where
 * it is not, and that is exactly the Sunday this schedule exists for.
 *
 * WHAT IS NOT KNOWN, said plainly because the gap was 35 minutes until issue
 * #291's review and 35 was no more measured than 95 is: nothing in this
 * repository records how long a non-trivial refresh takes, or how long
 * Vectorize takes to reflect one. WHAT WOULD SETTLE IT: time a refresh that
 * embeds a real batch of new documents, then poll the index for the last
 * upserted id until it answers, and record both numbers here with their date.
 * Until somebody does that, the honest move is a wide gap rather than a precise
 * one.
 *
 * THE `1` IS SUNDAY. Cloudflare numbers the day-of-week field 1 = Sunday to
 * 7 = Saturday, not the Unix 0 = Sunday, so this fires on Sundays. Every
 * comment and document said Monday until issue #340: the first scheduled weekly
 * rows in `eval_runs` (ids 41 to 43) are dated 2026-09-20, a Sunday, at 07:07
 * UTC, and reading them against "Mondays" cost an hour chasing a Workflow that
 * had worked. Sunday was kept and the prose corrected. `SUN` would say this in
 * the expression itself, but `suitesForCron` matches `controller.cron` by
 * equality and nothing here has measured whether Cloudflare echoes an
 * abbreviation back verbatim; a mismatch returns `[]` and the weekly run
 * disappears without a row. Measure that before adopting it.
 */
export const EVALS_WEEKLY_CRON = '7 7 * * 1';

/**
 * The suites a cron expression asks for, in run order, or `[]` for one that
 * asks for none -- including `CORPUS_CRON`, which is a different job on the
 * same Worker and never an evals trigger.
 */
export function suitesForCron(cron: string): SuiteName[] {
  if (cron === EVALS_DAILY_CRON) return ['tier'];
  if (cron === EVALS_WEEKLY_CRON) return ['fit', 'chat', 'leak'];
  return [];
}

/**
 * Whether the MCP Worker's `scheduled()` handler (Task 4) should run the
 * evals suites at all.
 *
 * Same shape as `corpusRefreshEnabled` (src/lib/corpus.ts), `FIT_ENGINE`
 * (src/lib/fit/engine.ts) and `signingKey` (src/lib/tier/grant.ts), and the
 * same three safety properties:
 *
 *   1. The DEPLOYED behaviour comes from the var being ABSENT, not from a
 *      default branch -- no wrangler.jsonc declares `EVALS_RUNNER`, and an
 *      absent var returns `true`.
 *   2. An unrecognised value THROWS rather than guessing: a typo that
 *      silently turned the scheduled run off would look exactly like a cron
 *      with nothing to do that morning, and the morning after, forever.
 *   3. The only accepted override is `'off'`, and it says in its own name
 *      what it does -- there is no third state to guess the meaning of.
 */
export function evalsRunEnabled(env: { EVALS_RUNNER?: string }): boolean {
  const mode = env.EVALS_RUNNER;
  if (mode === undefined) return true;
  if (mode === 'off') return false;
  throw new Error(`unrecognised EVALS_RUNNER: ${mode}`);
}
