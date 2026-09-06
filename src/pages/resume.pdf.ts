import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  readResumePdfManifest,
  regenerateResumePdf,
  resumeSourceHash,
  type ResumePdfManifest,
} from '../lib/resume-pdf';

/**
 * Day 3 Task 5 (02 §1): the PDF format of the résumé, rendered by Browser Run
 * and served from R2.
 *
 * This is the site's first and only on-demand route, and that is load-bearing
 * well beyond this file. `output: 'static'` with zero `prerender = false`
 * routes makes the Cloudflare adapter emit `main: undefined` and build an
 * assets-only Worker -- no dist/_worker.js, no `ASSETS` binding, and any
 * `scheduled()` handler silently dropped from the deployed Worker while still
 * working under `astro dev`. One route opting out flips the whole build.
 *
 * The route is on-demand because of what it does, not to achieve that: it
 * reads a KV manifest and streams R2 bytes, neither of which exists at build
 * time. Everything else on the site stays prerendered.
 *
 * Unlike /resume.md and /resume.json, the headers below are real. Astro's
 * static build discards a PRERENDERED endpoint's Response headers and writes
 * only the body, which is why those two need rules in public/_headers. An
 * on-demand route's response is the response. Do not "fix" this route by
 * adding a _headers rule for it.
 */
export const prerender = false;

/**
 * Browser Run stamps these on every request it makes, and they cannot be
 * stripped or overridden with setExtraHTTPHeaders. They are the recursion
 * guard: if the rendered page ever routed back into this handler, every level
 * would be a separately billed Worker invocation AND a separate browser
 * session. `cf-biso-devtools` is the Quick Actions spelling and
 * `cf-brapi-devtools` the Puppeteer/CDP one; both are checked because the two
 * call sites are interchangeable and this file should not care which is live.
 */
const BROWSER_RUN_MARKER_HEADERS = ['cf-biso-devtools', 'cf-brapi-devtools'];

/**
 * Cache state, in the manner of `cf-cache-status`: `fresh` served straight from
 * R2, `stale` served from R2 while a regeneration runs behind the response,
 * `rendered` produced by this request. Exists so the behaviour is observable
 * rather than inferred -- tests/resume-pdf.test.ts asserts on it, and it is the
 * difference between proving the stale path serves stale bytes and merely
 * proving it serves bytes.
 */
const STATE_HEADER = 'x-resume-pdf-state';

function isBrowserRunRequest(request: Request): boolean {
  return BROWSER_RUN_MARKER_HEADERS.some((header) => request.headers.has(header));
}

function pdfHeaders(object: R2Object, state: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // `httpEtag`, not `etag`: R2 exposes both, and only `httpEtag` is the
  // RFC 9110 quoted form a client can compare against.
  headers.set('etag', object.httpEtag);
  headers.set(STATE_HEADER, state);
  return headers;
}

/** Serves the bytes a manifest points at, or `null` when they are not there. */
async function serveFromR2(
  manifest: ResumePdfManifest,
  request: Request,
  state: string,
): Promise<Response | null> {
  // `onlyIf: request.headers` hands If-None-Match / If-Modified-Since to R2
  // itself rather than reimplementing conditional-request semantics here. R2
  // then returns an R2Object with no body when the condition already holds.
  const object = await env.R2_ASSETS.get(manifest.key, { onlyIf: request.headers });
  if (object === null) return null;
  if (!('body' in object)) {
    return new Response(null, { status: 304, headers: pdfHeaders(object, state) });
  }
  return new Response(object.body, { headers: pdfHeaders(object, state) });
}

export const GET: APIRoute = async ({ request, locals }) => {
  if (isBrowserRunRequest(request)) {
    return new Response(null, { status: 404 });
  }

  const [currentHash, manifest] = await Promise.all([
    resumeSourceHash(),
    readResumePdfManifest(env),
  ]);

  if (manifest !== null) {
    const stale = manifest.hash !== currentHash;
    if (stale) {
      // Serve what exists, regenerate behind the response. A visitor is never
      // held on a browser render; the worst they get is a résumé one change
      // out of date, and only until the background job lands.
      locals.cfContext.waitUntil(regenerateResumePdf(env, { force: false }));
    }
    const response = await serveFromR2(manifest, request, stale ? 'stale' : 'fresh');
    if (response !== null) return response;
  }

  // Cold miss: no manifest, or a manifest pointing at bytes R2 does not have.
  // `force: true` because the second case would otherwise see a matching hash
  // and return without rendering, leaving the route permanently unable to
  // repair itself. The lock inside regenerateResumePdf is what keeps a burst
  // of cold-miss requests from launching a browser each.
  const result = await regenerateResumePdf(env, { force: true });
  if (result.status !== 'rendered') {
    return new Response('The résumé PDF is being generated. Try again shortly.\n', {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': '10',
        [STATE_HEADER]: result.status,
      },
    });
  }

  const response = await serveFromR2(result.manifest, request, 'rendered');
  if (response !== null) return response;
  return new Response('The résumé PDF could not be read back after rendering.\n', {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
