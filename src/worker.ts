import { handle } from '@astrojs/cloudflare/handler';
import { regenerateResumePdf } from './lib/resume-pdf';

/**
 * The site's Worker entry.
 *
 * `workerEntryPoint` was removed in @astrojs/cloudflare v13 / Astro 6. The
 * supported mechanism is `main` in wrangler.jsonc plus `handle` from
 * @astrojs/cloudflare/handler, which is exactly what Astro's own stock entry
 * is (`{ fetch: handle }`) -- this file REPLACES that entry rather than
 * wrapping it, so `handle` is called directly and undecorated.
 *
 * This file only exists once a route opts out of prerendering. With
 * `output: 'static'` and no such route, the adapter passes `main: undefined`
 * to its Vite plugin and the build is assets-only, which would leave
 * `scheduled()` below working under `astro dev` and silently absent from the
 * deployed Worker. src/pages/resume.pdf.ts is the route that keeps that from
 * happening; it is on-demand by nature rather than a contrivance.
 *
 * Task 8's `Accept:` negotiation is the other handler here. Task 15's corpus
 * embedding job is NOT, though it briefly was: it needs the `ai` binding, and an
 * `ai` binding in this Worker's wrangler.jsonc makes `astro build` open a remote
 * proxy session it has no credentials for in CI. The job, its bindings and its
 * cron all live on the MCP Worker now (workers/mcp/src/index.ts); see
 * wrangler.jsonc for the mechanism.
 */

// --- Day 3 Task 8 (02 §3): `Accept: text/markdown` content negotiation ----
//
// 02 §3 requires markdown at `<path>.md` (Task 7) AND via `Accept:
// text/markdown` negotiation on the extensionless path. This is why
// negotiation lives here rather than as a static rule: `public/_headers`
// cannot branch on a request header, only on a path.
//
// Reuse, not re-derivation: this reads the SAME prerendered `.md` asset
// Task 7's routes already wrote to `dist/client` through the `ASSETS`
// binding, rather than calling `toMarkdown()`/`renderResumeMarkdown()` again
// at request time. One rendering path, one output, no per-request cost.
//
// LOAD-BEARING CONFIG, not just code: every page this negotiates for is a
// prerendered static asset, and wrangler.jsonc's `assets.run_worker_first`
// defaults to false -- meaning a request matching one of those assets is
// served by the Asset Worker and never reaches this `fetch` at all. Verified
// empirically (a debug header set unconditionally at the top of `fetch`
// never appeared on the response for `/writing/<slug>`, `/work/<slug>` or
// `/resume` without it): this code is unreachable dead weight unless
// wrangler.jsonc's `run_worker_first` names these routes. See that file's
// comment for which ones and why -- including the negative `!.../*.md`
// patterns that keep the already-suffixed `.md` sibling assets OFF this
// path (fix round 1): `markdownAssetPathFor` below rejects them on sight
// (they already carry their own extension), so routing them through the
// Worker at all would have been a pure-cost detour to the same asset
// `handle()`'s fallback would otherwise serve directly.

const NEGOTIABLE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Maps an incoming request pathname to the `.md` asset that mirrors it, or
 * `null` when the path is not one of the content routes with a markdown
 * variant.
 *
 * Content routes: `/resume`, `/writing/<slug>`, `/work/<slug>` -- exactly
 * the set src/pages/resume.md.ts, src/pages/writing/[...slug].md.ts and
 * src/pages/work/[...slug].md.ts prerender (drafts included: negotiation
 * mirrors the detail routes, and only the aggregation surfaces filter
 * drafts). The aggregation pages themselves (`/writing`, `/work`) have no
 * variant and are excluded by the regex requiring a non-empty slug after
 * the section.
 *
 * A path that already carries its own extension (`/resume.pdf`,
 * `/writing/foo.md`, `/resume.json`, ...) is asking for one specific
 * representation via the URL itself, checked and excluded before anything
 * else -- it must never be re-negotiated onto a different one.
 *
 * The trailing slash is stripped before mapping. An extensionless request
 * like `/writing/foo` 307-redirects to `/writing/foo/` before Cloudflare
 * would ever serve an asset for it (confirmed over real HTTP in
 * task-7-report.md), so a real request reaches this function in either
 * form. Naively appending `.md` to the slashed form would produce the
 * nonexistent `/writing/foo/.md`; stripping first makes both forms resolve
 * to the same, correct `/writing/foo.md`.
 */
function markdownAssetPathFor(pathname: string): string | null {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (/\.[^/]+$/.test(trimmed)) return null;
  if (trimmed === '/resume') return '/resume.md';
  const match = /^\/(writing|work)\/(.+)$/.exec(trimmed);
  return match ? `/${match[1]}/${match[2]}.md` : null;
}

interface MediaRange {
  type: string;
  subtype: string;
  q: number;
}

/**
 * Parses an `Accept` header into its media ranges. Only `q` is read out of
 * each range's parameters -- every other parameter (`charset`, a vendor
 * suffix, ...) is irrelevant to the text/markdown-vs-text/html decision this
 * module exists to make.
 */
function parseAccept(header: string): MediaRange[] {
  return header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [mediaType = '', ...params] = part.split(';').map((piece) => piece.trim());
      const [type = '*', subtype = '*'] = mediaType.toLowerCase().split('/');
      let q = 1;
      for (const param of params) {
        const [key, value] = param.split('=').map((piece) => piece.trim());
        if (key === 'q' && value !== undefined) {
          const parsed = Number.parseFloat(value);
          if (!Number.isNaN(parsed)) q = parsed;
        }
      }
      return { type, subtype, q };
    });
}

/**
 * The `q` value a set of parsed media ranges assigns to `type/subtype`, by
 * RFC 9110's specificity rule: an exact match outranks a `type/*` range,
 * which outranks the full wildcard range (`*` type, `*` subtype). A range
 * that does not apply at all yields `0` -- "not acceptable", the same as an
 * explicit `;q=0`.
 */
function acceptQuality(ranges: MediaRange[], type: string, subtype: string): number {
  let bestSpecificity = -1;
  let bestQ = 0;
  for (const range of ranges) {
    let specificity: number;
    if (range.type === type && range.subtype === subtype) specificity = 2;
    else if (range.type === type && range.subtype === '*') specificity = 1;
    else if (range.type === '*' && range.subtype === '*') specificity = 0;
    else continue;
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQ = range.q;
    }
  }
  return bestQ;
}

/**
 * Whether `acceptHeader` prefers `text/markdown` over `text/html` --
 * strictly, not merely "acceptable". A bare wildcard `Accept` value (curl's
 * default, and most HTTP libraries' and crawlers') matches both types at
 * the same wildcard specificity and therefore the same `q`, so the
 * comparison below is never strictly greater and this correctly returns
 * `false`: HTML stays the default representation for the overwhelmingly
 * common case of a client that did not ask for anything in particular.
 * Getting this backwards would flip the site's default representation for
 * most non-browser clients.
 *
 * Any other tie (e.g. `text/markdown;q=0.5, text/html;q=0.5`), and the case
 * where `text/html` outweighs `text/markdown` (e.g.
 * `text/markdown;q=0.1, text/html;q=0.9`), resolve to `false` the same way:
 * markdown must be genuinely preferred, not merely tied or trailing, before
 * the default flips. A missing/empty header is treated the same as a bare
 * wildcard.
 */
function prefersMarkdown(acceptHeader: string | null): boolean {
  if (!acceptHeader) return false;
  const ranges = parseAccept(acceptHeader);
  const markdownQ = acceptQuality(ranges, 'text', 'markdown');
  const htmlQ = acceptQuality(ranges, 'text', 'html');
  return markdownQ > htmlQ;
}

/**
 * Clones `response` with `Accept` appended to its `Vary` header (`append`,
 * not `set` -- a response can legitimately vary on more than one header
 * already, and this must add to that list, never replace it). A fresh
 * `Response`/`Headers` pair is built rather than mutating `response.headers`
 * in place, because a `Response` returned by a `fetch()` call (as both call
 * sites below hand this) is not guaranteed mutable.
 */
function withVaryAccept(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.append('Vary', 'Accept');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Fetches `markdownPath` through the `ASSETS` binding and returns it with
 * `Vary: Accept` appended, or `null` if the asset does not exist -- in which
 * case the caller falls through to `handle()` exactly as if negotiation had
 * not run.
 *
 * `Vary: Accept` is mandatory on the response this returns: without it,
 * Cloudflare's cache could key a markdown body under a URL a browser then
 * requests with `Accept: text/html`, and serve raw markdown as if it were
 * the page.
 *
 * "DOES NOT EXIST" IS `404`, NOT `!ok` (fix round 2). The request headers are
 * forwarded to the asset binding verbatim -- deliberately, so conditional
 * requests work at all -- which means a client that cached `/resume.md` and
 * revalidates with `If-None-Match` gets a `304` back from that binding. `304`
 * is not `ok`, so the earlier `!assetResponse.ok` bail treated the single most
 * common cache-revalidation response as "there is no markdown here" and fell
 * through to `handle()`, answering a conditional markdown request with a full
 * HTML page (observed: `GET /resume`, `Accept: text/markdown` +
 * `If-None-Match` -> `200 text/html`, 9,503 bytes). Passing it through is
 * correct and legal: a `304` carries no body, and `Vary: Accept` matters more
 * on it than anywhere else, since it is precisely the response a shared cache
 * uses to decide which stored representation to reuse.
 *
 * Any other non-404 status (a `500` out of the asset binding, say) is also
 * passed through rather than converted into an HTML page: this module's whole
 * job is to keep one URL's two representations from being confused for each
 * other, and answering a failed markdown fetch with HTML is exactly that
 * confusion.
 */
async function serveMarkdownAsset(
  env: Env,
  markdownPath: string,
  request: Request,
): Promise<Response | null> {
  const assetResponse = await env.ASSETS.fetch(new URL(markdownPath, request.url).toString(), {
    method: request.method,
    headers: request.headers,
  });
  if (assetResponse.status === 404) return null;
  return withVaryAccept(assetResponse);
}

export default {
  fetch: async (request, env, ctx) => {
    // Day 4 Task 13 (03 §1): https://ryanlindsey.me/mcp is the PRIMARY MCP
    // endpoint and mcp.ryanlindsey.me the vanity alias, so this origin must
    // serve the protocol rather than a 404. One Worker owns the MCP server
    // (workers/mcp/src/index.ts); this forwards to it over the `MCP` service
    // binding rather than hosting a second copy, so the two origins cannot
    // answer differently and this file grows no routing, CORS or origin-policy
    // logic of its own.
    //
    // The request is passed through unchanged -- method, headers (Origin
    // included, for Task 2's browser-connector CORS policy) and body. Nothing
    // here touches the request object, so the hop is faithful by construction
    // rather than by a field-by-field reconstruction that could drift.
    //
    // The MCP handler matches on the request's pathname via `route: '/mcp'`
    // (workers/mcp/src/index.ts's HANDLER_OPTIONS). A service binding's
    // `Fetcher.fetch()` delivers the request to the target Worker with its
    // URL untouched -- verified here, not assumed: tests/pages.test.ts's
    // "/mcp on the site origin completes the MCP handshake" only turns green
    // once this forward is wired in, which would not be true if the pathname
    // were rewritten or dropped somewhere along the hop.
    if (new URL(request.url).pathname === '/mcp') return env.MCP.fetch(request);

    // `markdownPath` is non-null exactly on a content route being fetched
    // with a negotiable method -- i.e. exactly the requests this module has
    // an opinion about. It is computed once and used twice below: to decide
    // whether to attempt serving markdown, AND (fix round 1, "Vary: Accept
    // asymmetry") to decide whether the HTML `handle()` fallback on that
    // same route needs `Vary: Accept` too. Without it, a shared cache could
    // key an HTML response under a URL a markdown-preferring client later
    // requests, and serve cached HTML in place of ever reaching this code
    // again -- the same class of stale-representation bug the markdown
    // side's `Vary` header guards against, just in the other direction.
    const markdownPath = NEGOTIABLE_METHODS.has(request.method)
      ? markdownAssetPathFor(new URL(request.url).pathname)
      : null;

    if (markdownPath && prefersMarkdown(request.headers.get('Accept'))) {
      const negotiated = await serveMarkdownAsset(env, markdownPath, request);
      if (negotiated) return negotiated;
    }

    const response = await handle(request, env, ctx);
    return markdownPath ? withVaryAccept(response) : response;
  },

  /**
   * The daily job (see `triggers.crons` in wrangler.jsonc): the résumé-PDF
   * refresh (Task 5), and now only that.
   *
   * The publishing corpus's embedding refresh (Task 15) ran here too until the
   * `ai` binding it needs turned out to force a remote proxy session on every
   * build of this Worker. It moved, whole, to workers/mcp/src/index.ts. The two
   * jobs were independent -- one writes a PDF to R2, the other vectors to
   * Vectorize, and neither was a precondition for the other -- so nothing had to
   * be untangled to separate them.
   *
   * It is hash-gated, and that is the whole point of running it on a schedule at
   * all: `regenerateResumePdf` does not touch a browser unless the résumé source
   * hash has moved. The steady state of this cron is one KV read, so cost scales
   * with content changing rather than with days elapsed.
   *
   * NOT YET PROVEN: Astro's docs show `fetch`, `queue` and Durable Object
   * exports from this entry but carry no `scheduled()` example. It should
   * survive the adapter's build by the same `ExportedHandler` rule the others
   * do, but that is inference. Task 16 confirms the deployed Worker actually
   * lists the cron trigger.
   */
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(regenerateResumePdf(env, { force: false }));
  },
} satisfies ExportedHandler<Env>;
