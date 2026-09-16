// The derived referrer index (#233). `KV_CONFIG` holds the authored
// `campaign:<id>` entries -- `./campaigns` -- and this Worker's cron derives
// one aggregate key from them into `KV_CACHE`. The binding names the writer:
// `KV_CONFIG` is written only from the private planning repo (10 §2.3), while
// every `KV_CACHE` key is written by code in this repository -- `hero:index`
// by the site Worker's cron and by nothing else. Not by that Worker alone,
// though: the namespace is bound to the MCP Worker too, which writes
// `corpus:manifest` into it (src/lib/corpus.ts), so what a reader learns from
// which binding a key lives in is authored configuration versus derived
// cache, not which Worker did the writing.
//
// WHY THIS EXISTS. `withCampaignHero` in src/worker.ts used to pay a KV
// `list` on every home page arrival carrying a cross-origin `Referer` --
// which is what a search result and a social link both produce, not a rare
// case -- because `listCampaigns` always issues at least one `list` and
// Workers KV's `list()` takes only `prefix`, `limit` and `cursor`. `cacheTtl`
// is a parameter of `get()` and `getWithMetadata()` only (checked against
// Cloudflare's KV binding documentation, 2026-09-16), so there was no knob
// that made that read local. One aggregate key, read with one cacheable
// `get()`, is the mechanism that does exist: `refreshHeroIndex` below writes
// it, `readHeroIndex` reads it, and neither one calls `list`.
//
// WHAT THIS COSTS. Staleness bounded by the cron interval plus `cacheTtl`
// (see `readHeroIndex`), and a dependency on `scheduled()` actually firing on
// the deployed site Worker. src/worker.ts's own `scheduled()` docblock still
// records that as NOT YET PROVEN -- Astro's adapter owns that entry, and a
// handler that compiles is not a handler the platform invokes. Every other
// job behind that docblock's unproven assumption is a background sweep that
// fails quietly if the cron never runs. This one is not: if `scheduled()`
// never fires, `refreshHeroIndex` never writes, `readHeroIndex` sees a
// missing key forever, and the campaign hero band never renders for anyone --
// a visitor-facing surface now resting on the same unproven assumption a
// retention sweep already carried.
//
// A DEAD CRON FAILS THE OTHER WAY TOO, and that direction is the one worth
// stating because it is not safe. `refreshHeroIndex`'s `put` sets no
// `expirationTtl` (deliberately: the index has no correct lifetime of its
// own, only a correct CONTENT, and a key that expired between cron runs would
// blank the band on a schedule). So a `scheduled()` that stops AFTER having
// written the key once leaves the last index in place indefinitely, and a
// campaign flipped to `retired` keeps rendering its hero line forever -- the
// pre-#232 bug returning through a dead cron rather than through a missing
// gate. Every staleness figure in this module and in `revoke` in
// scripts/token.mjs is bounded by the cron interval plus `cacheTtl` only
// while the cron is running; nothing bounds it if the cron stops.

import { listCampaigns, type CampaignConfig, type CampaignEnv } from './campaigns';

/** The one key this module writes and reads. Lives in `KV_CACHE`, not `KV_CONFIG`. */
export const HERO_INDEX_KEY = 'hero:index';

/**
 * Passed to `get()` as `cacheTtl`. Workers KV's floor for this parameter is
 * 30 seconds; 300 is chosen so that, alongside the cron's five-minute
 * interval, worst-case staleness from a campaign deploy to the band
 * reflecting it is about ten minutes (five for the next cron run plus five
 * for the stalest cached read).
 *
 * THE FLOOR SAID 60 UNTIL 2026-09-16, which had read the default as the
 * minimum. Cloudflare's /kv/api/read-key-value-pairs/ says "The `cacheTtl`
 * parameter must be an integer greater than or equal to `30`. `60` is the
 * default." -- two separate numbers, and a changelog entry dated 2026-01-30
 * records the minimum being reduced from 60 to 30 for both `get()` and
 * `getWithMetadata()`. Nothing behaves differently, since 300 is valid under
 * either floor, but the error is the same class this branch spent #225
 * correcting elsewhere in it: a comment asserting more than the reference it
 * names supports, which misleads whoever later tunes this interval down.
 */
export const HERO_INDEX_CACHE_TTL_SECONDS = 300;

/** One referrer domain's hero line, as stored in the index. */
export interface HeroIndexEntry {
  domain: string;
  heroLine: string;
}

export interface HeroIndexEnv extends CampaignEnv {
  KV_CACHE: KVNamespace;
}

/**
 * The pure derivation: every `active` campaign's referrer domains, each
 * paired with that campaign's `heroLine`, in the order `campaigns` and then
 * `referrerDomains` were given.
 *
 * AN ARRAY RATHER THAN AN OBJECT KEYED BY DOMAIN, and that choice is worth a
 * comment because it is easy to reach for the object instead. Order is
 * load-bearing here: this is a faithful projection of what the old
 * `campaignForReferrer` plus `withCampaignHero`'s `heroLine === ''` bail did
 * together, which was first-match-wins over `listCampaigns`'s (i.e. KV list)
 * order. An object's key order is a JSON-and-engine detail, not a contract to
 * rest that behavior on; an array keeps first-match-wins an explicit property
 * of whatever reads this list rather than an accident of how the object was
 * built.
 *
 * EMPTY `heroLine` ENTRIES ARE KEPT, deliberately. The old code matched the
 * first active campaign claiming a domain and then rendered nothing because
 * THAT campaign's line was empty -- it did not fall through to try a later
 * campaign claiming the same domain. Dropping empty-line entries here would
 * quietly change that to first-match-WITH-A-LINE wins, which is a different
 * bug from the one the old code had. Two campaigns claiming one domain is an
 * authoring mistake either way; the point of this function is that deriving
 * the index does not decide which mistake it is.
 */
export function buildHeroIndex(campaigns: readonly CampaignConfig[]): HeroIndexEntry[] {
  const index: HeroIndexEntry[] = [];
  for (const campaign of campaigns) {
    if (campaign.status !== 'active') continue;
    for (const domain of campaign.referrerDomains) {
      index.push({ domain, heroLine: campaign.heroLine });
    }
  }
  return index;
}

/**
 * The cron's write, registered since #233 on the site Worker's five-minute
 * trigger (`triggers.crons` in wrangler.jsonc, dispatched by `scheduled()` in
 * src/worker.ts). Derives the index from every authored campaign and writes it
 * whole to `HERO_INDEX_KEY`, returning the index so the caller can log how
 * many domains it wrote.
 *
 * WRITING `[]` IS THE POINT, not an edge case to special-case away. With
 * `KV_CONFIG` empty (measured 2026-09-08) `buildHeroIndex` returns `[]`, and
 * writing that empty array is what turns the no-campaigns case into a cached
 * `get()` returning `[]` instead of a `list()` discovering there is nothing
 * to render -- the same saving this whole module exists for, on the one case
 * that would otherwise be tempting to skip.
 */
export async function refreshHeroIndex(env: HeroIndexEnv): Promise<HeroIndexEntry[]> {
  const index = buildHeroIndex(await listCampaigns(env));
  await env.KV_CACHE.put(HERO_INDEX_KEY, JSON.stringify(index));
  return index;
}

function isHeroIndexEntry(value: unknown): value is HeroIndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.domain === 'string' && typeof entry.heroLine === 'string';
}

/**
 * The hot path's read: one `get()`, cached at the edge for
 * `HERO_INDEX_CACHE_TTL_SECONDS` (300 seconds; KV's floor for this parameter
 * is 30, checked 2026-09-16 -- see that constant). Combined with the cron's
 * five-minute interval, worst-case staleness from a campaign deploy to this
 * read reflecting it is about ten minutes, and only while the cron is
 * running: see this module's header for what an index that stops being
 * refreshed does instead.
 *
 * VALIDATED BEFORE TRUSTED, the same way every reader in `./campaigns` fails
 * closed on an uncertain shape: a value that is not an array becomes `[]`,
 * and any element missing a `string` `domain` or a `string` `heroLine` is
 * dropped rather than passed through malformed.
 *
 * THE `try` IS PART OF THAT AND WAS MISSING UNTIL 2026-09-16, which made the
 * paragraph above false for the one shape it did not cover. `get(...,
 * { type: 'json' })` throws `SyntaxError` on a value that is not valid JSON,
 * and nothing above this call catches -- not `withCampaignHero`, not `fetch`
 * in src/worker.ts -- so the throw escaped the Worker and answered the home
 * page with an exception on exactly the arrivals this module exists to serve.
 * `walkCampaigns` in `./campaigns` already guards the same hazard on the
 * campaign entries and names it in a comment, so the claim of parity here was
 * written before the code that earns it. Nothing in this repository can write
 * a malformed value -- `refreshHeroIndex` writes `JSON.stringify` and is the
 * only writer -- which leaves a hand-run `wrangler kv key put` as the only way
 * to reach it, and that is the scenario failing closed exists for rather than
 * a reason to skip the guard.
 *
 * IT WARNS, following `walkCampaigns`'s precedent, because every other cause
 * of an empty index is indistinguishable from outside: a key never written, a
 * cron that never fired and a malformed value all render no band. The log line
 * is the only thing that tells the third from the first two. It costs one
 * warning per matching arrival for as long as the bad value sits there, which
 * is accepted for the same reason the guard is cheap: nothing but a hand-run
 * write puts it there in the first place.
 *
 * A MISSING KEY RETURNS `[]` RATHER THAN FALLING BACK TO `listCampaigns`.
 * Falling back would reintroduce exactly the `list` cost this module exists
 * to remove, and it would land on exactly the requests that pay it today --
 * every home page arrival with a cross-origin `Referer`, while the index
 * happens to be missing. The failure mode of a missing index is that the
 * campaign band does not render, which is the same safe direction the rest
 * of this feature already fails in: an authoring mistake or an unlucky
 * deploy loses a hero line, never a broken page.
 */
export async function readHeroIndex(
  env: Pick<HeroIndexEnv, 'KV_CACHE'>,
): Promise<HeroIndexEntry[]> {
  let value: unknown;
  try {
    value = await env.KV_CACHE.get(HERO_INDEX_KEY, {
      type: 'json',
      cacheTtl: HERO_INDEX_CACHE_TTL_SECONDS,
    });
  } catch {
    console.warn(`hero-index: ${HERO_INDEX_KEY} did not parse; rendering no band`);
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(isHeroIndexEntry);
}
