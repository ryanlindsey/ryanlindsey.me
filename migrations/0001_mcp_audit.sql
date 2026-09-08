-- The MCP audit trail (03 §3). Its schema is a published governance artifact
-- (06 §2), so treat a change here as a change to a public document.
--
-- What is deliberately NOT here: tool arguments. `args_hash` is a SHA-256 of
-- the canonical form, which is enough to see that the same query repeated and
-- not enough to reconstruct it. Day 5's fit-analysis tool accepts text the
-- caller pastes in, and a schema that stored raw args would quietly make
-- this table a store of other people's documents.
CREATE TABLE mcp_tool_calls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  called_at        TEXT    NOT NULL,
  tool             TEXT    NOT NULL,
  args_hash        TEXT    NOT NULL,
  -- 'public' today. Day 5 adds the scoped tiers; the column exists now so
  -- that day is a write, not a migration against live audit data.
  tier             TEXT    NOT NULL,
  -- The token's audience label. NULL on the public tier, always, forever.
  audience         TEXT,
  client_name      TEXT,
  client_version   TEXT,
  user_agent       TEXT,
  protocol_version TEXT,
  outcome          TEXT    NOT NULL,
  duration_ms      INTEGER NOT NULL
);

-- /ops reads "MCP tool calls by tool" over a rolling window (06 §1), and
-- retention is enforced by deleting on called_at (06 §2, one year).
CREATE INDEX idx_mcp_tool_calls_called_at ON mcp_tool_calls (called_at);
CREATE INDEX idx_mcp_tool_calls_tool_called_at ON mcp_tool_calls (tool, called_at);
