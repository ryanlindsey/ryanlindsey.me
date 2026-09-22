-- Deferred fit runs (#269). A report row is now written BEFORE the report
-- exists, so the four columns describing a finished report have to be
-- nullable, and the row has to say which state it is in.
--
-- A TABLE REBUILD rather than four `ALTER TABLE` statements, and not by
-- choice: SQLite can add a column and can drop one, and cannot drop a
-- `NOT NULL` constraint. The rebuild is the documented way to do it.
--
-- `created_at` DOES NOT CHANGE SHAPE AND DOES CHANGE MEANING. It was the
-- moment the report was stored. It is now the moment the run STARTED, which
-- is what `/fit/r/<id>` subtracts from the clock to decide a pending row has
-- gone stale. Every comment written before this migration assumes the old
-- reading.
--
-- `status` HAS NO DEFAULT, deliberately. Issue #274 lands the two writers this
-- column is for -- the insert that opens a run and the update that closes it
-- -- and a default would let a third appear without saying which kind of row
-- it is writing. Today only one writer exists (the insert in
-- src/pages/fit/run.ts, which still writes a finished row in one step); the
-- no-DEFAULT rule is written for the shape this epic lands, not for today's
-- single writer, so it does not need to change again when #274 adds the second.
--
-- `audience` stays NOT NULL: it is resolved from the grant before the row is
-- opened, so a NULL here would still mean the tier check was bypassed, exactly
-- as 0002 recorded.
--
-- The copy below carries real rows, not an empty table: measured 2026-09-21,
-- `fit_reports` held 9 rows in production (it was 0 on 2026-09-18, before the
-- SSE transport fix landed and runs began saving). Every one of those rows is
-- a finished report -- this migration predates the deferred run this issue's
-- epic is building toward, so nothing could have written 'pending' or
-- 'failed' yet -- which is what makes `'ok'` honest for all nine.

CREATE TABLE fit_reports_new (
  id                 TEXT    PRIMARY KEY,
  -- The moment the run STARTED. See the note above.
  created_at         TEXT    NOT NULL,
  -- 'pending', 'ok' or 'failed'.
  status             TEXT    NOT NULL,
  -- Set only when `status` is 'failed'. A member of the closed set rendered by
  -- src/lib/fit/report-status.ts, which issue #276 creates later in this same
  -- epic -- the module does not exist yet on `main` as this migration lands.
  -- An unrecognized value renders NOTHING, because /fit/r/<id> is designed to
  -- be forwarded to people holding no token.
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
  id, created_at, 'ok', NULL, audience, target_description,
  model, report_json, citations_checked, citations_dropped
FROM fit_reports;

DROP TABLE fit_reports;
ALTER TABLE fit_reports_new RENAME TO fit_reports;

CREATE INDEX idx_fit_reports_created_at ON fit_reports (created_at);
-- The read path asks "is this row still pending, and how old is it", so the
-- two columns that question reads are indexed together.
CREATE INDEX idx_fit_reports_status_created_at ON fit_reports (status, created_at);
