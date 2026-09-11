import { describe, expect, test } from 'vitest';
import { highIntentFor, isIntentEvent } from '../src/lib/agent-intel/intent';

const at = '2026-09-09T12:00:00.000Z';

describe('highIntentFor', () => {
  test('a fit run is high intent and carries no pasted text', () => {
    const event = highIntentFor({ kind: 'fit-run', at, audience: 'label-a', reportId: 'abc' });
    expect(event).toEqual({
      kind: 'fit-run',
      at,
      detail: { audience: 'label-a', report: 'abc' },
    });
    expect(JSON.stringify(event)).not.toContain('description');
  });

  test('any gated tool call is high intent, whichever tool it was', () => {
    expect(
      highIntentFor({ kind: 'gated-read', at, tool: 'get_references', audience: 'label-a' })?.kind,
    ).toBe('gated-read');
  });

  test('a resume PDF download counts only when the referrer is campaign or social', () => {
    expect(highIntentFor({ kind: 'resume-pdf', at, referrerClass: 'campaign' })).not.toBeNull();
    expect(highIntentFor({ kind: 'resume-pdf', at, referrerClass: 'social' })).not.toBeNull();
    expect(highIntentFor({ kind: 'resume-pdf', at, referrerClass: 'none' })).toBeNull();
    expect(highIntentFor({ kind: 'resume-pdf', at, referrerClass: 'search' })).toBeNull();
  });

  test('the first message of a chat session counts and the rest do not', () => {
    expect(highIntentFor({ kind: 'chat', at, firstOfSession: true })).not.toBeNull();
    expect(highIntentFor({ kind: 'chat', at, firstOfSession: false })).toBeNull();
  });

  test('an ordinary page view is never high intent', () => {
    expect(highIntentFor({ kind: 'page', at })).toBeNull();
  });

  test('isIntentEvent rejects anything that did not come from this module', () => {
    expect(isIntentEvent({ kind: 'fit-run', at, detail: {} })).toBe(true);
    expect(isIntentEvent({ kind: 'made-up', at, detail: {} })).toBe(false);
    expect(isIntentEvent('a string')).toBe(false);
    expect(isIntentEvent(null)).toBe(false);
  });
});
