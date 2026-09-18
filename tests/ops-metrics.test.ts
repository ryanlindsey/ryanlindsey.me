import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SITE_HARNESS_WORKERS } from './workers';
import { readOpsMetrics } from '../src/lib/ops/metrics';
import { EVALS_SURFACE, EVALS_USER_AGENT } from '../src/lib/evals/plan';

/**
 * The D1 half of /ops (06 §1), against a REAL D1 rather than a stub.
 *
 * A harness suite because the subject is the SQL: the public-tier filter, the
 * window bounds and the latest-run-per-suite correlation are all properties of
 * the query text, and a fake `D1Database` that returned canned rows would
 * assert that the mapping code compiles and nothing else.
 *
 * The public-tier filter is the assertion that matters most on this page, so it
 * is asserted twice and from two directions: once on the shape of the result,
 * and once on the SERIALISED result, which is the thing that actually reaches a
 * template.
 */
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });
let db: D1Database;

beforeAll(async () => {
  await server.listen();
  // The type argument goes on `getWorker`, not on `getEnv` -- `getEnv()` takes
  // none (wrangler-dist/cli.d.ts) -- and it is what types `applyD1Migrations`'s
  // binding name.
  const site = server.getWorker<{ DB: D1Database }>();
  // Without this the four tables do not exist and every INSERT below throws.
  await site.applyD1Migrations('DB');
  db = (await site.getEnv()).DB;
  const now = new Date('2026-09-09T12:00:00.000Z').toISOString();
  const old = new Date('2026-06-01T12:00:00.000Z').toISOString();
  // EVERY row this file asserts on is seeded here, including the chat turns and
  // the eval runs. An earlier version seeded those two inside the tests that
  // read them, which made the zero-window test below pass only because it was
  // DECLARED FIRST -- and `evalRuns` is deliberately un-windowed, so no date
  // argument could have isolated it. A reorder, a `.only`, or
  // `--sequence.shuffle` would have turned that into a spurious failure.
  await db.batch([
    db
      .prepare(
        `INSERT INTO mcp_tool_calls (called_at, tool, args_hash, tier, audience, outcome, duration_ms)
       VALUES (?, 'get_resume', 'h', 'public', NULL, 'ok', 12)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO mcp_tool_calls (called_at, tool, args_hash, tier, audience, outcome, duration_ms)
       VALUES (?, 'get_resume', 'h', 'public', NULL, 'ok', 20)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO mcp_tool_calls (called_at, tool, args_hash, tier, audience, outcome, duration_ms)
       VALUES (?, 'analyze_fit', 'h', 'private', 'label-a', 'ok', 900)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO mcp_tool_calls (called_at, tool, args_hash, tier, audience, outcome, duration_ms)
       VALUES (?, 'get_resume', 'h', 'public', NULL, 'ok', 12)`,
      )
      .bind(old),
    // THE SCHEDULED EVAL RUN'S OWN TRAFFIC, seeded here because it is
    // indistinguishable from a visitor's in every column but this one. The
    // daily `tier` suite calls every no-required-argument public tool
    // anonymously, which is the suite's whole point, so each call lands in
    // `mcp_tool_calls` with `tier = 'public'` -- roughly 150 rows a month, and
    // about 30 of them naming `request_private_access`, which is the tool on
    // that page a reader treats as most meaningful. `user_agent` is the only
    // thing that tells them apart.
    db
      .prepare(
        `INSERT INTO mcp_tool_calls (called_at, tool, args_hash, tier, audience, user_agent, outcome, duration_ms)
       VALUES (?, 'request_private_access', 'h', 'public', NULL, ?, 'ok', 8)`,
      )
      .bind(now, EVALS_USER_AGENT),
    // And the weekly half: twelve `POST /chat` turns per run, each sent with no
    // `sessionId`, so `handleChat` mints a fresh session for every one of them
    // and `chat_turns` gains twelve sessions and twelve turns that no human
    // produced. Two here is enough to fail a query that counts them.
    ...['e1', 'e2'].map((id) =>
      db
        .prepare(
          `INSERT INTO chat_turns (id, session_id, created_at, question, answer, model,
                                   sources_json, cited, invalid_citations, outcome, duration_ms, surface)
           VALUES (?, ?, ?, 'an-eval-probe', 'an-answer', 'm', '[]', 0, 0, 'ok', 10, ?)`,
        )
        .bind(id, `eval-session-${id}`, '2026-09-09T09:30:00.000Z', EVALS_SURFACE),
    ),
    // THE MANUAL HARNESS, WHICH IS STILL COUNTED. `evals/run.mjs` posts to
    // `/chat` from the operator's own shell and sets no `user-agent` of this
    // repository's, so `handleChat` files it under `'direct'` exactly as it
    // always has. workers/mcp/src/chat.ts records the ruling that keeps it
    // visible on /ops, and the exclusion below must not quietly widen to cover
    // it: a person chose to run that one.
    db.prepare(
      `INSERT INTO chat_turns (id, session_id, created_at, question, answer, model,
                                 sources_json, cited, invalid_citations, outcome, duration_ms, surface)
         VALUES ('d1', 'manual-session', '2026-09-09T09:40:00.000Z', 'q', 'a', 'm', '[]', 0, 0, 'ok', 10, 'direct')`,
    ),
    // Two turns in one session and one in another, so `chatSessions` and
    // `chatTurns` differ and a query counting rows for both would fail.
    ...['a', 'b', 'c'].map((id, index) =>
      db
        .prepare(
          `INSERT INTO chat_turns (id, session_id, created_at, question, answer, model,
                                   sources_json, cited, invalid_citations, outcome, duration_ms, surface)
           VALUES (?, ?, ?, 'what-a-visitor-typed', 'an-answer', 'm', '[]', 0, 0, 'ok', 10, 'site')`,
        )
        .bind(id, index === 2 ? 'session-2' : 'session-1', '2026-09-09T09:00:00.000Z'),
    ),
    // Two runs of one suite and one of another, so "latest per suite" has
    // something to be wrong about.
    db.prepare(
      `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed)
         VALUES ('2026-09-01T00:00:00.000Z', 'chat', 'm', 10, 5, 5)`,
    ),
    db.prepare(
      `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed)
         VALUES ('2026-09-08T00:00:00.000Z', 'chat', 'm', 10, 9, 1)`,
    ),
    db.prepare(
      `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed)
         VALUES ('2026-09-07T00:00:00.000Z', 'tier', 'm', 4, 4, 0)`,
    ),
    // TWO ROWS OF ONE SUITE AT AN IDENTICAL `ran_at`, which is what the
    // correlated MAX this query used to carry could not narrow: it filtered on
    // the maximum timestamp rather than picking a row, so both of these came
    // back and /ops rendered one suite twice under a heading reading "latest run
    // per suite". Seeded here rather than in the test that reads it, like every
    // other row in this file, so no test depends on declaration order.
    //
    // Inserted in a `batch`, so these two land in this order and the second gets
    // the higher `id` -- which is the tie-break, and therefore the row that must
    // win below.
    db.prepare(
      `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed)
         VALUES ('2026-09-06T00:00:00.000Z', 'bisect', 'm', 6, 5, 1)`,
    ),
    db.prepare(
      `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed)
         VALUES ('2026-09-06T00:00:00.000Z', 'bisect', 'm', 6, 6, 0)`,
    ),
    // An older RAN row and a newer INCOMPLETE row for the same suite
    // (migrations/0005). This is the regression the "latest per suite" picker
    // has to survive: it selects on `ran_at`/`id` alone and never on `status`,
    // so a suite that stops running must still displace its own last pass.
    // Explicit `status` on both -- the default only covers a row that omits
    // the column, which every OTHER seeded row in this file deliberately does.
    db.prepare(
      `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed, status)
         VALUES ('2026-09-02T00:00:00.000Z', 'fit', 'm', 8, 8, 0, 'ran')`,
    ),
    db.prepare(
      `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed, status)
         VALUES ('2026-09-08T12:00:00.000Z', 'fit', NULL, 0, 0, 0, 'incomplete')`,
    ),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe('readOpsMetrics', () => {
  test('counts public-tier tool calls inside the window and nothing else', async () => {
    const metrics = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 30);
    expect(metrics.toolCalls).toEqual([{ tool: 'get_resume', calls: 2 }]);
  });

  test('NO private-tier row reaches the page, by tool name or by count', async () => {
    const metrics = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 30);
    const rendered = JSON.stringify(metrics);
    expect(rendered).not.toContain('analyze_fit');
    expect(rendered).not.toContain('label-a');
    expect(rendered).not.toContain('private');
  });

  test('the window is honoured -- an older row is outside it', async () => {
    const wide = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 365);
    expect(wide.toolCalls).toEqual([{ tool: 'get_resume', calls: 3 }]);
  });

  test('a window containing no row reports zeros rather than throwing', async () => {
    // Every WINDOWED figure, against a window seeded rows cannot reach. This
    // holds whatever else has run, which is the point of it -- the brief's
    // version also asserted `evalRuns` was empty, and that was only ever true
    // because the eval rows had not been inserted yet. `evalRuns` is
    // deliberately un-windowed, so it is asserted in the two tests below
    // instead, where the property is actually the subject.
    const metrics = await readOpsMetrics(db, new Date('2020-01-01T00:00:00.000Z'), 1);
    expect(metrics.toolCalls).toEqual([]);
    expect(metrics.chatSessions).toBe(0);
    expect(metrics.chatTurns).toBe(0);
    expect(metrics.fitRuns).toBe(0);
  });

  test('chat sessions are distinct sessions, and turns are turns', async () => {
    const metrics = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 30);
    // Three sessions and four turns: two `'site'` sessions carrying three turns
    // between them, plus the manual harness's one `'direct'` turn. The two
    // `'evals'` turns are the scheduled run's and are excluded in SQL.
    expect(metrics.chatSessions).toBe(3);
    expect(metrics.chatTurns).toBe(4);
    // What a visitor typed is in the table and must not be in the result.
    const rendered = JSON.stringify(metrics);
    expect(rendered).not.toContain('what-a-visitor-typed');
    expect(rendered).not.toContain('an-answer');
  });

  test('the scheduled eval run publishes none of its own traffic as a visitor figure', async () => {
    // WHY THIS IS IN SQL AND NOT IN THE TEMPLATE, which is the same argument
    // src/lib/ops/metrics.ts's own header makes about the public-tier filter: a
    // page that receives only the right rows cannot get this wrong by
    // forgetting a condition, and /ops grows sections.
    //
    // WHAT IT IS EXCLUDING. The daily `tier` suite calls every
    // no-required-argument public tool anonymously, so its calls are
    // `tier = 'public'` rows and are exactly the ones this page publishes --
    // about 150 a month, roughly 30 of them `request_private_access`. The
    // weekly run adds twelve unsessioned `/chat` turns, each minting its own
    // session, which is a permanent floor of about 52 sessions and 52 turns per
    // window that nobody produced. Issue #291 was opened while auditing these
    // figures, so a scheduled run that corrupted them would break the
    // instrument that found the problem.
    const metrics = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 30);
    expect(metrics.toolCalls.map((row) => row.tool)).not.toContain('request_private_access');
    expect(JSON.stringify(metrics)).not.toContain('eval-session');
  });

  test('the MANUAL harness is still counted, deliberately', async () => {
    // The other half of the ruling, and the one a wider exclusion would lose.
    // workers/mcp/src/chat.ts keeps `npm run evals` visible on /ops on the
    // grounds that a person chose to run it; the schedule is the thing that is
    // unattended. The manual runner sets no `user-agent` of this repository's,
    // so its turns are `'direct'`, and a `surface <> 'site'` exclusion would
    // silently take them out along with the scheduled run's.
    const metrics = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 30);
    expect(metrics.chatTurns).toBeGreaterThanOrEqual(4);
  });

  test('eval runs are the LATEST run per suite, not every run', async () => {
    // Seven seeded rows across four suites: the older `chat` run must not
    // appear at all, `bisect`'s two tied rows must appear as one, and `fit`'s
    // latest row is the INCOMPLETE one that displaces its own older pass.
    const metrics = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 30);
    expect(metrics.evalRuns).toEqual([
      {
        ranAt: '2026-09-06T00:00:00.000Z',
        suite: 'bisect',
        total: 6,
        passed: 6,
        failed: 0,
        status: 'ran',
      },
      {
        ranAt: '2026-09-08T00:00:00.000Z',
        suite: 'chat',
        total: 10,
        passed: 9,
        failed: 1,
        status: 'ran',
      },
      {
        ranAt: '2026-09-08T12:00:00.000Z',
        suite: 'fit',
        total: 0,
        passed: 0,
        failed: 0,
        status: 'incomplete',
      },
      {
        ranAt: '2026-09-07T00:00:00.000Z',
        suite: 'tier',
        total: 4,
        passed: 4,
        failed: 0,
        status: 'ran',
      },
    ]);
  });

  test('an incomplete row carries its status and beats an older ran row for the same suite', async () => {
    // The regression this column exists to prevent: the "latest per suite"
    // picker (src/lib/ops/metrics.ts) orders by `ran_at DESC, id DESC` alone,
    // never by `status`, so a suite that stops running must still displace its
    // own last recorded pass rather than let /ops keep publishing it. `fit`
    // here has an older 'ran' row (2026-09-02, 8/8) and a newer 'incomplete'
    // one (2026-09-08T12:00, zeroed) -- if a query change ever narrowed the
    // correlated subquery to `status = 'ran'`, this suite would silently go
    // back to reporting the stale pass, which is exactly the failure /ops
    // published before this column existed.
    const metrics = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 30);
    const fit = metrics.evalRuns.filter((run) => run.suite === 'fit');
    expect(fit).toHaveLength(1);
    expect(fit[0]).toEqual({
      ranAt: '2026-09-08T12:00:00.000Z',
      suite: 'fit',
      total: 0,
      passed: 0,
      failed: 0,
      status: 'incomplete',
    });
  });

  test('two runs of one suite at the SAME timestamp yield one row, deterministically', async () => {
    // The defect this query was shipped with, pinned directly rather than left
    // to the array comparison above -- that one would fail on a tie for a reason
    // its name does not mention, and somebody would "fix" it by editing the
    // expectation. MEASURED on the page before the fix: a suite with five tied
    // rows rendered five times.
    //
    // ONE row, and a NAMED one: `id DESC` breaks the tie, so the later-inserted
    // of the two identical stamps wins. An implementation that returned either
    // row "because they tie anyway" would still be wrong -- a page that shows a
    // different number on each reload is worse than one that shows the older.
    const metrics = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 30);
    const bisect = metrics.evalRuns.filter((run) => run.suite === 'bisect');
    expect(bisect).toHaveLength(1);
    expect(bisect[0]).toEqual({
      ranAt: '2026-09-06T00:00:00.000Z',
      suite: 'bisect',
      total: 6,
      passed: 6,
      failed: 0,
      status: 'ran',
    });
  });

  test('the eval table is NOT windowed, unlike the other three', async () => {
    // Stated as an assertion because it looks like a bug at a glance: the eval
    // query takes no `since`/`until` at all. That is deliberate -- 04 §4 asks
    // /ops to publish the latest run per suite, and a narrow window would
    // render "no eval runs" for a suite that simply has not been run this
    // month, which reads as a broken pipeline rather than a quiet one.
    const narrow = await readOpsMetrics(db, new Date('2026-09-20T00:00:00.000Z'), 1);
    expect(narrow.toolCalls).toEqual([]);
    expect(narrow.chatTurns).toBe(0);
    expect(narrow.evalRuns.map((run) => run.suite)).toEqual(['bisect', 'chat', 'fit', 'tier']);
  });
});
