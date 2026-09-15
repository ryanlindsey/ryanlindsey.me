import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { resumeSourceHash } from '../src/lib/resume-pdf';
import {
  RESUME_ALIAS_KEY,
  RESUME_PDF_HTTP_METADATA,
  resumePdfKey,
} from '../src/lib/resume-pdf-contract';
import { SITE_HARNESS_WORKERS } from './workers';

/**
 * What /resume.pdf does after issue #186 retired the runtime render path: a
 * hash, an R2 read and a fallback. Nothing here launches a browser, because
 * nothing in the Worker can any more -- the render lives in
 * scripts/resume-sheet.mjs and .github/workflows/resume-pdf.yml, and
 * tests/resume-sheet.test.ts is what gates it.
 *
 * THE THREE STATES ARE THE WHOLE CONTRACT, and `x-resume-pdf-state` is how a
 * reader tells them apart from outside:
 *
 *   exact     `resume/<hash>.pdf` is there -- this commit's own sheet.
 *   fallback  it is not, but `resume/latest.pdf` is -- a sheet one publish
 *             behind, which beats a linked route answering nothing.
 *   missing   neither key is in the bucket.
 *
 * The fallback is the entire reason the alias key exists (see RESUME_ALIAS_KEY
 * in src/lib/resume-pdf-contract.ts), so it gets a test of its own rather than
 * being left to inference.
 */

const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

let env: Env;

beforeAll(async () => {
  await server.listen();
  env = await server.getWorker<Env>().getEnv();
});

afterAll(async () => {
  await server.close();
});

/** The hash the deployed code computes from the committed résumé source. */
const currentHash = await resumeSourceHash();

const encoder = new TextEncoder();

/** Writes bytes at a key with the metadata the publish workflow stamps. */
async function seed(key: string, body: string): Promise<R2Object> {
  const object = await env.R2_ASSETS.put(key, encoder.encode(body), {
    httpMetadata: { ...RESUME_PDF_HTTP_METADATA },
  });
  if (object === null) throw new Error(`R2 put of ${key} returned null while seeding`);
  return object;
}

beforeEach(async () => {
  for (const key of [resumePdfKey(currentHash), RESUME_ALIAS_KEY]) {
    await env.R2_ASSETS.delete(key);
  }
});

test('serves this commit’s own sheet from the content-addressed key', async () => {
  await seed(resumePdfKey(currentHash), '%PDF-1.7 exact');

  const response = await server.fetch('/resume.pdf');

  expect(response.status).toBe(200);
  expect(response.headers.get('x-resume-pdf-state')).toBe('exact');
  expect(await response.text()).toBe('%PDF-1.7 exact');
});

test('falls back to the alias when this commit’s sheet is not published yet', async () => {
  // The state the merge gate on #186 is about: the workflow has published at
  // some point, but not for this commit. A résumé one publish behind is the
  // right answer -- the alternative is a linked route answering nothing.
  await seed(RESUME_ALIAS_KEY, '%PDF-1.7 alias');

  const response = await server.fetch('/resume.pdf');

  expect(response.status).toBe(200);
  expect(response.headers.get('x-resume-pdf-state')).toBe('fallback');
  expect(await response.text()).toBe('%PDF-1.7 alias');
});

test('prefers the content-addressed key when both are in the bucket', async () => {
  // The steady state once the workflow has run for this commit: both keys hold
  // the same bytes. Asserted with DIFFERENT bytes so the order is provable --
  // seeded identically, this test would pass whichever key the route read.
  await seed(resumePdfKey(currentHash), '%PDF-1.7 exact');
  await seed(RESUME_ALIAS_KEY, '%PDF-1.7 alias');

  const response = await server.fetch('/resume.pdf');

  expect(response.headers.get('x-resume-pdf-state')).toBe('exact');
  expect(await response.text()).toBe('%PDF-1.7 exact');
});

test('reports missing, and asks to be retried, when the bucket holds neither key', async () => {
  // 503 rather than 404, and `retry-after` rather than nothing: the sheet is
  // not absent, it is unpublished. /resume's format bar, /llms.txt and
  // /resume.json all link here, and a 404 would tell a crawler the document
  // does not exist -- which the next push to `main` makes false.
  const response = await server.fetch('/resume.pdf');

  expect(response.status).toBe(503);
  expect(response.headers.get('x-resume-pdf-state')).toBe('missing');
  expect(response.headers.get('retry-after')).toBe('300');
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
});

test('replays the metadata the publish workflow stamped on the object', async () => {
  await seed(resumePdfKey(currentHash), '%PDF-1.7 exact');

  const response = await server.fetch('/resume.pdf');

  // Set once, by scripts/resume-publish.mjs at upload time, and replayed by
  // `writeHttpMetadata` on every hit. This is the one place they can be
  // asserted against a real response: unlike /resume.md and /resume.json,
  // whose declared headers Astro's static build throws away, an on-demand
  // route's headers survive, and no public/_headers rule backs this route up.
  expect(response.headers.get('content-type')).toBe('application/pdf');
  expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  // `inline`, so a browser previews it rather than dropping a file in
  // Downloads on anyone who clicks "PDF" in the format bar.
  expect(response.headers.get('content-disposition')).toBe(
    'inline; filename="ryan-lindsey-resume.pdf"',
  );
  expect(response.headers.get('etag')).toMatch(/^"[^"]+"$/);
});

test('answers 304 when the request already carries the stored etag', async () => {
  const object = await seed(resumePdfKey(currentHash), '%PDF-1.7 exact');

  const response = await server.fetch('/resume.pdf', {
    headers: { 'if-none-match': object.httpEtag },
  });

  expect(response.status).toBe(304);
  // `httpEtag`, not `etag`: only the quoted form round-trips through
  // If-None-Match, so a 304 proves the right one was stored and served.
  expect(response.headers.get('etag')).toBe(object.httpEtag);
  expect(await response.text()).toBe('');
});

test('answers 304 on the fallback too, so the alias is cacheable as well', async () => {
  const object = await seed(RESUME_ALIAS_KEY, '%PDF-1.7 alias');

  const response = await server.fetch('/resume.pdf', {
    headers: { 'if-none-match': object.httpEtag },
  });

  expect(response.status).toBe(304);
  expect(response.headers.get('x-resume-pdf-state')).toBe('fallback');
});
