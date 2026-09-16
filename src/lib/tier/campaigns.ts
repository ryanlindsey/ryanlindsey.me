// Campaign configuration (00 §5). Runtime data in KV, never code.
//
// This module is the shape of the boundary 09 §2 draws: the public codebase
// carries the CAPABILITY -- audience-scoped configuration that can steer a
// preload, a hero line and a document key -- and no instance of it. Every
// campaign entry is authored in the private planning repo and deployed with
// `wrangler kv key put` from there (10 §2.3). Nothing in this repo, this
// module's tests included, contains a real entry.
//
// `KV_CONFIG` is empty today (measured 2026-09-08), so this module's readers
// must all behave correctly against nothing at all -- which they do: every
// one of them answers `null` or `[]`.

export type CampaignStatus = 'staged' | 'active' | 'retired';

export interface CampaignConfig {
  id: string;
  company: string;
  status: CampaignStatus;
  /** The target description a fit run is preloaded with. Opaque text here. */
  jdText: string;
  referrerDomains: string[];
  heroLine: string;
  /** The audience label the campaign's tokens carry (`Grant.audience`). */
  tokenAudience: string;
  /** The `R2_PRIVATE` key of this campaign's narrative document. */
  gatedNarrativeDoc: string;
}

export interface CampaignEnv {
  KV_CONFIG: KVNamespace;
}

/** Every campaign key is `campaign:<id>`; nothing else under this prefix. */
export const CAMPAIGN_PREFIX = 'campaign:';

const STATUSES: readonly string[] = ['staged', 'active', 'retired'];

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * One stored entry, or `null`.
 *
 * FAILS CLOSED on every uncertainty, and the status check is the one that
 * matters most. A status this build does not recognise must not be read as
 * `staged` (harmless-looking, but it would let a `retired` typo keep serving)
 * nor as `active` (which would render campaign content for a value nobody
 * meant). Refusing the whole entry means the campaign does not exist, and a
 * campaign that does not exist changes no surface -- which is the safe answer
 * in both directions.
 *
 * `status` SELECTS AGAIN, as of #232 (2026-09-16). `activeCampaign()` was its
 * original reader and was deleted when the preload moved to the grant, which
 * left the field a label for the operator with no code behind it -- true from
 * whenever that deletion landed until this paragraph was corrected. 04 §3,
 * 00 §5 and 09 §3 were corrected on 2026-09-16 to say the referrer-adaptive
 * hero gates on it instead, and #232 is the change that makes that true. That
 * reader moved one step away from the request in #233: `buildHeroIndex`
 * (./hero-index) keeps only `status === 'active'` entries when it derives the
 * key the hero band reads, rather than `withCampaignHero` in
 * src/lib/tier/hero-band.ts filtering `listCampaigns`'s result at request
 * time. `status` still has
 * exactly one reader; it is now the derivation. What the paragraph immediately
 * above now describes for real is its `active` half -- "which would render
 * campaign content for a value nobody meant" -- because that equality check is
 * exactly the code a bad `active` would misfire against, if FAILS CLOSED were
 * not already refusing anything outside the three-value set first. Its
 * `retired`-typo half does NOT move with this change: `readCampaignForAudience`,
 * which resolves the preload and the gated narrative document, matches on
 * `token_audience` alone and reads `status` nowhere, so a `retired` campaign
 * keeps being served there exactly as it did before #232 -- that harm still
 * lives only on the surfaces that read nothing of this field.
 *
 * The strict parse is kept even so: an entry is typed by hand into KV, a typo
 * in the label is the likeliest mistake in the file, and rejecting the entry
 * makes it visible rather than letting the campaign run with a status nobody
 * can read. What it costs is that such a typo now takes out the preload and
 * the narrative document too, which is the trade being made deliberately
 * rather than inherited.
 *
 * The stored keys are snake_case, matching 00 §5's own notation, because an
 * operator authors these by hand in the private repo and the doc is what they
 * will copy from.
 */
export function parseCampaign(raw: unknown): CampaignConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;

  const id = str(value.id);
  const company = str(value.company);
  const status = str(value.status);
  const tokenAudience = str(value.token_audience);
  if (!id || !company || !status || !tokenAudience) return null;
  if (!STATUSES.includes(status)) return null;

  const referrerDomains = Array.isArray(value.referrer_domains)
    ? value.referrer_domains.filter((domain): domain is string => typeof domain === 'string')
    : [];

  return {
    id,
    company,
    status: status as CampaignStatus,
    jdText: str(value.jd_text) ?? '',
    referrerDomains,
    heroLine: str(value.hero_line) ?? '',
    tokenAudience,
    gatedNarrativeDoc: str(value.gated_narrative_doc) ?? '',
  };
}

/**
 * `walkCampaigns`'s result: every entry seen (`found`) plus, when a `match`
 * predicate was given, the entry that satisfied it (`matched`) -- captured at
 * the moment of the match, not re-derived by the caller. A caller that only
 * wants the match uses `matched` directly instead of re-applying its own
 * predicate to `found`, which would restate the same test twice and would
 * silently stop meaning "the match" if the two spellings ever drifted apart.
 */
interface CampaignWalk {
  found: CampaignConfig[];
  matched: CampaignConfig | null;
}

/**
 * Walks `campaign:*` entries in KV list order: pages through every `list`
 * call (KV caps one call at 1,000 keys and reports `list_complete` plus a
 * `cursor` for the rest -- looping on the cursor is what makes this correct
 * past 1,000 campaigns), then gets and parses each key, warning and skipping
 * any entry that fails to parse so one malformed entry does not take down
 * every other campaign.
 *
 * `match`, when given, ends the walk as soon as a parsed entry satisfies it
 * -- entries after the match are neither fetched nor parsed, so nothing is
 * warned about them -- and returns that entry as `matched`. `listCampaigns`
 * omits `match` and always sees every entry, including every warning;
 * `readCampaignForAudience` passes one and accepts that trade (see its own
 * comment for why).
 */
async function walkCampaigns(
  env: CampaignEnv,
  match?: (campaign: CampaignConfig) => boolean,
): Promise<CampaignWalk> {
  const found: CampaignConfig[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.KV_CONFIG.list({ prefix: CAMPAIGN_PREFIX, cursor });
    for (const key of page.keys) {
      let parsed: CampaignConfig | null = null;
      try {
        // get(…, 'json') throws SyntaxError on invalid JSON. Campaign entries
        // are hand-typed by an operator running `wrangler kv key put`, so a
        // single JSON typo takes down the entire listing. Treat it like a failed
        // parse: warn and skip this entry, letting other campaigns through.
        parsed = parseCampaign(await env.KV_CONFIG.get(key.name, 'json'));
      } catch (error) {
        console.warn(`campaigns: ${key.name} did not parse; ignoring it`);
        continue;
      }
      if (parsed === null) {
        console.warn(`campaigns: ${key.name} did not parse; ignoring it`);
        continue;
      }
      found.push(parsed);
      if (match?.(parsed)) return { found, matched: parsed };
    }
    if (page.list_complete) return { found, matched: null };
    cursor = page.cursor;
  }
}

/**
 * Every parseable campaign. Unparseable entries are DROPPED rather than
 * failing the listing: one malformed entry must not make every other campaign
 * disappear, and the dropped one is logged where an operator will see it.
 */
export async function listCampaigns(env: CampaignEnv): Promise<CampaignConfig[]> {
  return (await walkCampaigns(env)).found;
}

/**
 * The campaign a grant belongs to, matched on `token_audience`.
 *
 * Not on `id`: 00 §5 lists them as separate fields and they are allowed to
 * differ, so matching on the id would silently resolve the wrong narrative
 * document for any campaign whose audience label was ever renamed.
 *
 * This has TWO runtime callers, counted 2026-09-16: the
 * `get_application_narrative` tool (workers/mcp/src/gated.ts) and
 * `POST /grant` (workers/mcp/src/grant-context.ts). Either way it walks with
 * an early-exit `match`: entries after the one wanted are never fetched or
 * parsed, only earlier ones (plus the match itself) pay the get+parse cost.
 * At least one KV `list` call -- the walk's first page -- still happens on
 * every call regardless of where the match falls, and that residual is left
 * alone here. An audience->id index would require the private authoring repo
 * to write a second key per campaign, a change this repo cannot make or
 * verify. DECIDED 2026-09-16 (#233): it stays unbuilt. Both callers
 * are grant-gated and run at single-figure volume, so the residual `list`
 * costs little on a path few callers ever reach. `/grant` is the busier of the
 * two -- the site asks it on every token-bearing `/fit` load and every `/fit`
 * run (src/lib/fit/client.ts), plus once per `npm run token mint`
 * (scripts/token.mjs) -- but reaching it at all takes a token minted by hand
 * for one audience, which is what keeps it the same order of volume. This
 * sentence named only the tool until the count above was made, and the
 * conclusion survived the correction: the sharper argument below does not rest
 * on volume at all. The decision can be reopened if day 6's `/ops` read
 * patterns ever show volume that changes this trade; nothing has shown that
 * yet.
 *
 * CORRECTED 2026-09-16 (#225): this paragraph used to offer a `cacheTtl` as
 * the cheaper alternative to that index, "trading configuration-propagation
 * latency for a saving nobody has measured a need for". That trade is not on
 * offer for the call being described. `list()` takes `prefix`, `limit` and
 * `cursor` and nothing else; `cacheTtl` is a parameter of `get()` and
 * `getWithMetadata()` (checked against Cloudflare's KV binding
 * documentation). A `list` cannot be cached that way at all, which is why the
 * index is the only real option and why #233, which takes the same residual
 * off the home page's hot path, had to build one rather than switch anything
 * on. The index wanted HERE and the one #233 built are not the same object:
 * this call needs audience->id, a key per campaign; the hero needs
 * referrer-domain->hero-line, one key for all of them. #233 answered the
 * question of whether one structure could serve both with a no, and built only
 * the hero's (./hero-index, written to `hero:index` in `KV_CACHE`) -- which it
 * could, because that one is DERIVED from these entries by a cron on the site
 * Worker and so needs nothing from the private authoring repo. The
 * audience->id index still would, and is still unbuilt.
 *
 * That private-repo dependency is not even the sharper reason. Built or not,
 * this call still needs `jd_text` and `gated_narrative_doc` from the full
 * campaign entry afterward, so an audience->id index would save it a `list`
 * and not a round trip -- a materially worse trade than the hero's, whose
 * index carries the entire payload the caller needs and removes the fetch
 * outright. `withCampaignHero` in src/lib/tier/hero-band.ts repeated the
 * `cacheTtl` assumption from here and was corrected in the same change.
 *
 * Early exit also means an unparseable entry AFTER the match never runs
 * through `parseCampaign` and so never logs `walkCampaigns`'s
 * `console.warn`. Decided acceptable: this call wants one campaign, not a
 * census of every entry's health -- `listCampaigns`, which IS a census,
 * always walks everything and sees every warning.
 */
export async function readCampaignForAudience(
  env: CampaignEnv,
  audience: string,
): Promise<CampaignConfig | null> {
  return (await walkCampaigns(env, (c) => c.tokenAudience === audience)).matched;
}
