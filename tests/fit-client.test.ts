import { expect, test } from 'vitest';
import { newReportId } from '../src/lib/fit/client';

// `newReportId` (04 §2, migrations/0002_private_tier.sql's `fit_reports.id`
// comment): the permalink id. IT IS THE CAPABILITY -- `/fit/r/<id>` requires
// nothing else, so the two properties worth pinning are the ones that make
// that safe: enough entropy that it cannot be guessed, and no relationship to
// the report it names.
//
// Deliberately not tested here: that the id is DERIVED from anything about
// the report. It must never be -- not the audience, not the description, not
// a timestamp. A derived id is a guessable id (whoever can reproduce or even
// narrow the inputs can reproduce or narrow the id), and a guessable id is a
// public report, which defeats the whole design point recorded in this
// module's own comment. There is nothing to assert FOR that property beyond
// what is here: the function takes no arguments, so there is nothing in its
// signature it could derive from even if a future edit tried to.

test('newReportId returns a 22-character unpadded base64url string', () => {
  // 128 bits (16 bytes) base64url-encoded is ceil(16 * 8 / 6) = 22 characters
  // with no '=' padding -- exactly what fit_reports.id stores and what the
  // route's [id] param matches against.
  const id = newReportId();
  expect(id).toHaveLength(22);
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
});

test('repeated calls do not collide', () => {
  // Not a proof -- 128 bits of CSPRNG output makes a real collision
  // vanishingly unlikely at any sample size a test could run -- but a
  // regression that dropped to a narrower source (e.g. Math.random, or a
  // truncated byte array) would show up here well before it showed up in
  // production traffic.
  const ids = new Set(Array.from({ length: 10_000 }, () => newReportId()));
  expect(ids.size).toBe(10_000);
});
