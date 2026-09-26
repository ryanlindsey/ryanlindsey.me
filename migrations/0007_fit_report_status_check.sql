-- `fit_reports.status` becomes a closed set in the schema (#355), where until
-- now it was a closed set only in the discipline of its writers.
--
-- 0006 declared `status TEXT NOT NULL` with no CHECK. The three legal values
-- are 'pending', 'ok' and 'failed', and src/pages/fit/r/[id].astro branches on
-- exactly those: a fourth value falls through every branch and renders the
-- eyebrow and nothing else, a blank page rather than an error. The writers --
-- `handleFitStart` in workers/mcp/src/fit-start.ts, and `FitWorkflow`'s close
-- step and `abandonRun` in workers/mcp/src/fit-workflow.ts -- have only ever
-- written those three, so this changes nothing a deployed writer does. It
-- turns the next writer's mistake into a refused statement at the write
-- instead of a blank permalink at the read.
--
-- A TABLE REBUILD, for the reason 0006 recorded: SQLite cannot add a CHECK to
-- an existing column, and the rebuild is the documented way to do it. Every
-- column, type, nullability and index below is 0006's, unchanged, and so is
-- `created_at`'s meaning (the moment the run STARTED).
--
-- `status` STILL HAS NO DEFAULT. 0006's reason stands: a default would let a
-- new writer appear without saying which kind of row it is writing. The CHECK
-- is the other half of the same rule, since a writer that has to name the
-- state now also has to name one of three.
--
-- `failure_code` IS NOT CONSTRAINED HERE, deliberately. Its set is the closed
-- map in src/lib/fit/report-status.ts, which renders an unrecognized code as
-- nothing, and fixing that set in the schema would make every new code a
-- table rebuild.
--
-- ORDER AGAINST THE DEPLOY DOES NOT MATTER FOR THIS ONE, unlike 0005: no
-- deployed code reads or writes anything this migration adds, so it can reach
-- the remote database before or after the merge that carries it. What CAN
-- fail is the copy, if a production row already holds a fourth value: the
-- INSERT below refuses it, so run
--   SELECT status, COUNT(*) FROM fit_reports GROUP BY status
-- against the remote database first and expect only the three. MEASURED
-- 2026-09-26: `fit_reports` held 14 rows in production, 13 'ok' and 1
-- 'pending', none carrying a `failure_code`, and 0006 was the last migration
-- applied. The copy carries `status` as it is rather than rewriting it, so a
-- 'pending' row whose run is still open is closed by that run against the new
-- table exactly as it would have been against the old one.

CREATE TABLE fit_reports_new (
  id                 TEXT    PRIMARY KEY,
  -- The moment the run STARTED. See 0006.
  created_at         TEXT    NOT NULL,
  status             TEXT    NOT NULL
                     CHECK (status IN ('pending', 'ok', 'failed')),
  -- Set only when `status` is 'failed'. A member of the closed map in
  -- src/lib/fit/report-status.ts; see the note above for why the schema does
  -- not hold that set too.
  failure_code       TEXT,
  audience           TEXT    NOT NULL,
  target_description TEXT    NOT NULL,
  -- The four below are unknown while `status` is 'pending'.
  model              TEXT,
  report_json        TEXT,
  citations_checked  INTEGER,
  citations_dropped  INTEGER
);

INSERT INTO fit_reports_new
  (id, created_at, status, failure_code, audience, target_description,
   model, report_json, citations_checked, citations_dropped)
SELECT
  id, created_at, status, failure_code, audience, target_description,
  model, report_json, citations_checked, citations_dropped
FROM fit_reports;

DROP TABLE fit_reports;
ALTER TABLE fit_reports_new RENAME TO fit_reports;

CREATE INDEX idx_fit_reports_created_at ON fit_reports (created_at);
-- The read path asks "is this row still pending, and how old is it", so the
-- two columns that question reads are indexed together.
CREATE INDEX idx_fit_reports_status_created_at ON fit_reports (status, created_at);
