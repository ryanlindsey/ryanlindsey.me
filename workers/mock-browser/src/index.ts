import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * Test-only stand-in for the Browser Run binding. See wrangler.jsonc in this
 * directory for why it exists and how it is wired.
 *
 * It does NOT emulate Browser Run. `@cloudflare/puppeteer` speaks CDP over a
 * WebSocket, so a faithful stand-in would be a DevTools protocol server --
 * which would be a large, brittle thing to write and a worse thing to trust.
 * Instead this Worker answers the one small contract that src/lib/resume-pdf.ts
 * uses in its 'stub' renderer mode: GET /render?url=... returns PDF bytes.
 * The real binding does not implement that path, so pointing the stub renderer
 * at a real browser binding fails loudly rather than quietly doing nothing.
 */

/**
 * Enough of a PDF to carry the magic bytes and be distinguishable. Nothing
 * under test parses it -- the assertions are on the header, the length and the
 * marker -- so it deliberately omits the xref table a real reader would need.
 */
/**
 * Copies into a plain ArrayBuffer. `Response` will not take a
 * `Uint8Array<ArrayBufferLike>` -- which is what both `TextEncoder.encode` and
 * an RPC-transferred view give you -- and copying is clearer than casting away
 * the difference.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

const DEFAULT_PDF = toArrayBuffer(
  new TextEncoder().encode('%PDF-1.7\n% mock-browser default\n%%EOF\n'),
);

let pdf: ArrayBuffer = DEFAULT_PDF;
let lastRenderUrl: string | null = null;
let renderCount = 0;
let failRenders = false;
let renderDelayMs = 0;

export default class MockBrowser extends WorkerEntrypoint {
  /** Seeds the bytes the next /render returns. */
  setPdf(bytes: Uint8Array): void {
    pdf = toArrayBuffer(bytes);
  }

  /**
   * Makes /render answer 500, which src/lib/resume-pdf.ts's stub renderer turns
   * into a throw. Stands in for the real failure this design has to survive:
   * `waitForSelector('[data-resume-ready]')` timing out after 30s because a JS
   * regression, an unsettled font or a Browser Run hiccup means the page never
   * signals ready.
   */
  setFailRenders(fail: boolean): void {
    failRenders = fail;
  }

  /**
   * Holds /render open for `ms` before answering. Exists so a test can observe
   * the site Worker's response BEFORE the render it scheduled has finished --
   * which is the only way to prove `ctx.waitUntil()` rather than `await`, and
   * so the only way to prove a visitor is never blocked on a render.
   */
  setRenderDelayMs(ms: number): void {
    renderDelayMs = ms;
  }

  /**
   * The URL the site Worker last asked to render. Tests assert on this to prove
   * the render URL comes from the SITE_ORIGIN var rather than from
   * `request.url` -- which is the thing that would break under `wrangler dev`
   * and in production, where `--infer-origin-from-routes` defaults to true.
   */
  lastRenderUrl(): string | null {
    return lastRenderUrl;
  }

  /** How many renders have been asked for. The evidence that a cache hit did not render. */
  renderCount(): number {
    return renderCount;
  }

  /** Returns to first-boot state so one test cannot leak into the next. */
  reset(): void {
    pdf = DEFAULT_PDF;
    lastRenderUrl = null;
    renderCount = 0;
    failRenders = false;
    renderDelayMs = 0;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/render') {
      return new Response(`mock-browser has no route for ${url.pathname}\n`, { status: 404 });
    }
    lastRenderUrl = url.searchParams.get('url');
    renderCount += 1;
    if (renderDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, renderDelayMs));
    }
    if (failRenders) {
      return new Response('mock-browser was told to fail this render\n', { status: 500 });
    }
    return new Response(pdf, {
      headers: { 'content-type': 'application/pdf' },
    });
  }
}
