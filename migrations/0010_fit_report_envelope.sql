-- A fit run records the rest of what its caller is handed (#490), so the
-- `get_fit_report` tool can answer from the row alone.
--
-- `analyze_fit` stopped awaiting the engine: it opens the run and answers with
-- an id, and a second call reads the result back. Until now a closed row held
-- the report, the model and the citation audit, and the other fields of the
-- envelope the tool used to return were computed and dropped. Five nullable
-- columns on `fit_reports` keep them:
--
--   generated_at      TEXT     ISO 8601, the envelope's own timestamp.
--   corpus_documents  INTEGER  how many documents the model was shown.
--   corpus_truncated  INTEGER  1 when whole documents were dropped to fit the
--                              context budget, else 0.
--   no_answer         INTEGER  1 when the engine declined and said it has no
--                              answer to give (`FitUnavailable.noAnswer`), else
--                              0. The tool maps it to its `unavailable` reason.
--   failure_message   TEXT     the engine's own sentence, written to be shown.
--
-- THE FIRST THREE ARE WRITTEN ON `ok`, THE LAST TWO ON `failed`, and each is
-- NULL on the other branch. `failure_message` is written only for a
-- `FitUnavailable`: every other failure leaves it null, because the only text
-- available for those is upstream error text, which `failure_detail` already
-- holds for the owner and which is never shown to a caller.
--
-- NULL MEANS NOT RECORDED, which includes every row written before this
-- migration. A reader reports null for the three envelope fields rather than
-- guessing, and must treat a null `no_answer` on a failed row as unknown.
--
-- NO CHECK, for the reason 0009 gives: SQLite cannot add one to an existing
-- column, and the flags are 0/1 by construction in the one writer.
--
-- ORDER AGAINST THE DEPLOY MATTERS, as with 0005 and 0009. The close step's
-- UPDATE names these columns, so code deployed before this is applied to the
-- remote database fails that step and leaves the row `pending` until it goes
-- stale. Apply with
-- `npx wrangler d1 migrations apply ryanlindsey-me-db --remote` first.

ALTER TABLE fit_reports ADD COLUMN generated_at TEXT;
ALTER TABLE fit_reports ADD COLUMN corpus_documents INTEGER;
ALTER TABLE fit_reports ADD COLUMN corpus_truncated INTEGER;
ALTER TABLE fit_reports ADD COLUMN no_answer INTEGER;
ALTER TABLE fit_reports ADD COLUMN failure_message TEXT;
