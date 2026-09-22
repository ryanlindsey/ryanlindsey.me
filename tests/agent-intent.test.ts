import { describe, expect, test } from 'vitest';
import { highIntentFor, isIntentEvent } from '../src/lib/agent-intel/intent';

const at = '2026-09-09T12:00:00.000Z';

describe('highIntentFor', () => {
  test('a fit run is high intent and carries no pasted text', () => {
    const event = highIntentFor({
      kind: 'fit-run',
      at,
      audience: 'label-a',
      reportId: 'abc',
      outcome: 'ok',
    });
    expect(event).toEqual({
      kind: 'fit-run',
      at,
      detail: { audience: 'label-a', report: 'abc', outcome: 'ok' },
    });
    expect(JSON.stringify(event)).not.toContain('description');
  });

  test('a fit run says which way it went, and both ways are queued', () => {
    // THIS CASE REPLACES ONE ABOUT AN ABSENT AUDIENCE, which is worth knowing
    // because the reasoning survived the field. `detail` is rendered into the
    // notification email as `key=value` pairs (src/lib/agent-intel/notify.ts),
    // which is what made an optional `audience` a hazard -- an `undefined`
    // value ships as the literal `audience=undefined` -- and is now what makes
    // `outcome` load-bearing: a `fit-run` line that does not say reads as
    // success for a run that produced nothing. #277 made the field required,
    // because the producer is the Worker that resolved the grant.
    for (const outcome of ['ok', 'failed'] as const) {
      const event = highIntentFor({
        kind: 'fit-run',
        at,
        audience: 'label-a',
        reportId: 'abc',
        outcome,
      });
      expect(Object.entries(event?.detail ?? {}).map(([k, v]) => `${k}=${v}`)).toEqual([
        'audience=label-a',
        'report=abc',
        `outcome=${outcome}`,
      ]);
    }
  });

  test('a fit run cannot be built without an audience', () => {
    // A TYPE-LEVEL assertion, the same shape and the same enforcement as
    // tests/tier-private-docs.test.ts's private-bucket case: tsconfig includes
    // `tests/`, `npm run check` typechecks it, and an unused
    // `@ts-expect-error` is itself an error -- so this line fails the
    // typecheck rather than the suite. `npm test` does not typecheck and will
    // not notice either way.
    //
    // It is here because nothing else pins the field. Every runtime case in
    // this file passes an audience, so a revert that made `audience` optional
    // again and restored the spread-if-present branch would compile and stay
    // green, and the operator would be back to a `fit-run` event that cannot
    // say who the run was for.
    //
    // @ts-expect-error -- `audience` is required on `fit-run` (#277). If this
    // line ever compiles, the field is optional again.
    const event = highIntentFor({ kind: 'fit-run', at, reportId: 'abc', outcome: 'ok' });
    expect(event?.detail.report).toBe('abc');
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
