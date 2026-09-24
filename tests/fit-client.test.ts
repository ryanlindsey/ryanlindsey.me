import { afterEach, expect, test, vi } from 'vitest';
import { newReportId } from '../src/lib/fit/report-id';

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
  // And every one of them is an id Workflows will accept, which is what
  // `FIT_WORKFLOW.create` is handed (workers/mcp/src/fit-start.ts). At one in
  // sixty-four, ten thousand draws meet a leading `-` about 156 times, so a
  // regression cannot slip past this by luck.
  for (const id of ids) expect(id).toMatch(WORKFLOW_INSTANCE_ID);
});

// The instance-id pattern Workflows enforces, copied from miniflare's
// workflows binding (`ALLOWED_STRING_ID_PATTERN`, wrangler 4.135.0): the first
// character may not be `-`. The public limits page states only the
// 100-character maximum.
const WORKFLOW_INSTANCE_ID = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

afterEach(() => {
  vi.restoreAllMocks();
});

test('an id that would start with "-" is drawn again rather than handed to Workflows', () => {
  // THE CI FLAKE BEHIND #384, placed 2026-09-24. A first byte of 0xF8-0xFB
  // encodes to `+`, which base64url makes `-`: one draw in sixty-four. Workflows
  // refuses that id with "Workflow instance has invalid id", `startRun`
  // abandons the row as `failed`/`errored`, and the three suites that read a
  // freshly opened row saw `failed` where they expected `pending`. Reproduced
  // under the harness on the ids -J1cfmfvHv6B_Ok49KkppQ and
  // -WJb8aB9AtCY6eEZC60CEA.
  const draws = [new Uint8Array(16).fill(0xf8), new Uint8Array(16).fill(0x41)];
  const spy = vi
    .spyOn(crypto, 'getRandomValues')
    .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      (array as unknown as Uint8Array).set(draws.shift() ?? new Uint8Array(16));
      return array;
    });

  const id = newReportId();

  expect(spy).toHaveBeenCalledTimes(2);
  expect(id).toMatch(WORKFLOW_INSTANCE_ID);
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
});
