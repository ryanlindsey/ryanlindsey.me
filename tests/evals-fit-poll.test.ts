import { expect, test } from 'vitest';
import { FIT_CASE_DEADLINE_MS, collectFitReport } from '../src/lib/evals/fit-poll';
import { TOOL_REASON_META_KEY } from '../src/lib/mcp/tool-reason';

// The pure half of the fit suite's asynchronous protocol (issue #490): both
// runners call `collectFitReport` with their own transport, so what a
// response means is decided in one place.

type Answer = { result?: Record<string, unknown>; error?: { message?: string } };

const json = (value: unknown): Answer => ({
  result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
});
const pending = (id = 'r1') => json({ status: 'pending', report_id: id, poll_after_seconds: 5 });
const ok = (report: unknown = { x: 1 }) =>
  json({ status: 'ok', report_id: 'r1', report, citations_dropped: 0 });
const refusal = (text: string, meta?: Record<string, unknown>): Answer => ({
  result: { isError: true, content: [{ type: 'text', text }], ...(meta ? { _meta: meta } : {}) },
});

/** A scripted transport and a fake clock that only moves when a call is made. */
function script(answers: Answer[], msPerCall = 1000) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let clock = 0;
  return {
    calls,
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      clock += msPerCall;
      const next = answers.shift();
      if (!next) throw new Error('script exhausted');
      return next;
    },
    now: () => clock,
  };
}

test('collectFitReport: analyze_fit, then get_fit_report until ok', async () => {
  const s = script([pending(), pending(), ok()]);
  const outcome = await collectFitReport(s.callTool, 'a description', { now: s.now });
  expect(outcome).toEqual({
    kind: 'ok',
    payload: { status: 'ok', report_id: 'r1', report: { x: 1 }, citations_dropped: 0 },
  });
  expect(s.calls).toEqual([
    { name: 'analyze_fit', args: { target_description: 'a description' } },
    { name: 'get_fit_report', args: { report_id: 'r1' } },
    { name: 'get_fit_report', args: { report_id: 'r1' } },
  ]);
});

test('collectFitReport: an analyze_fit refusal is reported as it was, without polling', async () => {
  const s = script([refusal('rate limited')]);
  expect(await collectFitReport(s.callTool, 'x', { now: s.now })).toEqual({
    kind: 'refused',
    unavailable: false,
    text: 'rate limited',
  });
  expect(s.calls).toHaveLength(1);
});

test('collectFitReport: a get_fit_report refusal with the unavailable reason is flagged', async () => {
  const s = script([
    pending(),
    refusal('The fit engine could not be reached.', { [TOOL_REASON_META_KEY]: 'unavailable' }),
  ]);
  expect(await collectFitReport(s.callTool, 'x', { now: s.now })).toEqual({
    kind: 'refused',
    unavailable: true,
    text: 'The fit engine could not be reached.',
  });
});

test('collectFitReport: a get_fit_report refusal without the reason is a plain refusal', async () => {
  const s = script([pending(), refusal('That report does not exist.')]);
  expect(await collectFitReport(s.callTool, 'x', { now: s.now })).toMatchObject({
    kind: 'refused',
    unavailable: false,
  });
});

test('collectFitReport: still pending at the deadline is a failure naming the wait', async () => {
  const s = script(
    Array.from({ length: 20 }, () => pending()),
    60_000,
  );
  const outcome = await collectFitReport(s.callTool, 'x', { now: s.now });
  expect(outcome.kind).toBe('timeout');
  expect(outcome).toMatchObject({ reportId: 'r1' });
  // 60 s per call against a 300 s deadline: the first analyze_fit plus polls up to it.
  expect(s.calls.length).toBe(FIT_CASE_DEADLINE_MS / 60_000);
});

test('collectFitReport: a pending envelope with no report_id is malformed', async () => {
  const s = script([json({ status: 'pending' })]);
  expect(await collectFitReport(s.callTool, 'x', { now: s.now })).toMatchObject({
    kind: 'malformed',
  });
});

test('collectFitReport: a text result that is not JSON is malformed', async () => {
  const s = script([{ result: { content: [{ type: 'text', text: 'nope' }] } }]);
  expect(await collectFitReport(s.callTool, 'x', { now: s.now })).toEqual({
    kind: 'malformed',
    text: 'the tool did not return JSON',
  });
});

test('collectFitReport: an unknown status is malformed rather than polled forever', async () => {
  const s = script([json({ status: 'weird', report_id: 'r1' })]);
  expect(await collectFitReport(s.callTool, 'x', { now: s.now })).toMatchObject({
    kind: 'malformed',
  });
});
