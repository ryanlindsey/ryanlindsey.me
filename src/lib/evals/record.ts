// Turning a suite's case results into the row a runner records, lifted from
// evals/run.mjs's `pass`, `fail` and `report()`. Pure: this module decides
// what the row SAYS, and never how it gets written -- evals/run.mjs hand-
// builds a SQL statement from it today, and the MCP Worker's scheduled runner
// (Task 4) will bind it as parameters instead. Two write paths only stay in
// agreement if they compute the row from one function.

/**
 * One case's outcome. `notes` is what an operator reads when it fails.
 *
 * `unreached` marks a failure that never reached the model at all, which
 * `summarize` needs to tell apart from a failure the model produced. It is a
 * field rather than a pattern matched in `notes`, because notes are free text
 * and a local case's notes are redacted before anything else reads them.
 */
export interface CaseResult {
  id: string;
  ok: boolean;
  notes: string;
  local: boolean;
  unreached?: true;
}

export const pass = (id: string, local: boolean): CaseResult => ({
  id,
  ok: true,
  notes: '',
  local,
});
export const fail = (id: string, notes: string, local: boolean): CaseResult => ({
  id,
  ok: false,
  notes,
  local,
});

/**
 * A failed case whose request never reached the model: the chat endpoint
 * answered `unreachable` past every retry and returned no answer text, or
 * `analyze_fit` refused with the `unavailable` reason (`toolUnavailable` in
 * ./checks.ts). Still `ok: false`, since an operator reading the terminal
 * needs to see it, but `summarize` counts it in `unreached` rather than in
 * `failed`, and records a suite made only of these as one that did not run.
 */
export const unreached = (id: string, notes: string, local: boolean): CaseResult => ({
  ...fail(id, notes, local),
  unreached: true,
});

export type EvalRunStatus = 'ran' | 'incomplete';

/**
 * One row of the `eval_runs` table, as a runner writes it.
 *
 * NAMED `EvalRunRecord`, NOT `EvalRunRow`: `EvalRunRow` is already taken, in
 * src/lib/ops/metrics.ts, for the narrower shape /ops reads BACK from that
 * same table (no `notes`, no `status` -- a public page has no business
 * rendering either). The two names describe opposite directions across the
 * same table and that older name stays put.
 */
export interface EvalRunRecord {
  ranAt: string;
  suite: string;
  total: number;
  passed: number;
  failed: number;
  notes: string;
  status: EvalRunStatus;
  /**
   * Cases that never reached the model, kept out of `total`, `passed` and
   * `failed` (issue #427). Zero on an `incomplete` row: that row's `status`
   * already says nothing ran, and its notes say why.
   */
  unreached: number;
}

export const localCount = (results: CaseResult[]): number =>
  results.filter((result) => result.local).length;

/**
 * The redacted, truncated notes string for a recorded row. NOT SQL-escaped.
 * evals/run.mjs's `report()` applies `.replace(/'/g, "''")` after this, and
 * the ordering matters for the reason its own comment already gives:
 * truncating the RAW string first and escaping after means a cut can never
 * land inside a doubled `''` pair and drop one of its two quotes. Escaping
 * first, then truncating, could cut a doubled pair in half and unterminate
 * the SQL literal that follows -- so this function does the truncation and
 * leaves escaping to whichever caller still needs it. The Worker path binds
 * parameters and needs no escaping at all, which is the second reason it does
 * not belong here.
 *
 * A `local` result (evals/README.md: a case loaded from a gitignored
 * `*.local.json` file) may carry its real id and model-derived failure text --
 * exactly what the no-real-campaign-data rule exists to keep out of anything
 * that is not this operator's own terminal. `eval_runs` is remote, so a local
 * result contributes only the opaque marker below; its id and notes never
 * reach this string.
 */
export function redactedNotes(results: CaseResult[]): string {
  return results
    .filter((result) => !result.ok)
    .map((result) => (result.local ? '<local case, redacted>' : `${result.id}: ${result.notes}`))
    .join(' | ')
    .slice(0, 900);
}

/**
 * The row for a suite that ran. A `local` result still counts toward
 * `total`/`passed`/`failed`, or toward `unreached` -- a count leaks nothing a
 * real id or a fragment of model output would -- and only its redaction,
 * never its exclusion, is what keeps it out of `notes`.
 *
 * A SUITE WHERE NO CASE REACHED THE MODEL DID NOT RUN, and the row says so
 * rather than reporting zero of n (issue #341). `leak` rows 32, 34 and 43
 * recorded 0/8 with every probe reading `the endpoint refused with
 * "unreachable"`, and /ops published that as the disclosure gate's current
 * result, in place of the one real finding from row 38 behind it. A transport
 * fault is not a gate result, and publishing it as a pass rate is the thing
 * migrations/0005_eval_run_status.sql exists to stop.
 *
 * ONLY EVERY CASE, NOT ANY. One case that reached the model makes the rest of
 * the row a real, if partial, gate result: a suite where seven probes timed
 * out and one leaked has found a leak.
 *
 * An earlier version of this comment said the unreached cases in such a row
 * still count as failures, and until issue #427 they did. `fit` row 41, on
 * 2026-09-20, published 1/3 for a run where two `analyze_fit` calls never
 * returned a model answer, and /ops showed that outage as a regression in the
 * prompt. Now `total`, `passed` and `failed` count only the graded cases, and
 * the rest are counted in `unreached`. Their notes still say why, redacted
 * like any other failure's, since `redactedNotes` reads `ok` and an unreached
 * case is never ok.
 */
export function summarize(suite: string, results: CaseResult[], ranAt: string): EvalRunRecord {
  if (results.length > 0 && results.every((result) => result.unreached)) {
    const reason = `no case reached the model: ${redactedNotes(results)}`.slice(0, 900);
    return incompleteRow(suite, reason, ranAt);
  }
  const graded = results.filter((result) => !result.unreached);
  const passed = graded.filter((result) => result.ok).length;
  return {
    ranAt,
    suite,
    total: graded.length,
    passed,
    failed: graded.length - passed,
    notes: redactedNotes(results),
    status: 'ran',
    unreached: results.length - graded.length,
  };
}

/**
 * The row for a suite that could not run at all. Zeroed counts rather than
 * omission: a suite that could not run must be visible in whatever reads
 * `eval_runs`, not merely absent from it.
 *
 * ONLY THE SCHEDULED RUNNER CALLS THIS DIRECTLY, and `summarize` calls it for
 * a suite where no case reached the model, which evals/run.mjs reaches too. An
 * earlier version of this comment offered "no token, in evals/run.mjs's case"
 * as the example, and that case does not exist: evals/run.mjs skips a suite
 * with no token, writes no row for it, and never calls this function. The two
 * callers of `eval_runs` differ here deliberately, and each one's reason is the
 * other's refusal.
 *
 * A scheduled run that could not run is news: something is broken, nobody was
 * watching, and this row is how anyone finds out. A manual skip is the
 * operator's own choice in their own shell, already on their own terminal and
 * already in the exit code, and recording it would replace a real older result
 * on a public page with "did not run" because a variable was not exported. See
 * `report()` in evals/run.mjs, which says the same thing from the other side.
 */
export function incompleteRow(suite: string, reason: string, ranAt: string): EvalRunRecord {
  return {
    ranAt,
    suite,
    total: 0,
    passed: 0,
    failed: 0,
    notes: reason,
    status: 'incomplete',
    unreached: 0,
  };
}
