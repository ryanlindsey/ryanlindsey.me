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
  tier: 'public';
  audience: string | null;
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
 * The prepared insert for one audit row, bound but not run. Exported
 * separately from `recordToolCall` because Task 5's `defineTool` needs the
 * statement form -- e.g. to batch it alongside other writes -- not just the
 * fire-and-forget call below.
 */
export function auditStatement(db: D1Database, row: AuditRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mcp_tool_calls
         (called_at, tool, args_hash, tier, audience, client_name, client_version,
          user_agent, protocol_version, outcome, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.calledAt,
      row.tool,
      row.argsHash,
      row.tier,
      row.audience,
      row.clientName,
      row.clientVersion,
      row.userAgent,
      row.protocolVersion,
      row.outcome,
      row.durationMs,
    );
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
    await auditStatement(db, row).run();
  } catch (err) {
    console.error('mcp/audit: failed to record tool call', err);
  }
}
