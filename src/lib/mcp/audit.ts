// The MCP audit trail's writer (03 §3). `defineTool` (Task 5) calls
// `recordToolCall` on every tool invocation, so this module is on the hot
// path of every call to the public tier. Its schema, `migrations/0001_mcp_audit.sql`,
// is a published governance artifact (06 §2) -- read that file's comments
// before changing the shape of a row.

/** One row of `mcp_tool_calls`, matching the migration column-for-column. */
export interface AuditRow {
  calledAt: string;
  tool: string;
  argsHash: string;
  /**
   * `'public'` for an unauthenticated call, `'private'` for one made under a
   * grant. Widened from the literal `'public'` on day 5 -- see
   * `guarded` in workers/mcp/src/define.ts, which is the one place either
   * value is produced.
   */
  tier: 'public' | 'private';
  /** The grant's audience label. NULL on the public tier, always, forever. */
  audience: string | null;
  /**
   * The `jti` of the token that authorised the call. NULL on the public
   * tier, always, forever.
   *
   * Separate from `audience` because they answer different questions: an
   * audience names a campaign and outlives any one token, while this names
   * the credential. Revoking a token and then asking what it read is a
   * `grant_jti` query; `audience` cannot answer it.
   */
  grantJti: string | null;
  clientName: string | null;
  clientVersion: string | null;
  userAgent: string | null;
  protocolVersion: string | null;
  outcome: 'ok' | 'error' | 'rate_limited';
  durationMs: number;
}

/** Canonical JSON: object keys sorted at every depth, so key order cannot change the hash. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

/**
 * SHA-256 of the canonical arguments, hex.
 *
 * `undefined` and `{}` deliberately hash the same: a tool that takes no
 * arguments and a tool called with an empty object are the same call, and two
 * different digests for it would make repeat-detection on /ops wrong.
 */
export async function hashArgs(args: unknown): Promise<string> {
  const json = JSON.stringify(canonicalize(args ?? {}));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Writes one audit row and awaits it.
 *
 * Catches and swallows its own failure (after logging it): an audit write
 * that fails must not turn a working tool call into an error for the caller.
 * The trade this makes deliberately: a D1 outage loses audit rows, not the
 * service.
 */
export async function recordToolCall(db: D1Database, row: AuditRow): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO mcp_tool_calls
           (called_at, tool, args_hash, tier, audience, grant_jti, client_name,
            client_version, user_agent, protocol_version, outcome, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.calledAt,
        row.tool,
        row.argsHash,
        row.tier,
        row.audience,
        row.grantJti,
        row.clientName,
        row.clientVersion,
        row.userAgent,
        row.protocolVersion,
        row.outcome,
        row.durationMs,
      )
      .run();
  } catch (err) {
    console.error('mcp/audit: failed to record tool call', err);
  }
}
