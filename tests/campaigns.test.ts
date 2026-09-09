import { expect, test } from 'vitest';
import {
  activeCampaign,
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
  return {
    KV_CONFIG: {
      list: async ({ prefix }: { prefix: string }) => ({
        keys: Object.keys(entries)
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      }),
      get: async (name: string, type?: string) =>
        entries[name] === undefined
          ? null
          : type === 'json'
            ? entries[name]
            : JSON.stringify(entries[name]),
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

test('activeCampaign returns the active one, and null when none is', async () => {
  const staged = toStored(fixture({ id: 'one', tokenAudience: 'one' }));
  const active = toStored(fixture({ id: 'two', tokenAudience: 'two', status: 'active' }));
  expect(await activeCampaign(kv({ [`${CAMPAIGN_PREFIX}one`]: staged }))).toBeNull();
  const found = await activeCampaign(
    kv({ [`${CAMPAIGN_PREFIX}one`]: staged, [`${CAMPAIGN_PREFIX}two`]: active }),
  );
  expect(found!.id).toBe('two');
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
