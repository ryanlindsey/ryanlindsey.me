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
   */
  { table: 'fit_reports', column: 'created_at', days: 365 },
] as const;

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
