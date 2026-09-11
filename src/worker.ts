import { handle } from '@astrojs/cloudflare/handler';
import { classifyRequest, signalsFrom } from './lib/agent-intel/classify';
import { recordAgentEvent, type Surface } from './lib/agent-intel/record';
import { NOT_FOUND_PROBE } from './lib/not-found-probe';
import { regenerateResumePdf } from './lib/resume-pdf';
import { enforceRetention } from './lib/retention';

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

/**
 * The statuses a `/fit` response is allowed to leave as, replaced by the site's
 * own 404. Everything else on that prefix required a valid grant to produce.
 *
 * A SET rather than three comparisons because the list has grown twice: 404 was
 * the page's own refusal, 403 arrived with Astro's origin check, and 500 with a
 * request body `formData()` cannot parse. Each was a separate measurement of
 * the same oracle, and the next one is likelier to be found by reading this
 * name than by re-deriving the argument.
 */
const REFUSAL_STATUSES = new Set([403, 404, 500]);

/**
 * The response an unrouted path gets, byte for byte.
 *
 * This is `/fit`'s refusal (see the `/fit` branch below). It is fetched rather
 * than constructed so the two cannot drift: whatever the site answers a
 * stranger's typo with is what a stranger's dead token gets, with no second
 * copy of that body to keep in step.
 *
 * The method is carried over for `HEAD` so a `HEAD /fit` refusal is a `HEAD`
 * 404 rather than a `GET` one with a body attached; anything else asks as
 * `GET`, which is what an unrouted path's 404 is rendered from.
 */
function siteNotFound(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const probe = new Request(new URL(NOT_FOUND_PROBE, request.url), {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
  });
  return handle(probe, env, ctx);
}

/**
 * Everything `fetch` used to be, unchanged, so the recording wrapper below has
 * exactly one place to observe. The four early returns inside it are the
 * reason this extraction happened rather than four `recordAgentEvent` calls:
 * a fifth branch added later is counted automatically, and cannot be the one
 * somebody forgot.
 */
async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  // Day 5 Task 13 (04 §2, 09 §1): `/fit*` is unlisted and its URL carries a
  // scoped token. Two things happen to whatever the route returns, and they
  // pull in opposite directions on purpose.
  //
  // A REFUSAL IS REPLACED WITH THE SITE'S OWN 404, undecorated. The gates in
  // src/pages/fit/*.ts answer a bare `404` and this turns it into exactly the
  // response an unrouted path gets, because what a prober compares is the
  // whole response and not the status. MEASURED, and it is why
  // src/pages/404.astro now exists: before it, an unrouted path got Astro's
  // stock 404 template -- `text/html`, ~4.3 KB, and it EMBEDS THE REQUESTED
  // PATH -- so no refusal `/fit` could construct was ever byte-identical to
  // it. `Astro.rewrite('/404')` from the page was tried and measured at 500
  // (an on-demand route cannot rewrite to a prerendered one), so it is done
  // here, where a second dispatch is available.
  //
  // THE 403 AND THE 500 ARE REFUSALS TOO, and they get the same treatment.
  //
  // The 403 is Astro's `security.checkOrigin` middleware answering a
  // form-content-type POST that carries no `Origin`. That check does not run
  // for every path, and WHAT DECIDES IT IS NOT `run_worker_first` -- an
  // earlier revision of this comment said it was, and that was measured
  // false: `POST /work/nope-nope` IS matched by that list, reaches this
  // Worker (proved by `GET /work/nope-nope` carrying `Vary: Accept`, a header
  // only this file adds) and still answers the 404 page rather than 403.
  //
  // The variable is whether the path resolves to a ROUTE. An unrouted path
  // now lands on src/pages/404.astro, which is PRERENDERED, so Astro's
  // `renderDefaultError` fetches it as an asset and skips middleware
  // entirely. A matched on-demand route still reaches the check: `POST
  // /resume.pdf` with no `Origin` answers 403. So `/fit/run` answering 403
  // where a dead path answers the 404 page says "this path is a real
  // on-demand route" -- which for an unlisted surface is the whole secret.
  // Getting this backwards is worse than not writing it down: a maintainer
  // who believed the `run_worker_first` story could remove `/fit` from that
  // list expecting the asymmetry to go away, and would lose the referrer
  // protection instead.
  //
  // The 500 is the same oracle with a third status. `POST /fit/run` with
  // `content-type: application/json` MEASURED at 500 with an empty body and
  // both headers attached, against 5,182 bytes of 404 page from every dead
  // path -- `await request.formData()` throws on a body it cannot parse, and
  // it runs before either gate. That is fixed at the route as well (see
  // src/pages/fit/run.ts); this arm is the second half, because a throw
  // anywhere else in the page would reopen it and only this end catches
  // those.
  //
  // The cost of the 500 arm is real and worth stating: a genuine bug on the
  // GRANTED path is now shown as a 404 rather than a 500. The exception is
  // still logged (`observability` is on in wrangler.jsonc), so it is visible
  // to the operator and not to the caller -- which is the right way round for
  // a page whose refusal must not be distinguishable from a dead path.
  //
  // Merely leaving the two headers off these is not enough, and that was
  // measured too: decorated, `/fit/run`'s was the only 403 on the site
  // carrying them -- the same oracle wearing a different status code.
  //
  // EVERY OTHER `/fit` RESPONSE REQUIRES A VALID GRANT, and those get two
  // headers. `X-Robots-Tag` is the header form of the page's own meta tag and
  // covers the 303, which has no head to put a tag in. `Referrer-Policy:
  // no-referrer` is the load-bearing one: the Turnstile widget on this page
  // loads a script from challenges.cloudflare.com FROM A DOCUMENT WHOSE URL
  // CARRIES THE TOKEN, and this header is what keeps the token out of the
  // `Referer` on that subrequest. Base.astro emits the meta-tag form as well
  // (see its `referrer` prop) so that confinement does not rest on one line.
  // Neither header belongs on the 404: the site's 404 carries neither, and a
  // refusal that carries a header nothing else on the site sets is the same
  // oracle in a subtler form.
  //
  // BEFORE the negotiation block below rather than after it, deliberately:
  // `/fit` is never a markdown route and must not acquire `Vary: Accept`.
  // The prefix match is the `/fit*` this comment names; there is no other
  // `/fit`-prefixed route on this site, and a future one that is not part of
  // this surface would need to be excluded here.
  if (new URL(request.url).pathname.startsWith('/fit')) {
    let response: Response;
    try {
      response = await handle(request, env, ctx);
    } catch (error) {
      // A REJECTED promise, not a 500 `Response` -- a different shape from
      // the one `REFUSAL_STATUSES` below flattens, and the one that used to
      // escape this branch entirely (final-review Important 3). Anything
      // that reaches the runtime's own error page renders a body no other
      // path on this site produces, which reopens exactly the
      // route-existence oracle the flattening exists to close: a stranger
      // probing `/fit` would see a crash where an unrouted path shows a
      // 404.
      //
      // LOGGED FIRST, and this is the half that keeps the seam contract
      // honest. `verifyTurnstile` throws a plain `Error` on an unrecognised
      // `RLME_TURNSTILE_MODE`, and every day-5 seam is documented as
      // failing loudly on a bad value -- but "loudly" cannot mean "to the
      // caller" on a surface engineered to be indistinguishable from a dead
      // route. So the operator gets the stack in Workers observability and
      // the caller gets the site 404, which is the only split that serves
      // both properties. tests/mcp-env.test.ts pins the config guard that
      // keeps the value from being set in the first place.
      console.error('fit: the request threw before producing a response', error);
      return siteNotFound(request, env, ctx);
    }
    // Every refusal leaves as the site's own 404 and undecorated; only a
    // response that required a valid grant (the 200, the 303) is decorated
    // below. A browser submitting this form always sends `Origin`, so the
    // 403 arm costs a legitimate caller nothing.
    if (REFUSAL_STATUSES.has(response.status)) return siteNotFound(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

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
}

/**
 * NO CAMPAIGN DOMAINS ON THE HOT PATH, and this is a decision rather than a
 * shortcut.
 *
 * `referrerClassFor` can label a referrer as `campaign` when it is handed the
 * configured domains, and 06 §3 wants that label -- but the domains live in
 * KV, and reading KV on EVERY request to attach a label to the small minority
 * that carry a referrer at all would put a storage round trip in front of every
 * page on the site to serve an analytics row.
 *
 * So the site Worker's rows carry `social`/`search`/`other`/`none`, and the
 * campaign attribution is attached where it is both cheap and actually needed:
 * the high-intent path (Task 3), which already reads campaign config to decide
 * whether an event is high-intent, and which handles single-figure volumes.
 */
const CAMPAIGN_DOMAINS_OFF: readonly string[] = [];

/**
 * Which surface a request was served by, for the AE row (06 §3).
 *
 * Derived from the path rather than from the branch that answered, because the
 * two can disagree in exactly one interesting case: a `/fit` request that was
 * flattened into the site's 404. That is still `/fit` traffic -- somebody
 * pointed a dead or absent token at an unlisted surface -- and counting it as
 * ordinary site traffic would hide the probe the flattening exists to make
 * uninteresting to the prober, not to us.
 */
function surfaceFor(pathname: string): Surface {
  if (pathname === '/mcp') return 'mcp';
  if (pathname.startsWith('/fit')) return 'fit';
  if (pathname.startsWith('/chat')) return 'chat';
  return 'site';
}

export default {
  fetch: async (request, env, ctx) => {
    const started = Date.now();
    const response = await route(request, env, ctx);
    // AFTER the response, so `status` is the real one, and OUTSIDE any branch,
    // so there is one counter for the whole Worker.
    recordAgentEvent(env, {
      classification: classifyRequest(signalsFrom(request), CAMPAIGN_DOMAINS_OFF),
      surface: surfaceFor(new URL(request.url).pathname),
      status: response.status,
      durationMs: Date.now() - started,
    });
    return response;
  },

  /**
   * The daily jobs (see `triggers.crons` in wrangler.jsonc), dispatched on which
   * trigger fired.
   *
   * 05:17 UTC is the résumé-PDF refresh (Task 5). It is hash-gated, and that is
   * the whole point of running it on a schedule at all: `regenerateResumePdf`
   * does not touch a browser unless the résumé source hash has moved. The steady
   * state of this cron is one KV read, so cost scales with content changing
   * rather than with days elapsed.
   *
   * 05:47 UTC is the retention sweep (day 6, 06 §2). A SECOND SLOT rather than a
   * second call on the same trigger, for the reason workers/mcp/wrangler.jsonc
   * already records about its own 05:32: separated slots make a cron failure
   * attributable on sight rather than by reading which handler threw.
   *
   * `controller.cron` is the trigger's own expression, exactly as written in
   * wrangler.jsonc -- so these two strings and that array are one fact spelled in
   * two files, and the `default` arm is what makes a mismatch loud instead of
   * silent. Without it, editing a cron expression in config would leave this
   * handler matching nothing and both jobs would simply stop, with a green deploy
   * and no error anywhere.
   *
   * The publishing corpus's embedding refresh (Task 15) ran here too until the
   * `ai` binding it needs turned out to force a remote proxy session on every
   * build of this Worker. It moved, whole, to workers/mcp/src/index.ts. The two
   * jobs were independent -- one writes a PDF to R2, the other vectors to
   * Vectorize, and neither was a precondition for the other -- so nothing had to
   * be untangled to separate them.
   *
   * NOT YET PROVEN: Astro's docs show `fetch`, `queue` and Durable Object
   * exports from this entry but carry no `scheduled()` example. It should
   * survive the adapter's build by the same `ExportedHandler` rule the others
   * do, but that is inference. Task 16 confirms the deployed Worker actually
   * lists the cron trigger.
   */
  scheduled: (controller, env, ctx) => {
    switch (controller.cron) {
      case '17 5 * * *':
        ctx.waitUntil(regenerateResumePdf(env, { force: false }));
        return;
      case '47 5 * * *':
        ctx.waitUntil(
          enforceRetention(env.DB, new Date(controller.scheduledTime)).then((deleted) => {
            // One line naming every table, so `wrangler tail` around 05:47 shows
            // whether the sweep ran at all -- a delete of zero rows and a delete
            // that never happened look identical from outside.
            console.log(`retention: ${JSON.stringify(deleted)}`);
          }),
        );
        return;
      default:
        console.error(`scheduled: no job is registered for the cron "${controller.cron}"`);
    }
  },
} satisfies ExportedHandler<Env>;
