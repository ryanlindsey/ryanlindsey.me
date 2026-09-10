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
 * Walks `campaign:*` entries in KV list order: pages through every `list`
 * call (KV caps one call at 1,000 keys and reports `list_complete` plus a
 * `cursor` for the rest -- looping on the cursor is what makes this correct
 * past 1,000 campaigns), then gets and parses each key, warning and skipping
 * any entry that fails to parse so one malformed entry does not take down
 * every other campaign.
 *
 * `match`, when given, ends the walk as soon as a parsed entry satisfies it
 * -- entries after the match are neither fetched nor parsed, so nothing is
 * warned about them. `listCampaigns` omits `match` and always sees every
 * entry, including every warning; `readCampaignForAudience` passes one and
 * accepts that trade (see its own comment for why).
 */
async function walkCampaigns(
  env: CampaignEnv,
  match?: (campaign: CampaignConfig) => boolean,
): Promise<CampaignConfig[]> {
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
      if (match?.(parsed)) return found;
    }
    if (page.list_complete) return found;
    cursor = page.cursor;
  }
}

/**
 * Every parseable campaign. Unparseable entries are DROPPED rather than
 * failing the listing: one malformed entry must not make every other campaign
 * disappear, and the dropped one is logged where an operator will see it.
 */
export async function listCampaigns(env: CampaignEnv): Promise<CampaignConfig[]> {
  return walkCampaigns(env);
}

/**
 * The one `active` campaign, or `null`.
 *
 * 00 §5 permits any number of `staged` campaigns simultaneously and makes
 * only ACTIVATION sequential, so "the active one" is well defined. Two active
 * entries would be an authoring mistake; the first is returned and the
 * collision is logged rather than thrown, because a preload picking the wrong
 * one is a smaller failure than a page that will not render.
 */
export async function activeCampaign(env: CampaignEnv): Promise<CampaignConfig | null> {
  const active = (await listCampaigns(env)).filter((campaign) => campaign.status === 'active');
  if (active.length > 1) {
    console.warn(`campaigns: ${active.length} entries are active; using ${active[0].id}`);
  }
  return active[0] ?? null;
}

/**
 * The campaign a grant belongs to, matched on `token_audience`.
 *
 * Not on `id`: 00 §5 lists them as separate fields and they are allowed to
 * differ, so matching on the id would silently resolve the wrong narrative
 * document for any campaign whose audience label was ever renamed.
 *
 * This runs on every `get_application_narrative` call, so it walks with an
 * early-exit `match`: entries after the one wanted are never fetched or
 * parsed, only earlier ones (plus the match itself) pay the get+parse cost.
 * At least one KV `list` call -- the walk's first page -- still happens on
 * every call regardless of where the match falls, and that residual is left
 * alone here: a `cacheTtl` trades configuration-propagation latency for a
 * saving nobody has measured a need for, and an audience->id index would
 * require the private authoring repo to write a second key per campaign, a
 * change this repo cannot make or verify. Whether to cache the `list` call
 * is left to day 6's `/ops` read patterns, which will know the actual call
 * volume this needs to justify.
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
  const walked = await walkCampaigns(env, (c) => c.tokenAudience === audience);
  return walked.find((c) => c.tokenAudience === audience) ?? null;
}
