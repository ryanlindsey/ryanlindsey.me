import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SITE_HARNESS_WORKERS } from './workers';
import { readOpsMetrics } from '../src/lib/ops/metrics';

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

  test('an empty database reports zeros rather than throwing', async () => {
    const metrics = await readOpsMetrics(db, new Date('2020-01-01T00:00:00.000Z'), 1);
    expect(metrics.toolCalls).toEqual([]);
    expect(metrics.chatSessions).toBe(0);
    expect(metrics.evalRuns).toEqual([]);
  });

  test('chat sessions are distinct sessions, and turns are turns', async () => {
    // Two turns in one session and one in another: the two numbers differ, so a
    // query that had counted rows for both would pass a single-session fixture
    // and fail here.
    const at = '2026-09-09T09:00:00.000Z';
    await db.batch(
      ['a', 'b', 'c'].map((id, index) =>
        db
          .prepare(
            `INSERT INTO chat_turns (id, session_id, created_at, question, answer, model,
                                     sources_json, cited, invalid_citations, outcome, duration_ms, surface)
             VALUES (?, ?, ?, 'what-a-visitor-typed', 'an-answer', 'm', '[]', 0, 0, 'ok', 10, 'site')`,
          )
          .bind(id, index === 2 ? 'session-2' : 'session-1', at),
      ),
    );

    const metrics = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 30);
    expect(metrics.chatSessions).toBe(2);
    expect(metrics.chatTurns).toBe(3);
    // What a visitor typed is in the table and must not be in the result.
    const rendered = JSON.stringify(metrics);
    expect(rendered).not.toContain('what-a-visitor-typed');
    expect(rendered).not.toContain('an-answer');
  });

  test('eval runs are the LATEST run per suite, not every run', async () => {
    await db.batch([
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
    ]);

    const metrics = await readOpsMetrics(db, new Date('2026-09-09T12:00:00.000Z'), 30);
    expect(metrics.evalRuns).toEqual([
      { ranAt: '2026-09-08T00:00:00.000Z', suite: 'chat', total: 10, passed: 9, failed: 1 },
      { ranAt: '2026-09-07T00:00:00.000Z', suite: 'tier', total: 4, passed: 4, failed: 0 },
    ]);
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
    expect(narrow.evalRuns.map((run) => run.suite)).toEqual(['chat', 'tier']);
  });
});
