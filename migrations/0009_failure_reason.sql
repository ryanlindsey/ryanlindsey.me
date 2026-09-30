-- Every failed tool call, chat turn and fit run records WHY it failed (#465),
-- where until now `outcome`, `status` and `failure_code` said only THAT it did.
--
-- Two nullable columns on each of the three tables that record a run:
-- `failure_reason` is a member of the closed set in src/lib/failure/classify.ts
-- (local_limit, gateway_limit, gateway_billing, provider_rejected,
-- provider_unavailable, bad_output, no_sources, caller_input, not_permitted,
-- not_found, internal), and `failure_detail` is a short excerpt of the cause,
-- at most 200 characters, for the owner reading the row and never rendered.
-- The detail may contain a caller-supplied slug, quoted by a tool's own error
-- sentence, so it qualifies 0001's note that arguments are stored only as a
-- hash: the hash is still all that is kept of the arguments as such, and the
-- slug reaches this column only inside a message, bounded at 200 characters.
--
-- NULL MEANS SUCCESS, OR A ROW WRITTEN BEFORE THIS MIGRATION. The two cannot
-- be told apart from these columns alone, so a reader that must not count an
-- old failure as a success has to also look at `outcome` or `status`.
--
-- NO CHECK, deliberately. 0007 had to rebuild `fit_reports` to add one, since
-- SQLite cannot add a CHECK to an existing column, and the reason set is
-- expected to grow: a CHECK here would make each new reason a table rebuild
-- across three tables. The set is closed in the TypeScript type instead, and
-- an unrecognized value is a reader's problem to render as unrecorded.
--
-- ORDER AGAINST THE DEPLOY MATTERS, as with 0005. The writers name these
-- columns, so code deployed before this is applied to the remote database
-- fails every write that names them. For `mcp_tool_calls` and `chat_turns` the
-- INSERT failure is swallowed and the rows are lost without an error anywhere.
-- For `fit_reports` the failed-run UPDATE is not swallowed: it fails the
-- workflow step and the row is left `running`, stale, rather than lost. Apply
-- with `npx wrangler d1 migrations apply ryanlindsey-me-db --remote` first.

ALTER TABLE mcp_tool_calls ADD COLUMN failure_reason TEXT;
ALTER TABLE mcp_tool_calls ADD COLUMN failure_detail TEXT;

ALTER TABLE chat_turns ADD COLUMN failure_reason TEXT;
ALTER TABLE chat_turns ADD COLUMN failure_detail TEXT;

ALTER TABLE fit_reports ADD COLUMN failure_reason TEXT;
ALTER TABLE fit_reports ADD COLUMN failure_detail TEXT;
