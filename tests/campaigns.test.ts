import { expect, test } from 'vitest';
import {
  CAMPAIGN_PREFIX,
  listCampaigns,
  parseCampaign,
  readCampaignForAudience,
  type CampaignConfig,
} from '../src/lib/tier/campaigns';

/**
 * A CampaignConfig with no candidacy semantics whatsoever -- generic strings
 * standing in for a shape, per the plan's generic-engine rule. The real
 * entries are runtime data authored in the private repo (09 §3 item 1) and
 * never appear in this repo, this test included.
 */
const fixture = (over: Partial<CampaignConfig> = {}): CampaignConfig => ({
  id: 'fixture-one',
  company: 'Fixture Company',
  status: 'staged',
  jdText: 'A description of a role, supplied at runtime.',
  referrerDomains: ['fixture.example'],
  heroLine: 'A generic line.',
  tokenAudience: 'fixture-one',
  gatedNarrativeDoc: 'narrative/fixture-one.md',
  ...over,
});

/** A KV stand-in: `list` + `get`, which is all this module uses. */
function kv(entries: Record<string, unknown>): { KV_CONFIG: KVNamespace } {
  // Store entries as JSON strings to match real KV behaviour: get(…, 'json')
  // parses the stored string and throws on invalid JSON.
  const stored = Object.entries(entries).reduce(
    (acc, [key, value]) => {
      acc[key] = typeof value === 'string' ? value : JSON.stringify(value);
      return acc;
    },
    {} as Record<string, string>,
  );

  return {
    KV_CONFIG: {
      list: async ({ prefix }: { prefix: string }) => ({
        keys: Object.keys(stored)
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      }),
      get: async (name: string, type?: string) => {
        if (stored[name] === undefined) return null;
        if (type === 'json') return JSON.parse(stored[name]);
        return stored[name];
      },
    } as unknown as KVNamespace,
  };
}

test('a complete entry parses, snake_case keys included', () => {
  // The stored shape is 00 §5's, verbatim and snake_cased, because that is
  // what the doc specifies and what an operator will type by hand.
  const parsed = parseCampaign({
    id: 'fixture-one',
    company: 'Fixture Company',
    status: 'staged',
    jd_text: 'A description of a role, supplied at runtime.',
    referrer_domains: ['fixture.example'],
    hero_line: 'A generic line.',
    token_audience: 'fixture-one',
    gated_narrative_doc: 'narrative/fixture-one.md',
  });
  expect(parsed).toEqual(fixture());
});

test('an unknown status is refused rather than defaulted', () => {
  // Fails CLOSED, and this is the single most consequential line in the file:
  // a status this build does not understand must never be treated as
  // `staged`-and-therefore-harmless OR as `active`-and-therefore-rendered.
  // Refusing means the campaign does not exist, which is the safe reading in
  // both directions.
  //
  // IMPORTANT: This test must start from the stored shape (snake_case) or it
  // proves nothing. Without toStored(), fixture() returns camelCase which
  // makes the test fail for missing token_audience instead of bad status.
  expect(parseCampaign({ ...toStored(fixture()), status: 'live' })).toBeNull();
});

test('a missing required field is refused', () => {
  for (const field of ['id', 'company', 'status', 'token_audience']) {
    const raw: Record<string, unknown> = {
      id: 'x',
      company: 'y',
      status: 'staged',
      jd_text: '',
      referrer_domains: [],
      hero_line: '',
      token_audience: 'x',
      gated_narrative_doc: '',
    };
    delete raw[field];
    expect(parseCampaign(raw), `${field} is required`).toBeNull();
  }
});

test('garbage is refused, never thrown on', () => {
  for (const bad of [null, undefined, 0, '', 'string', [], { status: 'staged' }]) {
    expect(parseCampaign(bad)).toBeNull();
  }
});

test('listCampaigns reads only the campaign prefix and drops unparseable entries', async () => {
  const env = kv({
    [`${CAMPAIGN_PREFIX}one`]: { ...toStored(fixture({ id: 'one', tokenAudience: 'one' })) },
    [`${CAMPAIGN_PREFIX}bad`]: { nonsense: true },
    'breaker:inference': { on: true },
  });
  const found = await listCampaigns(env);
  expect(found.map((c) => c.id)).toEqual(['one']);
});

test('listCampaigns is a census: every status comes back, not just `active`', async () => {
  // #232 put the `active`-only filter at a caller rather than inside
  // listCampaigns itself -- at `withCampaignHero`'s call site, which was in
  // src/worker.ts at the time and has since moved to
  // src/lib/tier/hero-band.ts (#234) -- and since #233 in `buildHeroIndex`,
  // which filters what
  // `refreshHeroIndex` hands it. Deliberately not pushed down, because
  // queueResumePdfIntent calls listCampaigns too and has to keep seeing every
  // campaign regardless of status (`09 §3` R6: the permanent rehearsal
  // fixture's `referrer_domains` are matched on every request carrying a
  // `Referer` for as long as the entry exists in KV, at any status). This test
  // exists to pin that by intent rather than by accident:
  // every other test in this file happens to use `staged` fixtures, so a
  // filter pushed down into listCampaigns would fail them too, but only
  // incidentally -- none of them says the census property is the point. This
  // one does, and covers all three statuses so no single value could pass it
  // by chance either.
  const env = kv({
    [`${CAMPAIGN_PREFIX}a-staged`]: toStored(
      fixture({ id: 'a-staged', tokenAudience: 'a-staged', status: 'staged' }),
    ),
    [`${CAMPAIGN_PREFIX}b-active`]: toStored(
      fixture({ id: 'b-active', tokenAudience: 'b-active', status: 'active' }),
    ),
    [`${CAMPAIGN_PREFIX}c-retired`]: toStored(
      fixture({ id: 'c-retired', tokenAudience: 'c-retired', status: 'retired' }),
    ),
  });
  const found = await listCampaigns(env);
  expect(found.map((c) => c.id).sort()).toEqual(['a-staged', 'b-active', 'c-retired']);
});

test('readCampaignForAudience matches on token_audience, not on id', async () => {
  // They are separate fields in 00 §5 and they are allowed to differ. Matching
  // on the id would resolve the wrong narrative document for any campaign
  // whose audience label was ever renamed.
  const env = kv({
    [`${CAMPAIGN_PREFIX}one`]: toStored(fixture({ id: 'one', tokenAudience: 'audience-label' })),
  });
  expect((await readCampaignForAudience(env, 'audience-label'))!.id).toBe('one');
  expect(await readCampaignForAudience(env, 'one')).toBeNull();
});

test('listCampaigns returns [] against an empty namespace', async () => {
  expect(await listCampaigns(kv({}))).toEqual([]);
});

test('listCampaigns pages through every KV list page, not just the first', async () => {
  // Cloudflare KV caps a single `list` call at 1,000 keys and signals more
  // with `list_complete: false` plus a `cursor`. A fake that returns two
  // pages, only completing on the second, proves the loop follows the
  // cursor instead of stopping after the first `list` call.
  const one = toStored(fixture({ id: 'one', tokenAudience: 'one' }));
  const two = toStored(fixture({ id: 'two', tokenAudience: 'two' }));
  const listCalls: Array<string | undefined> = [];
  const env: { KV_CONFIG: KVNamespace } = {
    KV_CONFIG: {
      list: async ({ cursor }: { cursor?: string }) => {
        listCalls.push(cursor);
        if (cursor === undefined) {
          return {
            keys: [{ name: `${CAMPAIGN_PREFIX}one` }],
            list_complete: false,
            cursor: 'page-two',
          };
        }
        return { keys: [{ name: `${CAMPAIGN_PREFIX}two` }], list_complete: true };
      },
      get: async (name: string) => (name === `${CAMPAIGN_PREFIX}one` ? one : two),
    } as unknown as KVNamespace,
  };

  const found = await listCampaigns(env);
  expect(found.map((c) => c.id)).toEqual(['one', 'two']);
  expect(listCalls).toEqual([undefined, 'page-two']);
});

test('readCampaignForAudience stops at the first match: it does not get entries after it', async () => {
  const entries = ['one', 'two', 'three'].map((id) => toStored(fixture({ id, tokenAudience: id })));
  let getCalls = 0;
  const env: { KV_CONFIG: KVNamespace } = {
    KV_CONFIG: {
      list: async () => ({
        keys: entries.map((_, i) => ({ name: `${CAMPAIGN_PREFIX}${i}` })),
        list_complete: true,
      }),
      get: async (name: string) => {
        getCalls += 1;
        return entries[Number(name.slice(CAMPAIGN_PREFIX.length))];
      },
    } as unknown as KVNamespace,
  };

  getCalls = 0;
  const first = await readCampaignForAudience(env, 'one');
  expect(first?.id).toBe('one');
  expect(getCalls).toBe(1); // the match is entry 0; entries 1 and 2 are never fetched

  getCalls = 0;
  const last = await readCampaignForAudience(env, 'three');
  expect(last?.id).toBe('three');
  expect(getCalls).toBe(3); // the match is the last entry; every earlier one had to be checked
});

test('listCampaigns drops malformed JSON, does not throw', async () => {
  // Campaign entries are hand-typed by an operator in the private repo. A
  // single JSON typo (e.g. trailing comma) throws when KV parses it. The
  // module must catch that error and skip the bad entry, letting valid ones
  // through. Without the try/catch in listCampaigns, one operator typo hides
  // every campaign.
  const validOne = toStored(fixture({ id: 'valid', tokenAudience: 'valid' }));
  const env = kv({
    [`${CAMPAIGN_PREFIX}valid`]: validOne,
    [`${CAMPAIGN_PREFIX}malformed`]: '{"id": "bad",', // Incomplete JSON
  });
  const found = await listCampaigns(env);
  expect(found.map((c) => c.id)).toEqual(['valid']);
});

/** The reverse of `parseCampaign`, for fixtures only. */
function toStored(config: CampaignConfig): Record<string, unknown> {
  return {
    id: config.id,
    company: config.company,
    status: config.status,
    jd_text: config.jdText,
    referrer_domains: config.referrerDomains,
    hero_line: config.heroLine,
    token_audience: config.tokenAudience,
    gated_narrative_doc: config.gatedNarrativeDoc,
  };
}
