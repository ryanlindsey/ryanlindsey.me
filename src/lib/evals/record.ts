// Turning a suite's case results into the row a runner records, lifted from
// evals/run.mjs's `pass`, `fail` and `report()`. Pure: this module decides
// what the row SAYS, and never how it gets written -- evals/run.mjs hand-
// builds a SQL statement from it today, and the MCP Worker's scheduled runner
// (Task 4) will bind it as parameters instead. Two write paths only stay in
// agreement if they compute the row from one function.

/** One case's outcome. `notes` is what an operator reads when it fails. */
export interface CaseResult {
  id: string;
  ok: boolean;
  notes: string;
  local: boolean;
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
 * `total`/`passed`/`failed` -- a count leaks nothing a real id or a fragment
 * of model output would -- and only its redaction, never its exclusion, is
 * what keeps it out of `notes`.
 */
export function summarize(suite: string, results: CaseResult[], ranAt: string): EvalRunRecord {
  const passed = results.filter((result) => result.ok).length;
  return {
    ranAt,
    suite,
    total: results.length,
    passed,
    failed: results.length - passed,
    notes: redactedNotes(results),
    status: 'ran',
  };
}

/**
 * The row for a suite that could not run at all (no token, in evals/run.mjs's
 * case). Zeroed counts rather than omission: a suite that could not run must
 * be visible in whatever reads `eval_runs`, not merely absent from it.
 */
export function incompleteRow(suite: string, reason: string, ranAt: string): EvalRunRecord {
  return { ranAt, suite, total: 0, passed: 0, failed: 0, notes: reason, status: 'incomplete' };
}
