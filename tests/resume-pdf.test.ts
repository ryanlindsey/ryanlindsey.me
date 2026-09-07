import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import {
  RESUME_PDF_LOCK_KEY,
  RESUME_PDF_MANIFEST_KEY,
  rendererFor,
  resumePdfKey,
  resumeSourceHash,
  type ResumePdfManifest,
} from '../src/lib/resume-pdf';
import { SITE_HARNESS_WORKERS, TEST_SITE_ORIGIN } from './workers';

/**
 * Day 3 Task 5. Every case here runs with ZERO Cloudflare credentials and
 * without downloading Chrome.
 *
 * Miniflare does ship a real Browser Run plugin -- verified by grepping the
 * installed bundle, which has 48 references to it and none to `quickAction` --
 * so `puppeteer.launch(env.BROWSER)` genuinely works locally. It is not used
 * here: its first run downloads 150-200 MB of Chrome-for-Testing, which has no
 * place on a required CI path. ./workers.ts overrides the BROWSER binding to
 * workers/mock-browser instead, using Cloudflare's own documented
 * `bindingOverrides` pattern.
 *
 * What no test here can prove, because only a deploy can: that a Worker
 * rendering a page it itself serves does not deadlock. That is Task 16's
 * smoke test. The recursion guard below is built and tested regardless.
 */
type MockBrowserModule = typeof import('../workers/mock-browser/src/index');

const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

let env: Env;
let mock: Awaited<
  ReturnType<ReturnType<typeof server.getWorker<unknown, MockBrowserModule>>['getExport']>
>;

beforeAll(async () => {
  await server.listen();
  env = await server.getWorker<Env>().getEnv();
  mock = await server.getWorker<unknown, MockBrowserModule>('mock-browser').getExport();
});

afterAll(async () => {
  await server.close();
});

/** The hash the deployed code will compute from the committed résumé source. */
const currentHash = await resumeSourceHash();

const encoder = new TextEncoder();

async function readManifest(): Promise<ResumePdfManifest | null> {
  return await env.KV_CACHE.get<ResumePdfManifest>(RESUME_PDF_MANIFEST_KEY, 'json');
}

/**
 * Polls until `read` returns something. Needed because the stale path and
 * `scheduled()` both do their work in `ctx.waitUntil()`, i.e. after the thing
 * the test observed has already happened.
 */
async function waitFor<T>(
  read: () => Promise<T | null | undefined>,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Puts bytes in R2 and points a manifest at them. `hash` decides fresh vs stale. */
async function seedManifest(hash: string, body: string): Promise<ResumePdfManifest> {
  const key = resumePdfKey(hash);
  const object = await env.R2_ASSETS.put(key, encoder.encode(body), {
    httpMetadata: { contentType: 'application/pdf' },
  });
  if (object === null) throw new Error('R2 put returned null while seeding');
  const manifest: ResumePdfManifest = {
    hash,
    key,
    etag: object.httpEtag,
    builtAt: new Date().toISOString(),
    size: body.length,
  };
  await env.KV_CACHE.put(RESUME_PDF_MANIFEST_KEY, JSON.stringify(manifest));
  return manifest;
}

beforeEach(async () => {
  await env.KV_CACHE.delete(RESUME_PDF_MANIFEST_KEY);
  await env.KV_CACHE.delete(RESUME_PDF_LOCK_KEY);
  for (const key of [resumePdfKey(currentHash), resumePdfKey('stalehash'), 'resume/other.pdf']) {
    await env.R2_ASSETS.delete(key);
  }
  await mock.reset();
});

test('serves the stored PDF without rendering when the manifest hash is current', async () => {
  await seedManifest(currentHash, '%PDF-1.7 fresh');

  const response = await server.fetch('/resume.pdf');

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/pdf');
  expect(response.headers.get('x-resume-pdf-state')).toBe('fresh');
  expect(await response.text()).toBe('%PDF-1.7 fresh');
  // The point of the manifest. A cache hit that still launches a browser is
  // the expensive mistake this whole shape exists to avoid.
  expect(await mock.renderCount()).toBe(0);
});

test('answers 304 when the request already has the stored etag', async () => {
  const manifest = await seedManifest(currentHash, '%PDF-1.7 fresh');

  const response = await server.fetch('/resume.pdf', {
    headers: { 'if-none-match': manifest.etag },
  });

  expect(response.status).toBe(304);
  // `httpEtag`, not `etag`: only the quoted form round-trips through
  // If-None-Match, so a 304 proves the right one was stored and served.
  expect(response.headers.get('etag')).toBe(manifest.etag);
  expect(await response.text()).toBe('');
  expect(await mock.renderCount()).toBe(0);
});

test('serves stale bytes immediately and regenerates behind the response', async () => {
  await seedManifest('stalehash', '%PDF-1.7 stale');
  await mock.setPdf(encoder.encode('%PDF-1.7 regenerated'));
  // The render is held open so the response can be observed BEFORE it lands.
  // Without this the test passes whether the route uses `ctx.waitUntil()` or a
  // bare `await`: the response body comes from the manifest read before either,
  // and the poll below returns on its first tick because regeneration has
  // already finished. The delay is what makes "the visitor is not blocked" an
  // assertion instead of a description.
  const RENDER_DELAY_MS = 750;
  await mock.setRenderDelayMs(RENDER_DELAY_MS);

  const startedAt = Date.now();
  const response = await server.fetch('/resume.pdf');
  const elapsedMs = Date.now() - startedAt;

  // The visitor gets bytes now. A résumé one edit out of date beats a visitor
  // held open for the length of a browser render.
  expect(response.status).toBe(200);
  expect(response.headers.get('x-resume-pdf-state')).toBe('stale');
  expect(await response.text()).toBe('%PDF-1.7 stale');

  // Both halves of "never block a visitor on a render", checked before the
  // regeneration is allowed to finish: the response beat the render, and the
  // commit point had not moved when it arrived.
  expect(elapsedMs).toBeLessThan(RENDER_DELAY_MS);
  expect((await readManifest())?.hash).toBe('stalehash');

  const manifest = await waitFor(async () => {
    const current = await readManifest();
    return current?.hash === currentHash ? current : null;
  }, 'the background regeneration to write a current manifest');

  expect(manifest.key).toBe(resumePdfKey(currentHash));
  expect(await mock.renderCount()).toBe(1);
  const regenerated = await env.R2_ASSETS.get(manifest.key);
  expect(await regenerated?.text()).toBe('%PDF-1.7 regenerated');
});

test('renders inline on a cold miss and drives the URL from SITE_ORIGIN', async () => {
  await mock.setPdf(encoder.encode('%PDF-1.7 cold'));

  const response = await server.fetch('/resume.pdf');

  expect(response.status).toBe(200);
  expect(response.headers.get('x-resume-pdf-state')).toBe('rendered');
  expect(await response.text()).toBe('%PDF-1.7 cold');
  expect(await mock.renderCount()).toBe(1);

  // These headers are set once, at R2 put time, and replayed by
  // writeHttpMetadata on every later hit -- so this is the one place they can
  // be asserted against a real response. Unlike /resume.md and /resume.json,
  // whose declared headers Astro's static build throws away, an on-demand
  // route's headers survive: no public/_headers rule backs this route up.
  expect(response.headers.get('content-type')).toBe('application/pdf');
  expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  // `inline`, so the browser previews it rather than dropping a file in
  // Downloads on anyone who clicks "PDF" in the format bar.
  expect(response.headers.get('content-disposition')).toBe(
    'inline; filename="ryan-lindsey-resume.pdf"',
  );
  expect(response.headers.get('etag')).toMatch(/^"[^"]+"$/);

  // The whole reason SITE_ORIGIN is a var: under `wrangler dev` and in
  // production, --infer-origin-from-routes makes `request.url` read as
  // https://ryanlindsey.me/..., so a render URL derived from it would point
  // local dev at production. This harness cannot reproduce that -- it sets
  // inferOriginFromRoutes: false, so `request.url` here is the loopback
  // address -- but the loopback host is not this sentinel either, so the
  // assertion still fails if anyone swaps the var for `request.url`.
  expect(await mock.lastRenderUrl()).toBe(`${TEST_SITE_ORIGIN}/resume?print`);

  const manifest = await readManifest();
  expect(manifest?.hash).toBe(currentHash);
  expect(manifest?.size).toBe('%PDF-1.7 cold'.length);
});

test('repairs a manifest whose bytes are missing from R2', async () => {
  // A current hash with no object behind it. Without the cold-miss path's
  // `force: true`, regeneration would see a matching hash, decline to render,
  // and the route could never repair itself.
  await seedManifest(currentHash, '%PDF-1.7 doomed');
  await env.R2_ASSETS.delete(resumePdfKey(currentHash));
  await mock.setPdf(encoder.encode('%PDF-1.7 repaired'));

  const response = await server.fetch('/resume.pdf');

  expect(response.status).toBe(200);
  expect(await response.text()).toBe('%PDF-1.7 repaired');
  expect(await mock.renderCount()).toBe(1);
});

test('declines to render a cold miss while another render holds the lock', async () => {
  // Asserted by holding the lock rather than by firing N concurrent requests:
  // a real burst races, and a test that sometimes sees one render and
  // sometimes two proves nothing on the run where it passes. This asserts the
  // mechanism the burst depends on.
  await env.KV_CACHE.put(RESUME_PDF_LOCK_KEY, new Date().toISOString(), { expirationTtl: 60 });

  const response = await server.fetch('/resume.pdf');

  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('10');
  expect(response.headers.get('x-resume-pdf-state')).toBe('locked');
  expect(await mock.renderCount()).toBe(0);
});

test('keeps the lock after a failed render, so the TTL becomes a cooldown', async () => {
  // The only backoff in the design, and the one path that costs money if it is
  // missing. A render that throws -- waitForSelector timing out because
  // [data-resume-ready] never appears is the realistic case -- must NOT release
  // the lock, or a stale manifest turns every subsequent request into its own
  // browser session. Releasing in a `finally` would look tidier and would be
  // exactly this bug.
  await mock.setFailRenders(true);

  const response = await server.fetch('/resume.pdf');
  expect(response.status).toBe(500);
  expect(await mock.renderCount()).toBe(1);
  expect(await env.KV_CACHE.get(RESUME_PDF_LOCK_KEY)).not.toBeNull();

  // And the cooldown is real: the next request is refused rather than starting
  // a second browser, even though the first one failed.
  await mock.setFailRenders(false);
  const second = await server.fetch('/resume.pdf');
  expect(second.status).toBe(503);
  expect(second.headers.get('x-resume-pdf-state')).toBe('locked');
  expect(await mock.renderCount()).toBe(1);
});

test('refuses requests stamped by Browser Run', async () => {
  await seedManifest(currentHash, '%PDF-1.7 fresh');

  // Browser Run stamps these on every request it makes and they cannot be
  // stripped. Without this guard a rendered page that linked back here would
  // recurse, each level costing a Worker invocation AND a browser session.
  for (const header of ['cf-biso-devtools', 'cf-brapi-devtools']) {
    const response = await server.fetch('/resume.pdf', { headers: { [header]: '1' } });
    expect(response.status, `${header} should be refused`).toBe(404);
  }
  expect(await mock.renderCount()).toBe(0);
});

test('scheduled() renders when there is no manifest', async () => {
  await mock.setPdf(encoder.encode('%PDF-1.7 cron'));

  const result = await server
    .getWorker()
    .scheduled({ cron: '17 5 * * *', scheduledTime: new Date() });
  expect(result.outcome).toBe('ok');

  const manifest = await waitFor(readManifest, 'the cron run to write a manifest');
  expect(manifest.hash).toBe(currentHash);
  expect(await mock.renderCount()).toBe(1);
});

test('scheduled() does not render when the manifest is already current', async () => {
  await seedManifest(currentHash, '%PDF-1.7 fresh');

  const result = await server
    .getWorker()
    .scheduled({ cron: '17 5 * * *', scheduledTime: new Date() });

  expect(result.outcome).toBe('ok');
  // The steady state of the daily cron is one KV read. A cron that rendered
  // unconditionally would cost a browser session every single day.
  expect(await mock.renderCount()).toBe(0);
});

test('refuses to guess when RESUME_PDF_RENDERER is not a value it knows', () => {
  // The renderer seam has exactly two values and no fallback. A typo in a var
  // that silently produced a real Browser Run session -- or silently produced
  // nothing -- is the failure mode this rules out; the deployed default comes
  // from the var being ABSENT, not from a default branch.
  const fakeEnv = {
    KV_CACHE: null as unknown as KVNamespace,
    R2_ASSETS: null as unknown as R2Bucket,
    BROWSER: { fetch: globalThis.fetch },
    SITE_ORIGIN: TEST_SITE_ORIGIN,
  };
  expect(() => rendererFor({ ...fakeEnv, RESUME_PDF_RENDERER: 'stubb' })).toThrow(
    /unknown RESUME_PDF_RENDERER/,
  );
  expect(() => rendererFor(fakeEnv)).not.toThrow();
});
