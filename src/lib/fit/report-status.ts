/**
 * What `/fit/r/<id>` renders for a report that is not a finished report (#269).
 *
 * A CLOSED SET, for the reason src/lib/fit/errors.ts already records about the
 * form's error codes: this page is designed to be forwarded to people holding
 * no token, and a value that reaches the renderer from storage is a value a
 * future bug could put there. `fitFailureCopy` answers `null` for anything it
 * does not recognise, so the worst an unexpected code can do is show nothing.
 *
 * THE WRITER IS `completeRun` in workers/mcp/src/fit-start.ts, which is the
 * only thing that sets `fit_reports.failure_code` and sets it to exactly these
 * two values: `refused` when the deferred run threw `FitUnavailable`, and
 * `errored` for anything else. The two are worth telling apart on /ops even
 * though the reader is told the same thing, which is why they stay distinct
 * here rather than collapsing into one code.
 */
export type FitFailureCode = 'refused' | 'errored';

export const FIT_FAILURE_COPY: Record<FitFailureCode, string> = {
  // The engine declined and wrote a sentence about it -- the breaker, an empty
  // corpus, an answer that did not validate. The sentence stays in the log; the
  // reader is told the thing they can act on.
  refused: 'The fit engine could not complete this run. Ask for a fresh link.',
  errored: 'Something went wrong generating this report. Ask for a fresh link.',
};

export function fitFailureCopy(raw: string | null): string | null {
  if (raw === null) return null;
  return Object.hasOwn(FIT_FAILURE_COPY, raw) ? FIT_FAILURE_COPY[raw as FitFailureCode] : null;
}

/**
 * How long a pending row is worth refreshing for.
 *
 * Five minutes against a run MEASURED at 78,222 ms on 2026-09-18 leaves room
 * for a slow one without trapping a reader in a refresh loop. Computed at READ
 * time from `created_at` rather than written by a sweep, which is what makes it
 * correct when `ctx.waitUntil` dies without ever closing the row: nothing has
 * to run for the page to tell the truth.
 */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** Seconds between the holding page's own refreshes. */
export const REFRESH_SECONDS = 5;

export function isStale(createdAt: string, now: number): boolean {
  const started = Date.parse(createdAt);
  // An unreadable timestamp is stale. The alternative is a page that refreshes
  // forever on a row nothing can interpret.
  if (Number.isNaN(started)) return true;
  return now - started >= STALE_AFTER_MS;
}
