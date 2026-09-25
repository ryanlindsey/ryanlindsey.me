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
// THE SCHEDULED EVAL RUN'S OWN TRAFFIC IS EXCLUDED HERE, AND IN SQL FOR THE
// SAME REASON THE TIER FILTER IS (issue #291). The run calls this system the
// way a client does, on purpose, so its calls are ordinary rows: the daily
// `tier` suite asks every no-required-argument PUBLIC tool for its output --
// about 150 rows a month, roughly 30 of them naming `request_private_access`,
// which workers/mcp/src/tools.ts calls a high-intent event worth a
// notification -- and the weekly run adds twelve `POST /chat` turns, each sent
// with no `sessionId`, so `handleChat` mints a session per turn and the page
// gains a floor of about 52 sessions and 52 turns per window that nobody
// produced. Issue #291 was opened while auditing exactly these figures, so a
// scheduled run that inflated them would corrupt the instrument that found the
// problem.
//
// WHAT THIS DOES NOT CONTRADICT. workers/mcp/src/chat.ts records a ruling that
// deliberately keeps the MANUAL harness visible here, and that ruling stands:
// `npm run evals` runs because a person decided to run it, from a real machine
// over the public internet, and its turns are traffic this site really served.
// An unattended schedule is a different thing -- nobody asked for it, it runs
// whether or not anyone is looking, and its volume is a property of a cron
// expression rather than of interest in this site. The two filters below name
// the scheduled runner's own marker (`EVALS_USER_AGENT`, `EVALS_SURFACE` in
// src/lib/evals/plan.ts) and nothing broader, which is what keeps the manual
// runner counted: it sets no user agent of ours and files as `'direct'`.
//
// TWO FILTERS AND NOT THREE, checked rather than assumed. `fit_reports` is
// written by src/pages/fit/run.ts and by nothing else: `analyze_fit` returns a
// report and stores none, so a run that reaches the tool over `/mcp` -- which
// is what both eval runners do -- produces no row in that table at all. The
// gated tool calls the weekly run makes are `tier = 'private'` besides, so the
// allowlist above has already excluded them.
//
// Deliberately NOT imported here: `GATED_TOOL_NAMES`. Excluding gated tools by
// NAME would be a denylist -- correct today, wrong the first time a tool is
// added -- and it would put the list of gated tool names into the module that
// renders a public page. `tier = 'public'` is an allowlist on the property that
// actually matters, and `migrations/0001` guarantees the column is never NULL.

import { EVALS_AGENT, EVALS_SURFACE } from '../evals/plan';

export interface EvalRunRow {
  ranAt: string;
  suite: string;
  total: number;
  passed: number;
  failed: number;
  /**
   * 'ran' or 'incomplete' (migrations/0005, src/lib/evals/record.ts's
   * `EvalRunStatus`). Kept as `string` rather than importing that union: this
   * file reads the table back for a public page, and /ops has to render
   * whatever value is actually stored, including one written by a future
   * status this type has not been told about, rather than narrow a value
   * SQLite already accepted.
   */
  status: string;
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
   * campaign label; totals are the largest thing this page can say about them
   * without naming one.
   *
   * BROKEN DOWN BY STATUS INSTEAD, since issue #353. This used to be one
   * number counting every row, and a row is written when a run STARTS
   * (migrations/0006), so a run cancelled while `pending` or ended `failed`
   * published exactly like one that produced a report. During #349 production
   * held a `pending` row that never would finish, and /ops counted it: the page
   * read healthiest at the moment the feature was producing nothing.
   *
   * `reports` answers the question a reader asks of this figure, whether the
   * feature produced anything. The other three keep the runs that did not from
   * vanishing into it. `unfinished` is every `pending` row and deliberately
   * does not guess which are in flight: a live run is pending for about ninety
   * seconds and an abandoned one forever, and the row does not say which.
   * `started` counts every row, so a status this code has not been told about
   * still appears there rather than nowhere, and the three parts can then sum
   * to less than it.
   */
  fitRuns: { started: number; reports: number; failed: number; unfinished: number };
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

  // `LIKE` rather than equality on the tool-call side, and the asymmetry is
  // deliberate. `user_agent` holds what a client sent, verbatim and versioned,
  // so a prefix is what survives `EVALS_USER_AGENT` becoming `/2`; `surface` is
  // a value this Worker chose from a closed set when it wrote the row, so
  // equality is exactly right there. Neither pattern contains a `%` or a `_`,
  // so there is nothing to escape.
  //
  // `user_agent IS NULL OR` IS NOT DEFENSIVE PADDING. That column is
  // nullable (migrations/0001) and a caller sending no user agent at all is
  // ordinary, but `NULL NOT LIKE '...'` evaluates to NULL rather than to true
  // in SQLite -- so without the first clause this filter would silently drop
  // every anonymous call that named no client, which is a large share of the
  // figure it is meant to leave alone. `surface` is NOT NULL (migrations/0004)
  // and needs no such clause.
  const agentPrefix = `${EVALS_AGENT}%`;

  const [tools, chat, fit, evals] = await db.batch([
    db
      .prepare(
        `SELECT tool, COUNT(*) AS calls FROM mcp_tool_calls
          WHERE tier = 'public' AND called_at >= ? AND called_at <= ?
            AND (user_agent IS NULL OR user_agent NOT LIKE ?)
          GROUP BY tool ORDER BY calls DESC, tool ASC`,
      )
      .bind(since, until, agentPrefix),
    db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS turns
           FROM chat_turns WHERE created_at >= ? AND created_at <= ?
             AND surface <> ?`,
      )
      .bind(since, until, EVALS_SURFACE),
    // `TOTAL` rather than `SUM`: over no rows `SUM` is NULL and `TOTAL` is
    // 0.0, so an empty window reads as zeros without a guard on each field.
    db
      .prepare(
        `SELECT COUNT(*) AS started,
                TOTAL(status = 'ok') AS reports,
                TOTAL(status = 'failed') AS failed,
                TOTAL(status = 'pending') AS unfinished
           FROM fit_reports WHERE created_at >= ? AND created_at <= ?`,
      )
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
      `SELECT ran_at, suite, total, passed, failed, status FROM eval_runs
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
    fitRuns: fitRuns(fit.results[0] as Record<string, unknown> | undefined),
    evalRuns: (evals.results as Record<string, unknown>[]).map((row) => ({
      ranAt: String(row.ran_at),
      suite: String(row.suite),
      total: Number(row.total),
      passed: Number(row.passed),
      failed: Number(row.failed),
      status: String(row.status),
    })),
  };
}

function fitRuns(row: Record<string, unknown> | undefined): OpsMetrics['fitRuns'] {
  const figure = (key: string) => Number(row?.[key] ?? 0);
  return {
    started: figure('started'),
    reports: figure('reports'),
    failed: figure('failed'),
    unfinished: figure('unfinished'),
  };
}
