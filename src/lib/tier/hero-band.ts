// The campaign hero transform (04 §3), moved out of src/worker.ts in #234.
//
// A MODULE RATHER THAN A FUNCTION IN src/worker.ts, and the reason is
// testability rather than layering. Task 2 of #234 teaches `withCampaignHero`
// to answer a `304`, and no request this repository's test harness can build
// reaches it with one: every harness request goes through `handle()`, which
// always answers a fresh representation rather than a conditional one.
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
 * `ASSETS` IS DECLARED EVEN THOUGH NOTHING IN THIS FILE CALLS IT YET, and that
 * is deliberate rather than speculative. Task 2 adds a re-fetch that resolves
 * a `304` into a full representation, through the same binding
 * `serveMarkdownAsset` in src/worker.ts already reads, and this interface is
 * the one that task's code consumes. The site Worker's own `Env` (generated
 * into worker-configuration.d.ts) already carries both members structurally,
 * so `src/worker.ts`'s call sites need no cast.
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
 * ONE KNOWN GAP remains, filed rather than fixed here:
 *
 * - The content-type guard below returns early on a `304`, which carries no
 *   `Content-Type` (RFC 9110 section 15.4.5 does not list it among the fields
 *   a `304` sends), so a returning visitor revalidating with `If-None-Match`
 *   never sees the band at all (#234). Reasoned from the spec rather than
 *   measured, which is the weaker half of this note: #234 measures it.
 *   `serveMarkdownAsset` earlier in this file records the same CLASS of bail
 *   as its own "fix round 2" -- a guard written for a `200` falling over on a
 *   `304` -- though not the same predicate, since that one tested
 *   `!assetResponse.ok` on a response it fetched from `env.ASSETS` directly
 *   while this tests the content type of whatever `handle()` returned. Close
 *   enough that the warning was already in this file, and it was reproduced
 *   anyway.
 */
export async function withCampaignHero(
  request: Request,
  response: Response,
  env: HeroBandEnv,
): Promise<Response> {
  if (new URL(request.url).pathname !== '/') return response;
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;

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
    .transform(response);

  const headers = new Headers(transformed.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  });
}
