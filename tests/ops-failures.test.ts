import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SITE_HARNESS_WORKERS } from './workers';
import { FAILURE_SURFACES, readFailureMetrics, surfaceOf } from '../src/lib/ops/failures';
import { EVALS_SURFACE, EVALS_USER_AGENT } from '../src/lib/evals/plan';

/**
 * The failure read behind /ops, against a REAL D1 for the same reason
 * tests/ops-metrics.test.ts is: the subject is the GROUP BY and the origin
 * rule in the query text, which a canned-row stub would not exercise.
 */
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });
let db: D1Database;
const now = new Date('2026-09-09T12:00:00.000Z');
const at = '2026-09-09T09:00:00.000Z';
const old = '2026-06-01T12:00:00.000Z';

function tool(
  calledAt: string,
  name: string,
  tier: string,
  outcome: string,
  reason: string | null,
  userAgent: string | null = null,
) {
  return db
    .prepare(
      `INSERT INTO mcp_tool_calls (called_at, tool, args_hash, tier, audience, user_agent, outcome, duration_ms, failure_reason, failure_detail)
       VALUES (?, ?, 'h', ?, 'a-secret-audience', ?, ?, 5, ?, 'a-secret-detail')`,
    )
    .bind(calledAt, name, tier, userAgent, outcome, reason);
}

let turn = 0;
function chat(createdAt: string, surface: string, outcome: string, reason: string | null) {
  turn += 1;
  return db
    .prepare(
      `INSERT INTO chat_turns (id, session_id, created_at, question, answer, model,
                               sources_json, cited, invalid_citations, outcome, duration_ms, surface, failure_reason)
       VALUES (?, ?, ?, 'q', 'a', 'm', '[]', 0, 0, ?, 10, ?, ?)`,
    )
    .bind(`t${turn}`, `s${turn}`, createdAt, outcome, surface, reason);
}

beforeAll(async () => {
  await server.listen();
  const site = server.getWorker<{ DB: D1Database }>();
  await site.applyD1Migrations('DB');
  db = (await site.getEnv()).DB;
  await db.batch([
    tool(at, 'analyze_fit', 'private', 'ok', null),
    tool(at, 'analyze_fit', 'private', 'error', 'provider_rejected'),
    tool(at, 'analyze_fit', 'private', 'error', 'provider_rejected'),
    tool(at, 'judge_answer', 'private', 'error', 'gateway_limit', EVALS_USER_AGENT),
    tool(at, 'get_references', 'private', 'error', null),
    // A value this code was not told about, and a rate-limited public call.
    tool(at, 'get_resume', 'public', 'error', 'something_new'),
    tool(at, 'get_resume', 'public', 'rate_limited', 'local_limit'),
    // Outside the window.
    tool(old, 'analyze_fit', 'private', 'error', 'provider_rejected'),
    chat(at, 'site', 'ok', null),
    chat(at, 'site', 'refused', 'local_limit'),
    chat(at, EVALS_SURFACE, 'error', 'gateway_limit'),
    chat(old, 'site', 'error', 'internal'),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe('surfaceOf', () => {
  test('folds a tool into the surface a reader would name', () => {
    expect(surfaceOf('analyze_fit', 'private')).toBe('fit');
    // Since #490 a run's failure is answered by the tool that reads it back,
    // so that tool is the fit surface too, or every failed run would be filed
    // under `private tools`.
    expect(surfaceOf('get_fit_report', 'private')).toBe('fit');
    expect(surfaceOf('judge_answer', 'private')).toBe('judge');
    expect(surfaceOf('search_writing', 'public')).toBe('search');
    expect(surfaceOf('get_resume', 'public')).toBe('public tools');
    expect(surfaceOf('get_references', 'private')).toBe('private tools');
    expect(surfaceOf('resource:resume', 'public')).toBe('public tools');
  });
});

describe('readFailureMetrics', () => {
  test('counts by surface and origin, in a fixed order, omitting empty rows', async () => {
    const { rows } = await readFailureMetrics(db, now, 30);
    const key = (r: { surface: string; origin: string }) => `${r.surface}/${r.origin}`;
    expect(rows.map(key)).toEqual([
      'chat/live',
      'chat/scheduled',
      'fit/live',
      'judge/scheduled',
      'public tools/live',
      'private tools/live',
    ]);
    const by = Object.fromEntries(rows.map((r) => [key(r), r]));
    expect(by['fit/live']).toMatchObject({
      total: 3,
      failed: 2,
      byReason: { provider_rejected: 2 },
    });
    expect(by['judge/scheduled']).toMatchObject({
      total: 1,
      failed: 1,
      byReason: { gateway_limit: 1 },
    });
    expect(by['private tools/live'].byReason.unrecorded).toBe(1);
    expect(by['chat/live']).toMatchObject({ total: 2, failed: 1, byReason: { local_limit: 1 } });
    expect(by['chat/scheduled']).toMatchObject({ failed: 1, byReason: { gateway_limit: 1 } });
  });

  test('a stored reason outside the vocabulary counts as unrecorded', async () => {
    const { rows } = await readFailureMetrics(db, now, 30);
    const row = rows.find((r) => r.surface === 'public tools')!;
    expect(row).toMatchObject({ total: 2, failed: 2, byReason: { unrecorded: 1, local_limit: 1 } });
    expect(JSON.stringify(rows)).not.toContain('something_new');
  });

  test('carries no tool name, audience or detail', async () => {
    const json = JSON.stringify(await readFailureMetrics(db, now, 30));
    for (const leak of [
      'a-secret',
      'analyze_fit',
      'get_references',
      'judge_answer',
      'get_resume',
    ]) {
      expect(json).not.toContain(leak);
    }
  });

  test('a row older than the window is not counted', async () => {
    const { rows } = await readFailureMetrics(db, now, 30);
    expect(rows.find((r) => r.surface === 'fit')!.total).toBe(3);
    expect(rows.find((r) => r.surface === 'chat' && r.origin === 'live')!.total).toBe(2);
    expect(FAILURE_SURFACES).toHaveLength(6);
  });
});
