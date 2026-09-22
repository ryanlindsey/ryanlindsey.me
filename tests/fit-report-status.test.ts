import { expect, test } from 'vitest';
import { fitFailureCopy, isStale, STALE_AFTER_MS } from '../src/lib/fit/report-status';

test('an unrecognised failure code renders nothing', () => {
  // The same argument as `fitErrorCopy` in src/lib/fit/errors.ts, on a second
  // surface. /fit/r/<id> is designed to be forwarded to people holding no
  // token, so a forged or stale code must render NOTHING rather than a
  // generic banner a forger could have chosen the shape of.
  expect(fitFailureCopy('refused')).not.toBeNull();
  expect(fitFailureCopy('errored')).not.toBeNull();
  expect(fitFailureCopy('anything-else')).toBeNull();
  expect(fitFailureCopy(null)).toBeNull();
  expect(fitFailureCopy('constructor')).toBeNull();
});

test('a pending row goes stale on the far side of the budget', () => {
  const started = Date.parse('2026-09-18T04:00:00.000Z');
  expect(isStale('2026-09-18T04:00:00.000Z', started + STALE_AFTER_MS - 1)).toBe(false);
  expect(isStale('2026-09-18T04:00:00.000Z', started + STALE_AFTER_MS)).toBe(true);
  // A clock that disagrees with the row must not make a fresh run look stale.
  expect(isStale('2026-09-18T04:00:00.000Z', started - 60_000)).toBe(false);
  // An unparseable timestamp is treated as stale: refreshing forever on a row
  // nothing can read is the worse failure.
  expect(isStale('not a date', started)).toBe(true);
});
