import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS } from './workers';
import type { McpEnv } from '../workers/mcp/src/env';

/**
 * `fit_reports.status` as the schema holds it (#355).
 *
 * The three legal values were a closed set only in the discipline of their
 * writers until migrations/0007_fit_report_status_check.sql, and
 * src/pages/fit/r/[id].astro renders a blank page for a fourth. These tests
 * are against the migrated local simulation, so they pin the constraint the
 * migration declares, not the three writers that already honor it.
 */

const server = createTestHarness({ workers: MCP_HARNESS_WORKERS });
let db: D1Database;

beforeAll(async () => {
  await server.listen();
  const mcp = server.getWorker<McpEnv>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  db = (await mcp.getEnv()).DB;
});
afterAll(async () => {
  await server.close();
});

function insert(id: string, status: string) {
  return db
    .prepare(
      `INSERT INTO fit_reports (id, created_at, status, audience, target_description)
       VALUES (?, ?, ?, 'web', 'A generic description of a role.')`,
    )
    .bind(id, new Date().toISOString(), status)
    .run();
}

test.each(['pending', 'ok', 'failed'])('the schema accepts status %s', async (status) => {
  await expect(insert(`legal-${status}`, status)).resolves.toBeTruthy();
});

test.each(['done', 'OK', ''])('the schema refuses status %j', async (status) => {
  await expect(insert(`illegal-${status || 'empty'}`, status)).rejects.toThrow(/CHECK constraint/);
});

test('an update cannot move a row out of the set either', async () => {
  await insert('update-target', 'pending');
  await expect(
    db.prepare(`UPDATE fit_reports SET status = 'done' WHERE id = ?`).bind('update-target').run(),
  ).rejects.toThrow(/CHECK constraint/);
});

test('the rebuild keeps both indexes', async () => {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'fit_reports' AND sql IS NOT NULL ORDER BY name`,
    )
    .all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual([
    'idx_fit_reports_created_at',
    'idx_fit_reports_status_created_at',
  ]);
});
