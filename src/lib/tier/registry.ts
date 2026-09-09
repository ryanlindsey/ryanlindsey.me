// The token registry (03 §3): the half of the permission model that makes
// revocation instant. ./token.ts answers "is this signature real"; this file
// answers "is this credential still live", and ./grant.ts asks both.
//
// One row per token ever issued, and rows are never deleted -- see
// migrations/0002_private_tier.sql for why (the audit trail's `grant_jti` has
// no other key).

import { SCOPES, type Scope } from './token';

export interface TokenRecord {
  jti: string;
  audience: string;
  scopes: Scope[];
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  note: string | null;
}

/** The row shape D1 hands back, before `scopes` is parsed. */
interface TokenRow {
  jti: string;
  audience: string;
  scopes: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  note: string | null;
}

/**
 * Parses the `scopes` column, failing CLOSED.
 *
 * Anything that is not a JSON array of names this build knows becomes the
 * empty set. That is the conservative reading of a column this module is the
 * only writer of: a row it cannot understand was not written by it, and a
 * token whose capabilities cannot be established has none.
 */
function parseScopes(raw: string): Scope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((scope): scope is Scope => (SCOPES as readonly unknown[]).includes(scope));
  } catch {
    return [];
  }
}

function toRecord(row: TokenRow): TokenRecord {
  return {
    jti: row.jti,
    audience: row.audience,
    scopes: parseScopes(row.scopes),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    note: row.note,
  };
}

/** Records an issued token. The token VALUE is never stored; only its claims. */
export async function recordIssue(db: D1Database, record: TokenRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO access_tokens (jti, audience, scopes, issued_at, expires_at, revoked_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.jti,
      record.audience,
      JSON.stringify(record.scopes),
      record.issuedAt,
      record.expiresAt,
      record.revokedAt,
      record.note,
    )
    .run();
}

/** One row, or `null` for a jti that was never issued. */
export async function findToken(db: D1Database, jti: string): Promise<TokenRecord | null> {
  const row = await db
    .prepare('SELECT * FROM access_tokens WHERE jti = ?')
    .bind(jti)
    .first<TokenRow>();
  return row === null ? null : toRecord(row);
}

/**
 * Stamps a revocation. `true` if this call is what revoked it.
 *
 * `AND revoked_at IS NULL` is what makes the return value meaningful and what
 * stops a second call from moving the timestamp forward: the stamp records
 * when access actually stopped, and an operator revoking twice should be told
 * the second one changed nothing rather than shown a fresher lie.
 */
export async function revokeToken(db: D1Database, jti: string, atIso: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE access_tokens SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL')
    .bind(atIso, jti)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Every token ever issued, newest first -- what `scripts/token.mjs list` prints. */
export async function listTokens(db: D1Database): Promise<TokenRecord[]> {
  const { results } = await db
    .prepare('SELECT * FROM access_tokens ORDER BY issued_at DESC')
    .all<TokenRow>();
  return results.map(toRecord);
}
