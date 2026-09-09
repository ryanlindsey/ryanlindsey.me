-- The private tier (03 §3, 09 §1). Like 0001, this schema is a published
-- governance artifact (06 §2): treat a change here as a change to a public
-- document.
--
-- What is deliberately NOT here, and this is the whole design: no gated
-- CONTENT. Every private-tier document lives in the `ryanlindsey-me-private`
-- R2 bucket (src/lib/tier/private-docs.ts). D1 holds credentials, receipts and
-- metrics -- things that are about access rather than things access grants. A
-- schema that also held the documents would make one compromised read a
-- content leak instead of a metadata leak.

-- The token registry (03 §3). A token is self-describing and HMAC-signed, so
-- this table is not consulted to learn what a token MEANS -- it is consulted
-- to learn whether it is still allowed to mean it. That is what makes
-- revocation instant: one row update, no re-issue, no cache to expire.
--
-- The token VALUE is never stored. `jti` is the token's own claim, so a
-- stolen copy of this table cannot be replayed as a credential -- it can only
-- say that some token with that id existed.
CREATE TABLE access_tokens (
  jti         TEXT PRIMARY KEY,
  -- The audience label the grant carries (00 §5's `token_audience`). Runtime
  -- data: this column is where campaign semantics live, and the code that
  -- reads it treats it as an opaque string.
  audience    TEXT NOT NULL,
  -- JSON array of scope names, mirroring the token's own `scopes` claim. Kept
  -- so `scripts/token.mjs list` can show what was issued without asking the
  -- holder for their token back.
  scopes      TEXT NOT NULL,
  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  -- NULL until revoked. Revocation is a write here, never a delete: the row is
  -- the record that the token existed, and deleting it would erase the audit
  -- trail's only key for `mcp_tool_calls.grant_jti`.
  revoked_at  TEXT,
  note        TEXT
);

CREATE INDEX idx_access_tokens_audience ON access_tokens (audience);

-- Fit reports, for the permalinks `/fit/r/<id>` serves (04 §2).
--
-- `id` is 128 bits of randomness, base64url, and it IS the capability -- there
-- is no second check on the read path. That is deliberate and recorded in the
-- plan: a signature over an id the server already stores adds ceremony, not
-- security. What follows from it: the id must never be derived from anything
-- (not the audience, not a hash of the input), or it stops being unguessable.
--
-- `target_description` is stored because a report without the text it judged
-- is unreadable a week later. This is the one place in the schema where a
-- caller's pasted text is retained; /ai-policy (06 §2) must say so, and the
-- retention window is the one this table's cleanup enforces.
CREATE TABLE fit_reports (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  -- The audience of the grant that generated it. NOT NULL: a fit report cannot
  -- be produced without a grant, so a NULL here would mean the tier check was
  -- bypassed and the row is evidence of a bug.
  audience           TEXT NOT NULL,
  model              TEXT NOT NULL,
  target_description TEXT NOT NULL,
  -- The validated report, exactly as `/fit/r/<id>` renders it.
  report_json        TEXT NOT NULL,
  -- How many citations were checked and how many were dropped for not
  -- resolving to a real corpus URL (03 §4). A non-zero `dropped` is the
  -- signal that the prompt is fabricating, and it belongs beside the report
  -- rather than in a log nobody reads.
  citations_checked  INTEGER NOT NULL,
  citations_dropped  INTEGER NOT NULL
);

CREATE INDEX idx_fit_reports_created_at ON fit_reports (created_at);

-- Eval runs (04 §4). The runner writes one row per suite per run and /ops
-- (day 6) reads the latest. Deliberately a summary and not per-case results:
-- publishing pass rates is the credibility move, and a table of individual
-- case outcomes would tempt someone to publish the cases, and for the
-- adversarial suites the cases are the probes.
CREATE TABLE eval_runs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at    TEXT    NOT NULL,
  suite     TEXT    NOT NULL,
  model     TEXT,
  total     INTEGER NOT NULL,
  passed    INTEGER NOT NULL,
  failed    INTEGER NOT NULL,
  notes     TEXT
);

CREATE INDEX idx_eval_runs_ran_at ON eval_runs (ran_at);

-- The audit trail gains the granting token's id. `tier` and `audience` were
-- already there (0001 reserved them for exactly today); this is the third
-- field, and it is the one that makes revocation forensics possible: audience
-- says which campaign, `grant_jti` says which token, and only the second is
-- enough to answer "what did the token I just revoked actually read?".
--
-- Nullable, and NULL on the public tier always -- the same contract `audience`
-- carries.
ALTER TABLE mcp_tool_calls ADD COLUMN grant_jti TEXT;

CREATE INDEX idx_mcp_tool_calls_grant_jti ON mcp_tool_calls (grant_jti);
