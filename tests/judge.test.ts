import { describe, expect, test } from 'vitest';
import {
  JUDGE_INPUT,
  JUDGE_VERDICT_JSON_SCHEMA,
  JudgeVerdict,
} from '../workers/mcp/src/judge-schema';

/**
 * The judge's shapes (04 §4), pure. The GATING is covered in
 * tests/mcp-gated.test.ts and the model call itself is exercised only against a
 * deployed endpoint by `npm run evals`.
 */
describe('JudgeVerdict', () => {
  test('accepts a well-formed verdict', () => {
    expect(JudgeVerdict.safeParse({ verdict: 'pass', score: 0.9, reasons: ['met'] }).success).toBe(
      true,
    );
  });

  test('rejects a score outside 0..1 and an unknown verdict', () => {
    expect(JudgeVerdict.safeParse({ verdict: 'pass', score: 1.4, reasons: [] }).success).toBe(
      false,
    );
    expect(JudgeVerdict.safeParse({ verdict: 'maybe', score: 0.5, reasons: [] }).success).toBe(
      false,
    );
  });

  test('requires at least one reason, so a verdict is never unexplained', () => {
    expect(JudgeVerdict.safeParse({ verdict: 'fail', score: 0, reasons: [] }).success).toBe(false);
    // A PASS too. An agreeable judge that never read the subject is the failure
    // this costs one sentence to make visible.
    expect(JudgeVerdict.safeParse({ verdict: 'pass', score: 1, reasons: [] }).success).toBe(false);
  });

  test('an empty reason string is not a reason', () => {
    expect(JudgeVerdict.safeParse({ verdict: 'fail', score: 0, reasons: [''] }).success).toBe(
      false,
    );
  });

  test('the JSON schema the model is handed keeps every description', () => {
    expect(JSON.stringify(JUDGE_VERDICT_JSON_SCHEMA)).toContain('criterion');
  });
});

describe('JUDGE_INPUT', () => {
  test('both fields are required and non-empty', () => {
    expect(JUDGE_INPUT.safeParse({ criteria: 'c', subject: 's' }).success).toBe(true);
    expect(JUDGE_INPUT.safeParse({ criteria: '', subject: 's' }).success).toBe(false);
    expect(JUDGE_INPUT.safeParse({ criteria: 'c' }).success).toBe(false);
  });

  test('the subject is bounded, because it arrives from a caller', () => {
    expect(JUDGE_INPUT.safeParse({ criteria: 'c', subject: 'x'.repeat(20_001) }).success).toBe(
      false,
    );
  });
});
