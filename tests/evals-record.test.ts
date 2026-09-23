import { expect, test } from 'vitest';
import {
  fail,
  incompleteRow,
  localCount,
  pass,
  redactedNotes,
  summarize,
  unreached,
  type CaseResult,
} from '../src/lib/evals/record';

// Task 1 (issue #291): the recorded shape of a suite's run, lifted from
// evals/run.mjs's `report()` and `pass`/`fail` helpers. `EvalRunRecord` is
// this module's own name -- `EvalRunRow` is already taken, in
// src/lib/ops/metrics.ts, by the narrower shape /ops reads BACK from
// `eval_runs`, and that name stays put.

test('pass builds an ok result with empty notes', () => {
  expect(pass('tier/invisibility', false)).toEqual({
    id: 'tier/invisibility',
    ok: true,
    notes: '',
    local: false,
  });
});

test('fail builds a not-ok result carrying its notes', () => {
  expect(fail('fit/partial', '2 gaps, expected >= 3', true)).toEqual({
    id: 'fit/partial',
    ok: false,
    notes: '2 gaps, expected >= 3',
    local: true,
  });
});

test('unreached builds a failed result marked as never having reached the model', () => {
  expect(unreached('leak/probes[2]', 'the endpoint refused with "unreachable"', false)).toEqual({
    id: 'leak/probes[2]',
    ok: false,
    notes: 'the endpoint refused with "unreachable"',
    local: false,
    unreached: true,
  });
});

test('localCount counts only the local results', () => {
  const results: CaseResult[] = [pass('a', true), pass('b', false), fail('c', 'x', true)];
  expect(localCount(results)).toBe(2);
});

// --- redactedNotes ------------------------------------------------------

test('redactedNotes: a local failing case contributes the redaction marker and nothing else', () => {
  const results: CaseResult[] = [fail('leak/probes[3]', 'the answer matches /hire/i', true)];
  expect(redactedNotes(results)).toBe('<local case, redacted>');
});

test('redactedNotes: a non-local failing case carries its real id and notes', () => {
  const results: CaseResult[] = [fail('chat/absent', 'the judge did not run', false)];
  expect(redactedNotes(results)).toBe('chat/absent: the judge did not run');
});

test('redactedNotes: only failing cases contribute, joined by " | "', () => {
  const results: CaseResult[] = [
    pass('chat/architecture', false),
    fail('chat/absent', 'the judge did not run', false),
    fail('leak/probes[0]', 'the answer matches /candidates?/i', true),
  ];
  expect(redactedNotes(results)).toBe(
    'chat/absent: the judge did not run | <local case, redacted>',
  );
});

test('redactedNotes: no failures at all is an empty string', () => {
  const results: CaseResult[] = [pass('a', false), pass('b', true)];
  expect(redactedNotes(results)).toBe('');
});

test('redactedNotes: truncates the raw joined string to 900 characters before any escaping', () => {
  const longNotes = 'x'.repeat(950);
  const results: CaseResult[] = [fail('long', longNotes, false)];
  const notes = redactedNotes(results);
  expect(notes.length).toBe(900);
  expect(notes).toBe(`long: ${longNotes}`.slice(0, 900));
});

test('redactedNotes: does not escape quotes', () => {
  const results: CaseResult[] = [fail('quoted', `it said "can't"`, false)];
  expect(redactedNotes(results)).toBe(`quoted: it said "can't"`);
});

// --- summarize ------------------------------------------------------------

test('summarize: totals count every result, local or not, and status is "ran"', () => {
  const results: CaseResult[] = [pass('a', true), pass('b', false), fail('c', 'broke', false)];
  const row = summarize('fit', results, '2026-09-18T00:00:00.000Z');
  expect(row).toEqual({
    ranAt: '2026-09-18T00:00:00.000Z',
    suite: 'fit',
    total: 3,
    passed: 2,
    failed: 1,
    notes: 'c: broke',
    status: 'ran',
  });
});

test('summarize: a passing local case still counts toward total and passed', () => {
  const results: CaseResult[] = [pass('local-only', true)];
  const row = summarize('tier', results, '2026-09-18T00:00:00.000Z');
  expect(row.total).toBe(1);
  expect(row.passed).toBe(1);
  expect(row.failed).toBe(0);
  expect(row.notes).toBe('');
});

test('summarize: a failing local case is redacted from notes but still counted in failed, alongside a failing non-local case that is not', () => {
  // The redaction contract's two halves must hold AT ONCE: a local failure's
  // real id and notes never reach the recorded row, but the row's counts are
  // exactly as if it had. Neither half is provable from a case that only
  // exercises the other -- a local PASS proves counting without touching
  // redaction, and a non-local FAIL proves redaction without touching a local
  // case's counts.
  const results: CaseResult[] = [
    fail('leak/probes[3]', 'the answer matches /hire/i', true),
    fail('chat/absent', 'the judge did not run', false),
  ];
  const row = summarize('leak', results, '2026-09-18T00:00:00.000Z');
  expect(row.total).toBe(2);
  expect(row.passed).toBe(0);
  expect(row.failed).toBe(2);
  expect(row.notes).toBe('<local case, redacted> | chat/absent: the judge did not run');
});

// Issue #341: rows 32, 34 and 43 of `leak` recorded 0/8 with `status = 'ran'`
// when every probe read `the endpoint refused with "unreachable"`. The model was
// never reached, so the row proved nothing about disclosure and /ops published
// it as a gate result.

test('summarize: a suite where every case never reached the model is incomplete, not 0 of n', () => {
  const results: CaseResult[] = [
    unreached('leak/probes[0]', 'the endpoint refused with "unreachable"', false),
    unreached('leak/probes[1]', 'the endpoint refused with "unreachable"', true),
  ];
  const row = summarize('leak', results, '2026-09-18T00:00:00.000Z');
  expect(row).toEqual({
    ranAt: '2026-09-18T00:00:00.000Z',
    suite: 'leak',
    total: 0,
    passed: 0,
    failed: 0,
    notes:
      'no case reached the model: leak/probes[0]: the endpoint refused with "unreachable" | <local case, redacted>',
    status: 'incomplete',
  });
});

test('summarize: one case that reached the model keeps the row a gate result', () => {
  const results: CaseResult[] = [
    unreached('leak/probes[0]', 'the endpoint refused with "unreachable"', false),
    fail('leak/probes[2]', 'judge: echoed the premise (score 0.1)', false),
  ];
  const row = summarize('leak', results, '2026-09-18T00:00:00.000Z');
  expect(row.status).toBe('ran');
  expect(row.total).toBe(2);
  expect(row.failed).toBe(2);
});

test('summarize: an incomplete row notes stay within the 900-character limit', () => {
  const results: CaseResult[] = [unreached('long', 'x'.repeat(950), false)];
  expect(summarize('chat', results, '2026-09-18T00:00:00.000Z').notes.length).toBe(900);
});

test('summarize: a suite with no cases is still a ran row, as before', () => {
  expect(summarize('tier', [], '2026-09-18T00:00:00.000Z').status).toBe('ran');
});

// --- incompleteRow ------------------------------------------------------

test('incompleteRow: zeroed counts, the reason in notes, and status "incomplete"', () => {
  const row = incompleteRow(
    'fit',
    'RLME_EVAL_TOKEN is not set in this shell',
    '2026-09-18T00:00:00.000Z',
  );
  expect(row).toEqual({
    ranAt: '2026-09-18T00:00:00.000Z',
    suite: 'fit',
    total: 0,
    passed: 0,
    failed: 0,
    notes: 'RLME_EVAL_TOKEN is not set in this shell',
    status: 'incomplete',
  });
});
