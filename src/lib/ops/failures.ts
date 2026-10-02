// What /ops can say about failures: how many calls failed, on which surface,
// from which origin, and for which reason -- and nothing that identifies a
// call.
//
// PRIVACY IS THE DESIGN (06 §1, 09 §2). `FailureMetrics` carries a surface, an
// origin, counts and a reason from a closed vocabulary. It carries no tool
// name, no audience, no failure detail and no token. Tool names are folded
// into surfaces HERE, before the value is returned, and therefore before
// `readOrNull` writes it to KV: a gated tool's name never reaches the cache or
// the page, so a template added later cannot render one by forgetting a
// filter. `failure_detail` and `audience` are never selected at all. The same
// reasoning as src/lib/ops/metrics.ts, one layer earlier.
//
// A STORED REASON THAT IS NOT IN `FAILURE_REASONS` COUNTS AS `unrecorded`. The
// column is free text in SQLite, and a later Worker may write a reason this
// build has not been told about; the page only ever receives the closed
// vocabulary, so it cannot render an arbitrary stored string.
//
// SEPARATE FROM THE `readOpsMetrics` BATCH ON PURPOSE. These statements name
// `failure_reason` (migrations/0009). CLAUDE.md records what one unknown column
// does to a `db.batch`: the whole transaction rejects, and every figure in that
// batch would read "could not be read" until the migration is applied. Kept
// apart, an unmigrated database costs this section and nothing else.
//
// `fit_reports` IS NOT COUNTED HERE. The fit-runs figures in `readOpsMetrics`
// already publish it by status, and counting it again would count /fit twice.
// The `fit` surface below is the `analyze_fit` tool over /mcp, which stored no
// report row until #490. It does now: the tool opens its run the way the form
// does, and a failed run is answered by `get_fit_report`, which is why that
// tool is on this surface too. So this surface counts calls and the fit-runs
// figures count runs, and a run reached over /mcp appears in both, once as
// what was called and once as what the run came to.
//
// ORIGIN FOLLOWS THE RULE `readOpsMetrics` USES, inverted. The scheduled eval
// run is marked by `EVALS_AGENT` on a tool call and `EVALS_SURFACE` on a chat
// turn. A tool call with no user agent is live: `NULL LIKE ...` is NULL in
// SQLite, which is why the test is spelled `IS NOT NULL AND ... LIKE`.

import { EVALS_AGENT, EVALS_SURFACE } from '../evals/plan';
import { FAILURE_REASONS, type FailureReason } from '../failure/classify';

export const FAILURE_SURFACES = [
  'chat',
  'fit',
  'search',
  'judge',
  'public tools',
  'private tools',
] as const;
export type FailureSurface = (typeof FAILURE_SURFACES)[number];
export type FailureOrigin = 'live' | 'scheduled';

export interface FailureRow {
  surface: FailureSurface;
  origin: FailureOrigin;
  total: number;
  failed: number;
  byReason: Partial<Record<FailureReason | 'unrecorded', number>>;
}

export interface FailureMetrics {
  rows: FailureRow[];
}

/** The surface a tool call belongs to. The name itself goes no further. */
export function surfaceOf(tool: string, tier: 'public' | 'private'): FailureSurface {
  if (tool === 'analyze_fit' || tool === 'get_fit_report') return 'fit';
  if (tool === 'judge_answer') return 'judge';
  if (tool === 'search_writing') return 'search';
  return tier === 'private' ? 'private tools' : 'public tools';
}

const ORIGINS: FailureOrigin[] = ['live', 'scheduled'];

export async function readFailureMetrics(
  db: D1Database,
  now: Date,
  windowDays: number,
): Promise<FailureMetrics> {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const until = now.toISOString();

  const [tools, chat] = await db.batch([
    db
      .prepare(
        `SELECT tool, tier,
                (user_agent IS NOT NULL AND user_agent LIKE ?) AS scheduled,
                failure_reason,
                COUNT(*) AS total,
                TOTAL(outcome <> 'ok') AS failed
           FROM mcp_tool_calls
          WHERE called_at >= ? AND called_at <= ?
          GROUP BY tool, tier, scheduled, failure_reason`,
      )
      .bind(`${EVALS_AGENT}%`, since, until),
    db
      .prepare(
        `SELECT (surface = ?) AS scheduled,
                failure_reason,
                COUNT(*) AS total,
                TOTAL(outcome <> 'ok') AS failed
           FROM chat_turns
          WHERE created_at >= ? AND created_at <= ?
          GROUP BY scheduled, failure_reason`,
      )
      .bind(EVALS_SURFACE, since, until),
  ]);

  const cells = new Map<string, FailureRow>();
  const add = (
    surface: FailureSurface,
    scheduled: unknown,
    reason: unknown,
    total: unknown,
    failed: unknown,
  ) => {
    const origin: FailureOrigin = Number(scheduled) === 1 ? 'scheduled' : 'live';
    const key = `${surface}/${origin}`;
    let row = cells.get(key);
    if (!row) {
      row = { surface, origin, total: 0, failed: 0, byReason: {} };
      cells.set(key, row);
    }
    row.total += Number(total);
    const failures = Number(failed);
    if (failures > 0) {
      row.failed += failures;
      const known =
        typeof reason === 'string' && (FAILURE_REASONS as readonly string[]).includes(reason);
      const bucket = known ? (reason as FailureReason) : 'unrecorded';
      row.byReason[bucket] = (row.byReason[bucket] ?? 0) + failures;
    }
  };

  for (const r of tools.results as Record<string, unknown>[]) {
    const tier = r.tier === 'private' ? 'private' : 'public';
    add(surfaceOf(String(r.tool), tier), r.scheduled, r.failure_reason, r.total, r.failed);
  }
  for (const r of chat.results as Record<string, unknown>[]) {
    add('chat', r.scheduled, r.failure_reason, r.total, r.failed);
  }

  const rows: FailureRow[] = [];
  for (const surface of FAILURE_SURFACES) {
    for (const origin of ORIGINS) {
      const row = cells.get(`${surface}/${origin}`);
      if (row && row.total > 0) rows.push(row);
    }
  }
  return { rows };
}
