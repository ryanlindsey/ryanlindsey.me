import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { RESUME_ALIAS_KEY, resumePdfKey, resumeSourceHash } from '../lib/resume-pdf';

/**
 * The résumé as a PDF (02 §1), rendered in CI and served from R2.
 *
 * A hash, an R2 read and a fallback, and nothing else. Until #186 this route
 * could also RENDER the document -- launching a browser on a cold miss and
 * scheduling one behind a stale response -- which is where its complexity came
 * from and where the epic's measured failures came from with it. The sheet is
 * now built by .github/workflows/resume-pdf.yml on a push to `main`, gated by
 * scripts/resume-gate.mjs before it is uploaded, and this route only reads.
 *
 * THIS ROUTE STAYS ON-DEMAND rather than becoming a static asset, and two
 * separate things depend on that.
 *
 * The `resume-pdf-referred` analytics producer in src/worker.ts fires on this
 * path, and it can only fire because this Worker's `fetch` runs at all. A
 * static asset at this path would be served by the Asset Worker and never
 * reach `fetch` -- `run_worker_first` in wrangler.jsonc exists for exactly that
 * problem, and does NOT list /resume.pdf, because a route that is on-demand by
 * nature has never needed the entry. Making this an asset means adding one.
 *
 * And the response headers below are real. Astro's static build discards a
 * PRERENDERED endpoint's Response headers and writes only the body, which is
 * why /resume.md and /resume.json need rules in public/_headers and this route
 * does not. That is what carries `content-disposition: inline` to the browser,
 * so the sheet previews instead of dropping a file in Downloads. Do not "fix"
 * this route by adding a _headers rule for it.
 *
 * `output: 'static'` with zero `prerender = false` routes also makes the
 * Cloudflare adapter emit `main: undefined` and build an assets-only Worker,
 * dropping `queue()` and `scheduled()` from the deployment with no error
 * anywhere. This route was the first to opt out and a paragraph here claimed
 * it was the only one, which stopped being true several issues ago: /chat,
 * /fit and /ops and their endpoints opt out too, seven files in all. Note that
 * /404 is deliberately NOT one of them -- see src/pages/404.astro, which
 * forbids it in as many words.
 */
export const prerender = false;

/**
 * Which key answered, in the manner of `cf-cache-status`:
 *
 *   exact     `resume/<hash>.pdf`, this commit's own sheet.
 *   fallback  `resume/latest.pdf`, a sheet one or more publishes behind.
 *   missing   neither key is in the bucket.
 *
 * Exists so the behaviour is observable from outside rather than inferred --
 * tests/resume-pdf.test.ts asserts on it, and it is the difference between
 * proving the fallback serves the alias and merely proving it serves bytes.
 */
const STATE_HEADER = 'x-resume-pdf-state';

/**
 * How long a client is asked to wait for the `missing` case, in seconds. It is
 * matched to RESUME_PDF_HTTP_METADATA's own `max-age=300` rather than reasoned
 * about separately: both are answering "how stale may a résumé be", and the
 * publish that fixes a `missing` is a push to `main`, which is not faster.
 */
const RETRY_AFTER_SECONDS = 300;

function pdfHeaders(object: R2Object, state: string): Headers {
  const headers = new Headers();
  // The content type, cache-control and content-disposition the publish script
  // stamped at upload time (RESUME_PDF_HTTP_METADATA). Replayed, not restated:
  // a second copy here is the duplicate #185 removed.
  object.writeHttpMetadata(headers);
  // `httpEtag`, not `etag`: R2 exposes both, and only `httpEtag` is the
  // RFC 9110 quoted form a client can compare against.
  headers.set('etag', object.httpEtag);
  headers.set(STATE_HEADER, state);
  return headers;
}

/** Serves the bytes at `key`, or `null` when that key is not in the bucket. */
async function serveFromR2(key: string, request: Request, state: string): Promise<Response | null> {
  // `onlyIf: request.headers` hands If-None-Match / If-Modified-Since to R2
  // itself rather than reimplementing conditional-request semantics here. R2
  // then returns an R2Object with no body when the condition already holds.
  const object = await env.R2_ASSETS.get(key, { onlyIf: request.headers });
  if (object === null) return null;
  if (!('body' in object)) {
    return new Response(null, { status: 304, headers: pdfHeaders(object, state) });
  }
  return new Response(object.body, { headers: pdfHeaders(object, state) });
}

export const GET: APIRoute = async ({ request }) => {
  // The content-addressed key first: it is the only one that can be proved to
  // match the résumé this deployment was built from.
  const exact = await serveFromR2(resumePdfKey(await resumeSourceHash()), request, 'exact');
  if (exact !== null) return exact;

  // THE FALLBACK IS THE WHOLE REASON THE ALIAS KEY EXISTS. The workflow
  // publishes both keys together, so the gap this covers is a deploy that
  // reached Cloudflare before the publish job finished, or a résumé edit whose
  // workflow run failed. A sheet one publish behind is a better answer than
  // nothing on a route linked from /resume, /llms.txt and /resume.json.
  const fallback = await serveFromR2(RESUME_ALIAS_KEY, request, 'fallback');
  if (fallback !== null) return fallback;

  // 503 and not 404: the document is unpublished rather than absent, and the
  // next push to `main` publishes it. A 404 on a route this many documents
  // link to is a broken link that a crawler will believe.
  return new Response('The résumé PDF has not been published yet. Try again shortly.\n', {
    status: 503,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': String(RETRY_AFTER_SECONDS),
      [STATE_HEADER]: 'missing',
    },
  });
};
