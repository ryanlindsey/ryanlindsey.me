// The campaign hero transform (04 §3), moved out of src/worker.ts in #234.
//
// A MODULE RATHER THAN A FUNCTION IN src/worker.ts, and the reason is
// testability rather than layering. #234's second task taught
// `withCampaignHero` to answer a `304`, and no request this repository's test
// harness can build reaches it with one: every harness request goes through
// `handle()`, which always answers a fresh representation rather than a
// conditional one.
// Exporting the transform from its own module is what makes that branch
// reachable from a unit test that builds the `Response` by hand, without
// putting a test seam in production code. `src/lib/tier/hero-index.ts` is the
// precedent: the same feature's other half is already a module for the same
// reason.

import { heroLineForReferrer } from '../agent-intel/classify';
import { readHeroIndex, type HeroIndexEnv } from './hero-index';

/**
 * What `withCampaignHero` needs from its caller's `Env`. `KV_CACHE` is
 * `readHeroIndex`'s own requirement, inherited rather than repeated here.
 *
 * `ASSETS` WAS DECLARED A TASK BEFORE ANYTHING IN THIS FILE CALLED IT, which
 * was deliberate rather than speculative: #234's second task added the
 * re-fetch that resolves a `304` into a full representation, through the same
 * binding `serveMarkdownAsset` in src/worker.ts already reads, and this
 * interface is the one that code consumes. The site Worker's own `Env`
 * (generated into worker-configuration.d.ts) already carries both members
 * structurally, so `src/worker.ts`'s call sites need no cast.
 */
export interface HeroBandEnv extends Pick<HeroIndexEnv, 'KV_CACHE'> {
  ASSETS: Fetcher;
}

/**
 * HTML-escapes an operator-typed string for insertion with `{ html: true }`.
 *
 * Kept as its own function rather than inlined so the escaping is one thing
 * with one name. Until 2026-09-16 the whole of `withCampaignHero`'s docblock
 * sat here instead, above this seven-line helper, which is where the spec at
 * #224 placed it; #225 moved it down onto the function it describes. Inlining
 * or deleting this helper would have taken that block's prerendering and
 * `no-store` reasoning with it -- NOT the escaping reasoning, which is the
 * inline `// ESCAPED.` comment inside `withCampaignHero`'s body and would have
 * survived. Getting that backwards is easy, so it is written down.
 *
 * Both functions moved again in #234, from src/worker.ts into this module,
 * because the transform needs to be reachable from a unit test directly: no
 * request this repository's test harness can build hands `withCampaignHero` a
 * `304`.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The campaign band, inserted after the NOW strip on the home page (04 §3).
 *
 * HTMLRewriter RATHER THAN AN ON-DEMAND ROUTE, and the reason is the home
 * page's prerendering. Making `/` on demand to vary one line would mean
 * `Vary: Referer` on the site's most-visited page, and a referrer is
 * high-cardinality enough that the cache hit rate collapses. This way the
 * static asset is served untouched on every request that does not match, and
 * only the one that does pays for a transform.
 *
 * A KV `list` WAS ON THE HOT PATH UNTIL #233, and this comment denied that
 * before it was corrected (2026-09-16, by #225). It read: "NO KV READ WITHOUT
 * A CROSS-ORIGIN REFERRER, which is what keeps this off the critical path for
 * nearly all traffic". The guard is real -- a direct visit and a same-origin
 * navigation both return above, before any storage is touched -- but a
 * cross-origin referrer is exactly what a search result and a social link
 * both produce, so what the guard admits is a large share of home page
 * arrivals rather than a rarity. That traffic shape is the whole reason the
 * index below exists, so it is recorded here rather than left in the issue:
 * `walkCampaigns` always issued at least one KV `list`, and a `list` cannot be
 * given a `cacheTtl` the way a `get()` can, so there was no knob that turned
 * it into a local read -- every one of those requests paid a round trip to KV
 * in front of a page that is otherwise a static asset, and with `KV_CONFIG`
 * empty (measured 2026-09-08) it paid it to discover there was nothing to
 * render. Stated that way deliberately: #225 put it as "a `list` is never edge
 * cached", which is a claim about KV's internals that Cloudflare's
 * documentation does not make, and this comment should not assert more than
 * the API reference supports.
 *
 * `CAMPAIGN_DOMAINS_OFF` below refuses a related trade for the analytics path,
 * and the two are worth reading together rather than as one argument. It
 * declines a KV read on EVERY request site-wide to label "the small minority
 * that carry a referrer at all"; this is a read on home page arrivals that
 * carry a cross-origin one. Different denominators, which is why both
 * sentences can be true at once -- and why that constant's wording is not
 * evidence for or against the traffic shape described here. What those
 * arrivals pay now is one cacheable `get`.
 *
 * THE MECHANISM IS A `get`, AND IT COULD NEVER HAVE BEEN A `cacheTtl` ON THE
 * `list`. This paragraph used to point at `walkCampaigns` as "where a
 * `cacheTtl` would go" and then correct itself, and the correction is what
 * survives: Workers KV's `list()` takes `prefix`, `limit` and `cursor` and
 * nothing else, while `cacheTtl` is a parameter of `get()` and
 * `getWithMetadata()` (checked against Cloudflare's KV binding documentation,
 * 2026-09-16 -- `readCampaignForAudience` made the same assumption and was
 * corrected in the same pass). What it said would work is what #233 built: a
 * single cacheable `get()` of one aggregate key pairing every `active`
 * campaign's referrer domains with its hero line, read by `readHeroIndex` in
 * src/lib/tier/hero-index.ts. That key lives in `KV_CACHE` rather than
 * `KV_CONFIG`, and which binding holds it is what names its writer:
 * `KV_CONFIG` is authored from the private planning repo (10 §2.3), while
 * every `KV_CACHE` key is written by code in this repository -- `hero:index`
 * by the five-minute cron in `scheduled()` below and by nothing else. Not by
 * this Worker alone, though: the namespace is bound to the MCP Worker too,
 * which writes `corpus:manifest` into it, so what the binding distinguishes is
 * authored configuration from derived cache rather than one Worker from the
 * other. It stayed a different object from the audience->id index
 * `readCampaignForAudience` contemplates for its own residual `list`: one
 * aggregate key for the whole corpus here, one key per campaign there.
 *
 * WHAT IT COSTS INSTEAD, because the saving is not free. Staleness, bounded by
 * the cron interval plus the read's `cacheTtl` -- about ten minutes worst case
 * from an authored change to this band reflecting it, five minutes for the
 * next cron run plus five for the stalest cached read -- and bounded at ten
 * minutes only while the cron is running. And a dependency on `scheduled()`
 * firing at all: the NOT YET PROVEN note in that handler's docblock below is
 * no longer a caveat on background sweeps alone, because if it never fires the
 * index is never written, `readHeroIndex` sees a missing key forever, and this
 * band renders for nobody. A cron that fires and then STOPS fails the other
 * way: the index key carries no `expirationTtl`, so the last one written
 * serves indefinitely and a campaign flipped to `retired` keeps rendering its
 * line here forever -- the pre-#232 failure returning through a dead cron
 * rather than through a missing gate. ./lib/tier/hero-index's module header
 * carries the full account of both directions; it is not restated here,
 * because two copies of one mechanism have to be kept in step sentence by
 * sentence and this is the copy that would drift.
 *
 * `no-store` ON THE VARIANT ONLY. An intermediary holding the untransformed
 * response and handing it to a referred visitor shows them the default page,
 * which is the safe direction. The reverse -- one visitor's campaign band
 * served from cache to everyone -- is what this header exists to prevent.
 *
 * THE `status` GAP CLOSED 2026-09-16 (#232), AND THE GATE HAS SINCE MOVED
 * (#233). This docblock used to list two known gaps, filed rather than fixed
 * by #225, which was a plan correction that deliberately left this file's
 * behavior alone. The first was that this function gated on no `status` at
 * all, so a `retired` campaign kept rendering its hero line to anyone arriving
 * from its referrer domains, forever -- measured 2026-09-15 in the harness
 * with a `status: 'retired'` entry and a matching `Referer` (04 §3, 00 §5 and
 * 09 §3 now say the band is the one reader `status` has). #232 is the change
 * that makes that true; the gate itself now lives in `buildHeroIndex`
 * (src/lib/tier/hero-index.ts), where a non-`active` campaign's domains are
 * dropped before they are ever written to the key this function reads. So
 * `status` still has exactly one reader, one step further from the request.
 *
 * The reason it filters BEFORE matching rather than after did not stop being
 * true when it moved, so it is kept here beside the match it constrains.
 * Matching is first-match-wins over whatever list it is handed, so a
 * post-match gate loses an active campaign that shares a referrer domain with
 * a retired one KV happens to list first: the retired entry is what the match
 * returns, and the gate then bails on the whole response instead of trying the
 * next entry. Verified empirically rather than reasoned through:
 * `tests/campaign-hero.test.ts`'s ordering-trap test was run against a
 * deliberate post-match gate first, and it failed there, before the
 * filter-before-match version was written.
 *
 * THE `304` GAP CLOSED 2026-09-16 (#234). This docblock used to list it as the
 * one remaining gap, filed rather than fixed: the content-type guard below
 * returned early on a `304`, which carries no `Content-Type` (RFC 9110
 * section 15.4.5 does not list it among the fields a `304` sends), so a
 * returning visitor revalidating with `If-None-Match` never saw the band at
 * all. The guard now carves the `304` out, and a matched hero line resolves it
 * into a full representation with one headerless re-fetch through `ASSETS`
 * before the transform runs.
 *
 * WHAT #234 GOT WRONG, recorded rather than quietly overwritten because a
 * correction is what tells the next reader which arguments have already been
 * tried. The issue reasoned that the `304` reached the guard. MEASURED
 * 2026-09-16, against the built artifact the harness boots, it does not:
 * `env.ASSETS.fetch('/', { headers: { 'If-None-Match': <matching etag> } })`
 * returns `304`, while the same conditional request through this Worker's
 * front door returns `200`, with the band, every time. `handle()` never
 * produces a `304` for `/`. The reason is `matchStaticAsset` in
 * node_modules/@astrojs/cloudflare/dist/utils/cf-helpers.js, whose only fetch
 * is `return env.ASSETS.fetch(requestUrl.replace(/\.html$/, ''))` -- a bare
 * URL string, discarding every request header including `If-None-Match`.
 * `fallbackToAssets` in the same file does the same. So the bail this function
 * had was unreachable through `handle()`, and the gap as filed described a
 * response no request could hand this function.
 *
 * IT IS FIXED ANYWAY, which is a decision rather than an oversight. The
 * guard's correctness rested entirely on an adapter internal that no test in
 * this repository controls and that can change in a patch release with no
 * signal here. And `serveMarkdownAsset` in src/worker.ts reaches the same
 * binding by a path that DOES forward the conditional -- it passes
 * `headers: request.headers` deliberately, so that conditional requests work
 * at all -- so the two halves of this Worker currently disagree about whether
 * a `304` can arrive, and one of them is one adapter release away from being
 * right. That function's comment already recorded the same CLASS of bail as
 * its own "fix round 2", a guard written for a `200` falling over on a `304`;
 * not the same predicate, since that one tested `!assetResponse.ok` on a
 * response it had fetched itself while this tested the content type of
 * whatever `handle()` returned, but close enough that the warning was in this
 * codebase already and was reproduced anyway. tests/hero-band.test.ts is what
 * reaches the branch: a `Response` built by hand and handed to this exported
 * function, with no test seam in this file.
 *
 * THE RE-FETCH LOSES NO HEADER DECORATION, which is the other thing that had
 * to be true before resolving a `304` this way was safe. public/_headers's
 * `/*` rule carries a note, measured against production 2026-09-07, that
 * Cloudflare's asset server applies these rules to any response whose body
 * came from a static asset, "including one src/worker.ts fetched itself
 * through the `ASSETS` binding after running first". So the page this function
 * fetches back arrives carrying the same `Link`, `X-For-AI-Agents`,
 * `X-MCP-Server` and `X-Markdown-Variant` as the one `handle()`'s own fetch
 * would have produced, and the variant built from it is decorated identically.
 *
 * THE VALIDATOR IS DROPPED RATHER THAN SUFFIXED, and that is worth writing
 * down because suffixing is the more obvious move. A validator only means
 * anything for a STORED representation, and this variant is `no-store`, so
 * nothing may store it. A suffixed `ETag` would also be one this origin can
 * never honor on a later conditional request, because the adapter discards
 * `If-None-Match` before the binding ever sees it (the measurement above), so
 * it would advertise a revalidation this Worker cannot perform. Dropping is
 * the only option that cannot mislead a cache that ignores `no-store`: it
 * leaves such a cache nothing to revalidate against, where an echoed validator
 * has it revalidate the band-carrying variant and be handed the untransformed
 * page under the same `ETag` -- one URL serving two bodies under one
 * validator, which is the defect rather than a symptom of it. `Last-Modified`
 * is deleted alongside it even though the asset server sends none on this
 * route (measured 2026-09-16), because the argument is about validators rather
 * than about one header name.
 */
export async function withCampaignHero(
  request: Request,
  response: Response,
  env: HeroBandEnv,
): Promise<Response> {
  if (new URL(request.url).pathname !== '/') return response;
  // A `304` IS LET PAST THIS GUARD, and everything else that is not HTML is
  // still refused by it. A `304` carries no `Content-Type` at all, so a test on
  // the content type alone swallowed exactly the response a revalidating
  // visitor gets (#234). The guard stays early and stays cheap either way: a
  // response this function cannot transform still costs no KV read.
  if (
    response.status !== 304 &&
    !(response.headers.get('content-type') ?? '').includes('text/html')
  )
    return response;

  const referer = request.headers.get('referer');
  if (referer === null || referer === '') return response;
  // Same-origin navigations are the common case and never a campaign arrival.
  try {
    if (new URL(referer).hostname === new URL(request.url).hostname) return response;
  } catch {
    return response;
  }

  // One cacheable `get` of the derived index, never a walk of the campaign
  // entries -- including when the key is missing, which renders no band rather
  // than falling back (see `readHeroIndex`). `null` is no domain matched and
  // `''` is a matched entry whose authored line is empty; both mean no band
  // here, and `heroLineForReferrer` keeps them distinct for the caller that
  // one day needs the difference.
  const heroLine = heroLineForReferrer(referer, await readHeroIndex(env));
  if (heroLine === null || heroLine === '') return response;

  // AFTER THE MATCH, NEVER BEFORE IT. A `304` for an arrival that matches no
  // campaign domain has to cost nothing, so the re-fetch that turns one into a
  // body sits below `heroLineForReferrer` rather than beside the guard that
  // now lets the `304` through.
  //
  // `request.url` UNCHANGED rather than a rebuilt `'/'`, so a query string
  // reaches the binding exactly as `handle()` would have sent it. THE METHOD
  // TRAVELS AND THE HEADERS DO NOT, which is one decision rather than two
  // halves of an oversight. `serveMarkdownAsset` in src/worker.ts forwards
  // both to this same binding, and the method half is worth copying: without
  // it a `HEAD /` reaching this branch is re-fetched as a `GET` and answered
  // with a body. The conditional headers are the one thing that must not come
  // along, because they are what produced the `304` and this fetch exists to
  // produce the representation instead. tests/hero-band.test.ts asserts the
  // exact init for that reason: `headers: request.headers` is the single line
  // a later reader is most likely to add helpfully, and it would restore
  // #234's defect in silence -- the re-fetch would answer `304`, `!source.ok`
  // would fire, and the band would stop rendering for the one visitor it
  // exists for.
  //
  // `source.ok` IS LOAD-BEARING, THOUGH NOT FOR THE REASON FIRST WRITTEN HERE.
  // This comment claimed the unguarded version "would transform that error
  // page into the band-carrying variant and serve it as a `200`", and that is
  // wrong: the response below is built from `transformed.status`, and
  // `transform()` preserves status, so a `500` source yields a `500` carrying
  // a band. The real harm is one the wrong sentence hid. Without this check a
  // valid `304` becomes a `500` or a `404` -- it takes away a cached copy the
  // client already holds and answers its revalidation with an error body,
  // which is strictly worse than the stale-looking page the client would
  // otherwise have reused. `serveMarkdownAsset` states the same rule for the
  // same binding: any other status is passed through rather than converted,
  // because the job is to keep one URL's representations from being confused
  // for each other.
  //
  // THE `try` GUARDS THE HAZARD src/lib/tier/hero-index.ts CLOSED EARLIER ON
  // 2026-09-16, one call further along this same path. Nothing above here
  // catches -- not the call site in src/worker.ts, not that module's exported
  // `fetch` -- so a rejected `ASSETS.fetch` escapes the Worker and answers the
  // home page with the runtime's own error page, on exactly the arrivals this
  // band exists to serve. That module's `readHeroIndex` had just been given
  // this guard when this branch added a second uncaught remote call beside it,
  // which is how a hazard gets fixed and reintroduced in one day. A rejection
  // now returns the original `304` for the same reason a refused status does,
  // so the rule holds for both: this feature fails toward no band, never
  // toward a broken page.
  //
  // IT WARNS, following `readHeroIndex`'s precedent, because a failed
  // re-fetch is otherwise indistinguishable from an arrival that matched no
  // campaign domain -- both render nothing. The cost is one line per matching
  // arrival for as long as the binding is failing, which is the same trade
  // that module already accepted.
  let source = response;
  if (response.status === 304) {
    try {
      source = await env.ASSETS.fetch(request.url, { method: request.method });
    } catch {
      console.warn('hero-band: the re-fetch failed; returning the 304 and rendering no band');
      return response;
    }
    if (!source.ok || !(source.headers.get('content-type') ?? '').includes('text/html'))
      return response;
  }

  // ESCAPED. `hero_line` is typed by hand into KV, and `{ html: true }` inserts
  // raw markup -- so a stray `<` in an entry would be injection on this site's
  // own home page. Operator-authored is not the same as trusted markup.
  const band =
    `<section data-campaign-hero class="border-b border-rule bg-accent-ground/10">` +
    `<div class="mx-auto max-w-[1440px] px-5 py-4 lg:px-10">` +
    `<p class="text-small text-ink">${escapeHtml(heroLine)}</p>` +
    `</div></section>`;

  const transformed = new HTMLRewriter()
    .on('[data-now-strip]', {
      element(element) {
        element.after(band, { html: true });
      },
    })
    .transform(source);

  const headers = new Headers(transformed.headers);
  headers.set('Cache-Control', 'no-store');
  // The validators go with it. See this function's docblock for why they are
  // dropped rather than suffixed, and why `Last-Modified` is deleted even
  // though the asset server does not send one on this route today.
  headers.delete('ETag');
  headers.delete('Last-Modified');
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  });
}
