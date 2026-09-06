import puppeteer from '@cloudflare/puppeteer';
import type { BrowserWorker } from '@cloudflare/puppeteer';
// The hash input is the résumé's own source bytes, imported with Vite's `?raw`
// so it works in every bundle this module lands in. It deliberately does NOT go
// through getResume()/astro:content: this module is imported by src/worker.ts,
// which the Cloudflare Vite plugin builds as the Worker entry rather than as
// part of Astro's SSR graph, and `astro:content` is an Astro-only virtual
// module. The raw file IS the serialized collection entry, so nothing is lost.
// A rename of the file breaks the build loudly rather than silently hashing
// something else.
import resumeSource from '../content/resume/ryan-lindsey.yaml?raw';

/**
 * Bump when src/pages/resume.astro's rendered contract changes in a way that
 * should produce a different PDF from identical résumé data -- a layout change,
 * a new section, different print CSS.
 *
 * This constant exists because the hash is taken over the résumé INPUTS, not
 * over the rendered HTML. Hashing the HTML would look more correct and be
 * badly wrong: the rendered page carries content-hashed asset URLs
 * (/_astro/*.css) that change on every deploy, so the PDF would regenerate
 * every deploy forever and browser-hours would scale with deploys instead of
 * with content.
 */
export const RESUME_PDF_CONTRACT_VERSION = 1;

/** KV key holding the manifest. The manifest write is the commit point. */
export const RESUME_PDF_MANIFEST_KEY = 'resume-pdf:manifest';

/** KV key holding the render lock. See acquireRenderLock() for its limits. */
export const RESUME_PDF_LOCK_KEY = 'resume-pdf:lock';

/**
 * The lock is deleted on success and left to expire on failure, so this doubles
 * as the cooldown after a crashed render -- see regenerateResumePdf().
 *
 * 60s is also KV's minimum accepted TTL, so it is the shortest cooldown
 * available. That is the right end of the range to sit at: it is long enough to
 * collapse a burst of retries into one render, and short enough that a
 * transient Browser Run failure does not leave the PDF unrepairable for long.
 */
const RENDER_LOCK_TTL_SECONDS = 60;

/** The page Browser Run navigates to, relative to SITE_ORIGIN. */
export const RESUME_PRINT_PATH = '/resume?print';

/** The attribute src/pages/resume.astro sets once document.fonts.ready resolves. */
export const RESUME_READY_SELECTOR = '[data-resume-ready]';

/**
 * What R2 holds and what /resume.pdf serves. `key` is content-addressed, so
 * writing bytes is idempotent and the manifest write -- which happens last --
 * is what makes a new PDF live. Task 15 reuses this shape rather than
 * inventing a second one.
 */
export interface ResumePdfManifest {
  /** resumeSourceHash() at the time the bytes were rendered. */
  hash: string;
  /** R2 key, `resume/<hash>.pdf`. */
  key: string;
  /** R2's `httpEtag` -- the RFC 9110 quoted form, ready to serve verbatim. */
  etag: string;
  /** ISO 8601. */
  builtAt: string;
  /** Bytes. */
  size: number;
}

export type ResumePdfRenderer = (url: string) => Promise<Uint8Array>;

/**
 * Only the bindings this module actually reads. Narrower than `Env` so the
 * module says what it needs, and so a caller can see at a glance that it
 * touches KV, R2 and the browser and nothing else.
 */
export interface ResumePdfEnv {
  KV_CACHE: KVNamespace;
  R2_ASSETS: R2Bucket;
  BROWSER: BrowserWorker;
  /** Never `request.url`: see the SITE_ORIGIN comment in wrangler.jsonc. */
  SITE_ORIGIN: string;
  /**
   * Test-only seam, and the only reason it is read here: `@cloudflare/puppeteer`
   * talks CDP over a WebSocket, so a stand-in for the BROWSER binding would have
   * to be a full DevTools protocol server -- which is not a thing worth writing
   * or trusting. Instead the test harness overrides BROWSER to a mock Worker
   * (workers/mock-browser) and sets this var to 'stub', and the render step
   * becomes one fetch to that Worker. No deployed environment sets this var --
   * wrangler.jsonc does not declare it -- so every deployment renders with
   * Puppeteer, and an unrecognised value throws rather than falling back.
   */
  RESUME_PDF_RENDERER?: string;
}

const encoder = new TextEncoder();

/**
 * SHA-256 over the contract version and the résumé source bytes, hex-encoded.
 * Stable across deploys by construction: nothing in the input moves unless the
 * résumé content or the page's contract does.
 */
export async function resumeSourceHash(source: string = resumeSource): Promise<string> {
  const input = `resume-pdf/v${RESUME_PDF_CONTRACT_VERSION}\n${source}`;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function resumePdfKey(hash: string): string {
  return `resume/${hash}.pdf`;
}

export async function readResumePdfManifest(
  env: Pick<ResumePdfEnv, 'KV_CACHE'>,
): Promise<ResumePdfManifest | null> {
  return await env.KV_CACHE.get<ResumePdfManifest>(RESUME_PDF_MANIFEST_KEY, 'json');
}

/** The URL Browser Run navigates to. Driven by SITE_ORIGIN, never by a request. */
export function resumePrintUrl(env: Pick<ResumePdfEnv, 'SITE_ORIGIN'>): string {
  return new URL(RESUME_PRINT_PATH, env.SITE_ORIGIN).href;
}

/**
 * Renders /resume?print with Browser Run.
 *
 * Three waits are used together, not one: `networkidle0` (the default,
 * `domcontentloaded`, fires before webfonts land -- the documented top cause of
 * blank or unstyled PDF output), `waitForFonts` on the PDF call itself, and the
 * explicit [data-resume-ready] selector the page sets inside
 * document.fonts.ready. The selector is the only deterministic "actually
 * painted" signal; the other two are heuristics.
 */
export function browserRenderer(browser: BrowserWorker): ResumePdfRenderer {
  return async (url) => {
    const session = await puppeteer.launch(browser);
    try {
      const page = await session.newPage();
      await page.emulateMediaType('print');
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 45_000 });
      await page.bringToFront();
      await page.waitForSelector(RESUME_READY_SELECTOR, { timeout: 30_000 });
      const pdf = await page.pdf({
        format: 'letter',
        printBackground: true,
        preferCSSPageSize: true,
        waitForFonts: true,
        margin: { top: '0.6in', right: '0.6in', bottom: '0.6in', left: '0.6in' },
      });
      return new Uint8Array(pdf);
    } finally {
      // Always, on every path. An unclosed browser burns billable browser time
      // until the idle timeout rather than stopping when the render does.
      await session.close();
    }
  };
}

/**
 * The test stand-in described on ResumePdfEnv.RESUME_PDF_RENDERER. It speaks a
 * contract of this repo's own making, which the real Browser Run binding does
 * not implement -- so pointing it at a real binding fails loudly.
 */
function stubRenderer(browser: BrowserWorker): ResumePdfRenderer {
  return async (url) => {
    const response = await browser.fetch(
      `https://mock-browser.invalid/render?url=${encodeURIComponent(url)}`,
    );
    if (!response.ok) {
      throw new Error(`mock browser returned ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

export function rendererFor(env: ResumePdfEnv): ResumePdfRenderer {
  const mode = env.RESUME_PDF_RENDERER ?? 'browser';
  if (mode === 'browser') return browserRenderer(env.BROWSER);
  if (mode === 'stub') return stubRenderer(env.BROWSER);
  throw new Error(`unknown RESUME_PDF_RENDERER ${JSON.stringify(mode)}`);
}

/**
 * Best-effort mutual exclusion, and described that way on purpose. KV is
 * eventually consistent, so two Workers can both read "no lock" and both
 * render. What this buys is bounding a burst to a handful of browsers instead
 * of one per request; it is not a correctness guarantee, and it does not need
 * to be -- concurrent renders write the same content-addressed key with the
 * same bytes.
 *
 * There is no matching release function on purpose: regenerateResumePdf deletes
 * the key on the success path only, so a failed render keeps the lock until its
 * TTL expires.
 */
async function acquireRenderLock(env: Pick<ResumePdfEnv, 'KV_CACHE'>): Promise<boolean> {
  if ((await env.KV_CACHE.get(RESUME_PDF_LOCK_KEY)) !== null) return false;
  await env.KV_CACHE.put(RESUME_PDF_LOCK_KEY, new Date().toISOString(), {
    expirationTtl: RENDER_LOCK_TTL_SECONDS,
  });
  return true;
}

export type RegenerateResult =
  | { status: 'unchanged'; manifest: ResumePdfManifest }
  | { status: 'rendered'; manifest: ResumePdfManifest }
  | { status: 'locked'; manifest: ResumePdfManifest | null };

export interface RegenerateOptions {
  /** Render even when the manifest hash already matches. */
  force?: boolean;
  /** Overrides the renderer chosen from `env`. */
  render?: ResumePdfRenderer;
}

/**
 * The single render entry point: the cron handler, the stale-serve background
 * job and the cold-miss request path all come through here, so the lock covers
 * all three against each other.
 *
 * Step 2 is what keeps browser-hours near zero. A cron that renders
 * unconditionally is the expensive mistake this shape exists to avoid: at one
 * scheduled run a day, the steady state is a single KV read.
 *
 * THE LOCK IS RELEASED ONLY ON SUCCESS. A render that throws leaves it in
 * place to expire on its own, which turns RENDER_LOCK_TTL_SECONDS into a
 * cooldown. This is deliberate and it is the only backoff in the design.
 * Without it, the failure mode is the expensive one: if `[data-resume-ready]`
 * never appears -- a JS regression on /resume, a font that never settles, a
 * Browser Run hiccup -- `waitForSelector` throws after 30s, and with a stale
 * manifest every single request to /resume.pdf would then schedule its own
 * fresh render in waitUntil. That is close to one browser session per request
 * on a route now linked from /resume, so reachable by crawlers.
 */
export async function regenerateResumePdf(
  env: ResumePdfEnv,
  options: RegenerateOptions = {},
): Promise<RegenerateResult> {
  const currentHash = await resumeSourceHash();
  const manifest = await readResumePdfManifest(env);

  if (!options.force && manifest?.hash === currentHash) {
    return { status: 'unchanged', manifest };
  }

  if (!(await acquireRenderLock(env))) {
    return { status: 'locked', manifest };
  }

  const render = options.render ?? rendererFor(env);
  const bytes = await render(resumePrintUrl(env));
  const key = resumePdfKey(currentHash);
  const object = await env.R2_ASSETS.put(key, bytes, {
    httpMetadata: {
      contentType: 'application/pdf',
      cacheControl: 'public, max-age=300',
      contentDisposition: 'inline; filename="ryan-lindsey-resume.pdf"',
    },
  });
  if (object === null) {
    throw new Error(`R2 put of ${key} did not return an object`);
  }
  // Written last, and only after the bytes are durable: the manifest flip is
  // the commit. Content-addressed keys make that atomic by construction --
  // a half-finished run leaves an orphan object nothing points at, never a
  // manifest pointing at bytes that are not there.
  const next: ResumePdfManifest = {
    hash: currentHash,
    key,
    etag: object.httpEtag,
    builtAt: new Date().toISOString(),
    size: bytes.byteLength,
  };
  await env.KV_CACHE.put(RESUME_PDF_MANIFEST_KEY, JSON.stringify(next));
  // No `finally`. Reaching this line is what proves the render worked; every
  // other exit leaves the lock to expire. See the note above.
  await env.KV_CACHE.delete(RESUME_PDF_LOCK_KEY);
  return { status: 'rendered', manifest: next };
}
