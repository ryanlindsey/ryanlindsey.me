import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS } from './workers';
import {
  findToken,
  listTokens,
  recordIssue,
  revokeToken,
  type TokenRecord,
} from '../src/lib/tier/registry';

const server = createTestHarness({ workers: MCP_HARNESS_WORKERS });
let db: D1Database;

beforeAll(async () => {
  await server.listen();
  const mcp = server.getWorker<{ DB: D1Database }>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  db = (await mcp.getEnv()).DB;
});
afterAll(async () => {
  await server.close();
});

// Explicitly typed against TokenRecord rather than left to inference: an
// untyped `over` widens `scopes` to a readonly tuple (from the array literal
// below) that `recordIssue`'s mutable `Scope[]` refuses -- MEASURED via
// `npm run check` failing on every call site that didn't override `scopes`.
// `npx vitest run` alone never catches this; it strips types rather than
// checking them.
const record = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  jti: 'jti-one',
  audience: 'fixture-audience',
  scopes: ['fit', 'profile'],
  issuedAt: '2026-09-08T00:00:00.000Z',
  expiresAt: '2026-09-15T00:00:00.000Z',
  revokedAt: null,
  note: 'fixture',
  ...over,
});

test('a recorded issue is found again with its scopes intact', async () => {
  await recordIssue(db, record({ jti: 'jti-round-trip' }));
  const found = await findToken(db, 'jti-round-trip');
  expect(found).not.toBeNull();
  expect(found!.audience).toBe('fixture-audience');
  expect(found!.scopes).toEqual(['fit', 'profile']);
  expect(found!.revokedAt).toBeNull();
});

test('an unknown jti is null, not a throw', async () => {
  expect(await findToken(db, 'never-issued')).toBeNull();
});

test('revocation stamps the row and is visible immediately', async () => {
  await recordIssue(db, record({ jti: 'jti-revoke' }));
  expect(await revokeToken(db, 'jti-revoke', '2026-09-09T00:00:00.000Z')).toBe(true);
  const found = await findToken(db, 'jti-revoke');
  expect(found!.revokedAt).toBe('2026-09-09T00:00:00.000Z');
});

test('revoking twice reports the second attempt as a no-op', async () => {
  // The CLI prints this verbatim, and "already revoked" is a materially
  // different thing for an operator to read than "revoked".
  await recordIssue(db, record({ jti: 'jti-twice' }));
  expect(await revokeToken(db, 'jti-twice', '2026-09-09T00:00:00.000Z')).toBe(true);
  expect(await revokeToken(db, 'jti-twice', '2026-09-10T00:00:00.000Z')).toBe(false);
  // And the first stamp is not overwritten: the record is of when access
  // actually stopped.
  expect((await findToken(db, 'jti-twice'))!.revokedAt).toBe('2026-09-09T00:00:00.000Z');
});

test('revoking something that was never issued is false, not a throw', async () => {
  expect(await revokeToken(db, 'never-issued', '2026-09-09T00:00:00.000Z')).toBe(false);
});

test('listTokens returns newest first', async () => {
  await recordIssue(db, record({ jti: 'jti-old', issuedAt: '2026-01-01T00:00:00.000Z' }));
  await recordIssue(db, record({ jti: 'jti-new', issuedAt: '2026-12-01T00:00:00.000Z' }));
  const all = await listTokens(db);
  const ids = all.map((t) => t.jti);
  expect(ids.indexOf('jti-new')).toBeLessThan(ids.indexOf('jti-old'));
});

test('a corrupt scopes column yields an empty scope set rather than a crash', async () => {
  // Fails CLOSED. The column is written by this module and by nothing else,
  // so reaching this branch means the row was edited by hand -- and the safe
  // reading of "I cannot tell what this token may do" is "nothing".
  await db
    .prepare(
      `INSERT INTO access_tokens (jti, audience, scopes, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      'jti-corrupt',
      'fixture-audience',
      'not json',
      '2026-09-08T00:00:00.000Z',
      '2026-09-15T00:00:00.000Z',
    )
    .run();
  expect((await findToken(db, 'jti-corrupt'))!.scopes).toEqual([]);
});
