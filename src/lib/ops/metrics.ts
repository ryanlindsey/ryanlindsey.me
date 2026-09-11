// What /ops can say without any credential at all: the D1 half.
//
// PUBLIC TIER ONLY, AND IT IS SQL RATHER THAN TEMPLATE LOGIC (06 §1, 09 §2).
// The rule is that no campaign label, no audience and no gated tool name
// renders publicly, and the difference between filtering in the query and
// filtering in the page is what happens when someone adds a section: a page
// that receives only public rows cannot leak one by forgetting a condition,
// while a page that receives everything and filters on render leaks the first
// time somebody adds a "recent activity" list.
//
// Deliberately NOT imported here: `GATED_TOOL_NAMES`. Excluding gated tools by
// NAME would be a denylist -- correct today, wrong the first time a tool is
// added -- and it would put the list of gated tool names into the module that
// renders a public page. `tier = 'public'` is an allowlist on the property that
// actually matters, and `migrations/0001` guarantees the column is never NULL.

export interface EvalRunRow {
  ranAt: string;
  suite: string;
  total: number;
  passed: number;
  failed: number;
}

export interface OpsMetrics {
  windowDays: number;
  toolCalls: { tool: string; calls: number }[];
  chatSessions: number;
  /**
   * COUNTED, NEVER QUOTED. 06 §1 asks for "chat sessions", not transcripts, and
   * a public page must never render a visitor's question -- so `chat_turns` is
   * reachable from here as two integers and by no other shape.
   */
  chatTurns: number;
  /**
   * Counted and NOT broken down by audience. Every `fit_reports` row carries
   * the audience of the grant that produced it (migrations/0002), which is a
   * campaign label; a total is the largest thing this page can say about them
   * without naming one.
   */
  fitRuns: number;
  /** The latest run per suite, which is what 04 §4 asks /ops to publish. */
  evalRuns: EvalRunRow[];
}

export async function readOpsMetrics(
  db: D1Database,
  now: Date,
  windowDays = 30,
): Promise<OpsMetrics> {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const until = now.toISOString();

  const [tools, chat, fit, evals] = await db.batch([
    db
      .prepare(
        `SELECT tool, COUNT(*) AS calls FROM mcp_tool_calls
          WHERE tier = 'public' AND called_at >= ? AND called_at <= ?
          GROUP BY tool ORDER BY calls DESC, tool ASC`,
      )
      .bind(since, until),
    db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS turns
           FROM chat_turns WHERE created_at >= ? AND created_at <= ?`,
      )
      .bind(since, until),
    db
      .prepare(`SELECT COUNT(*) AS runs FROM fit_reports WHERE created_at >= ? AND created_at <= ?`)
      .bind(since, until),
    // The latest row per suite. A correlated subquery rather than a window
    // function: D1 is SQLite and supports both, and this shape reads the same to
    // whoever checks it against the table by hand.
    //
    // IT CORRELATES ON `id`, NOT ON `MAX(ran_at)`, AND THAT IS A BUG FIX RATHER
    // THAN A PREFERENCE. `WHERE ran_at = (SELECT MAX(ran_at) ...)` is a filter,
    // not a picker: EVERY row tied at a suite's maximum timestamp satisfies it.
    // MEASURED on /ops against a seeded database (day 6 Task 11 fix round 1):
    // five `eval_runs` rows shared one `(suite, ran_at)` and the page rendered
    // that suite five times under a heading reading "latest run per suite",
    // which is indistinguishable from a broken page.
    //
    // Ties are not a contrivance. `ran_at` is TEXT written by the eval harness,
    // so two suites -- or two runs of one suite -- finishing inside the same
    // stamped instant collide exactly, and a re-run of a recorded timestamp
    // collides deliberately.
    //
    // `ORDER BY ran_at DESC, id DESC LIMIT 1` picks ONE row and always the same
    // one: newest by stamp, and among equal stamps the row inserted last, which
    // is the only thing this table knows about the order two identical
    // timestamps actually happened in. `id` is `INTEGER PRIMARY KEY
    // AUTOINCREMENT` (migrations/0002), so it is never reused and never NULL.
    db.prepare(
      `SELECT ran_at, suite, total, passed, failed FROM eval_runs
        WHERE id = (SELECT id FROM eval_runs AS latest
                     WHERE latest.suite = eval_runs.suite
                     ORDER BY latest.ran_at DESC, latest.id DESC
                     LIMIT 1)
        ORDER BY suite ASC`,
    ),
  ]);

  return {
    windowDays,
    toolCalls: (tools.results as { tool: string; calls: number }[]).map((row) => ({
      tool: row.tool,
      calls: Number(row.calls),
    })),
    chatSessions: Number((chat.results[0] as { sessions?: number })?.sessions ?? 0),
    chatTurns: Number((chat.results[0] as { turns?: number })?.turns ?? 0),
    fitRuns: Number((fit.results[0] as { runs?: number })?.runs ?? 0),
    evalRuns: (evals.results as Record<string, unknown>[]).map((row) => ({
      ranAt: String(row.ran_at),
      suite: String(row.suite),
      total: Number(row.total),
      passed: Number(row.passed),
      failed: Number(row.failed),
    })),
  };
}
