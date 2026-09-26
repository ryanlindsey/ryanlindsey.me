// Retention enforcement (06 §2, 01 §5). The published policy says transcripts
// are kept 30 days and audit logs a year; this is the job that makes those
// sentences true rather than aspirational, and /ai-policy links the reader to
// the statement rather than to this file, which is why the numbers live in one
// exported constant instead of being inlined into three SQL strings.
//
// TABLE-DRIVEN so the policy and the code cannot drift: adding a table that
// stores something a visitor typed means adding a row here, and the test that
// pins this array is what turns "we should have added a window" into a red run.

export const RETENTION = [
  /** 04 §1 and /ai-policy: chat transcripts, thirty days, disclosed. */
  { table: 'chat_turns', column: 'created_at', days: 30 },
  /** 06 §2: the audit trail, one year. */
  { table: 'mcp_tool_calls', column: 'called_at', days: 365 },
  /**
   * One year, decided in the day-6 plan rather than inherited: migrations/0002
   * says the window is "the one this table's cleanup enforces" and there was no
   * cleanup. A fit report is a work product whose whole point is that somebody
   * was invited to circulate the link (04 §2), so a thirty-day window would
   * break the promise the permalink's own footer makes.
   *
   * EVERY ROW, WHATEVER ITS STATUS, and that was decided on 2026-09-25 (#357)
   * rather than inherited a second time. Since #274 the row is opened BEFORE
   * the run, so a refused, errored or abandoned run keeps the pasted
   * `target_description` on this same clock, where before it left no row at
   * all. The change arrived as a side effect of moving the insert; this note
   * is where it stops being one. Two alternatives were weighed and not taken:
   *
   * - Nulling the description when a run closes `failed`. The column is
   *   `NOT NULL` in 0006, so that is another table rebuild, and it would still
   *   miss the abandoned run: a `pending` row that nothing ever closes, like
   *   the one #349's confirmation left behind.
   * - A shorter window for non-`ok` rows. That splits one table across two
   *   clocks, which this array, `PUBLISHED_AS` and the table /ai-policy and
   *   /ops render are all keyed against as one row per table.
   *
   * What makes keeping it acceptable is that the text is out of every read
   * path a reader reaches: /fit/r/<id> does not select it. /ai-policy's "Fit
   * reports" paragraph says out loud that a run with no report keeps it, and
   * tests/governance.test.ts holds that sentence in place.
   */
  { table: 'fit_reports', column: 'created_at', days: 365 },
] as const;

/** A table this module trims, as a type, so a published name cannot miss one. */
export type RetainedTable = (typeof RETENTION)[number]['table'];

/**
 * What each retained table is called on /ai-policy.
 *
 * A table name is a schema identifier and the policy is written for a reader,
 * so the two cannot be the same string. They have to be bound to each other
 * somewhere, and this is that somewhere: the page renders these labels beside
 * `formatWindow(days)` and the prose below the table uses the same words for
 * the same row, so a reader following the rail from a table to the paragraph
 * that explains it does not meet a second name for the thing they just read.
 *
 * DECLARED HERE RATHER THAN ON THE PAGE, and the history is the argument. This
 * binding lived in tests/governance.test.ts while the page's numbers were
 * hand-typed prose and the test's only job was to check them. Issue #110 made
 * the page render the rows from `RETENTION`, which needs the binding at
 * runtime -- and a page cannot import a test, so leaving it there would have
 * meant two copies of the same register with nothing holding them together.
 *
 * TYPED AGAINST `RETENTION`, so adding a table without a published name is a
 * typecheck failure rather than a row rendered as "undefined". /ops keeps its
 * own labels (`RETENTION_LABELS` in src/pages/ops.astro) on purpose: a colophon
 * and a policy are written for different readers, the words differ because they
 * are meant to, and neither page carries a number the other has to agree with.
 */
export const PUBLISHED_AS: Record<RetainedTable, string> = {
  chat_turns: 'Chat transcripts',
  mcp_tool_calls: 'The tool-call audit trail',
  fit_reports: 'Fit reports',
};

export function retentionCutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * A window in `days` as the phrase the published policy says out loud.
 *
 * ONE SPELLING FOR TWO SURFACES, which is the whole reason this is a function
 * rather than an expression at each call site. `RETENTION` stores integers, and
 * the policy sentence for the audit trail is "a year" -- rendering `days`
 * directly gives "365 days", which is arithmetically the same statement and not
 * the one 06 §2 published. /ops and /ai-policy both render these numbers, so
 * without this they would be two hand-written translations of one constant,
 * free to disagree the first time either is edited.
 *
 * Years only when the window divides evenly into them, and plain days
 * otherwise: "547 days" is a worse sentence than "1.5 years" only until you
 * consider that a retention window nobody can restate exactly is not a policy.
 * No month arm, deliberately -- `RETENTION` has no such window today, and a
 * branch with no caller is a claim about a future nobody has made yet.
 */
export function formatWindow(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? '1 year' : `${years} years`;
  }
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * Deletes what is past its window, and reports what it deleted.
 *
 * `-1` for a table whose delete threw, rather than 0 or an exception: this runs
 * on a cron with nobody watching, and the two states worth telling apart are
 * "nothing was old enough" and "this did not run". One failing table must not
 * hold the others' data past its stated window, which is why each is its own
 * statement inside its own try rather than one batch.
 *
 * The table and column names are interpolated rather than bound, which is safe
 * here for a reason worth naming rather than assuming: both come from the
 * `as const` array above and can never be caller-supplied. Only the cutoff --
 * the one value derived from an argument -- is bound.
 */
export async function enforceRetention(db: D1Database, now: Date): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const { table, column, days } of RETENTION) {
    const cutoff = retentionCutoff(now, days);
    try {
      const result = await db
        .prepare(`DELETE FROM ${table} WHERE ${column} < ?`)
        .bind(cutoff)
        .run();
      deleted[table] = result.meta?.changes ?? 0;
    } catch (error) {
      console.error(`retention: ${table} could not be trimmed to ${cutoff}`, error);
      deleted[table] = -1;
    }
  }
  return deleted;
}
