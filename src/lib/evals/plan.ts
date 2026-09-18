// Pacing and scheduling for the eval suites (04 §4). Pure constants and pure
// mappings: nothing here sleeps, fetches, or reads a binding. The pacing
// numbers were measured against evals/run.mjs's actual runs against the
// deployed MCP Worker, and both runners -- evals/run.mjs today, the MCP
// Worker's scheduled runner in Task 4 -- read the same numbers rather than
// each tuning its own, because a quota measured once should not need
// re-discovering twice.

/**
 * ONE client retry, and the number is small because it is not the first one.
 *
 * WHAT IS BEING RETRIED, measured 2026-09-10: the AI Gateway answers `2018:
 * Invalid User Credentials` when a rate limit is hit -- an auth error's wording
 * on a rate-limit fault, recorded in 10 §5 -- and `handleChat` maps it to the
 * `unreachable` code, which is the one `TRANSIENT` matches. The gateway
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
 * TWELVE GAPS, NOT THIRTEEN MINUTES. `runFit` and `runChat` each skip the first
 * case of their suite via a flag; `runLeak` skips the first probe of each case
 * file it loads via `index > 0`, which is the same thing only because
 * `evals/cases/leak/` holds exactly one file today. So the paced gap count is
 * `cases - 1` summed: 2 from 3 fit cases, 3 from 4 chat cases, 7 from 8 leak
 * probes -- twelve. Twelve gaps cost exactly one minute at the old 5s (matching
 * the "about a minute" evals/run.mjs used to gain) and five minutes at 25s, not the
 * thirteen minutes Day 1's 25-30s estimate implied. `--suite <name>` is the
 * iteration path when the full run's five minutes is too slow to run on every
 * change -- that is what keeps the full run a gate people still run rather than
 * one they route around.
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
 */
export const EVALS_WEEKLY_CRON = '7 6 * * 1';

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
