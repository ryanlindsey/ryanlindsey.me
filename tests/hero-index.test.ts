import { expect, test } from 'vitest';
import {
  buildHeroIndex,
  HERO_INDEX_CACHE_TTL_SECONDS,
  HERO_INDEX_KEY,
  readHeroIndex,
  refreshHeroIndex,
  type HeroIndexEnv,
} from '../src/lib/tier/hero-index';
import { CAMPAIGN_PREFIX, type CampaignConfig } from '../src/lib/tier/campaigns';

/**
 * A CampaignConfig with no candidacy semantics whatsoever -- generic strings
 * standing in for a shape, matching tests/campaigns.test.ts's fixture rule.
 * The real entries are runtime data authored in the private repo and never
 * appear in this repo, this test included.
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

/** The reverse of `parseCampaign`, matching tests/campaigns.test.ts's helper. */
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

/**
 * A KV stand-in over an in-memory `Map`, following the fake-KV pattern in
 * tests/chat-engine.test.ts. `get` records the options it was called with so
 * a test can assert on `cacheTtl` -- the entire point of `readHeroIndex` --
 * without pinning anything about how the fake itself behaves.
 */
function fakeKvCache(entries: Record<string, unknown> = {}): {
  KV_CACHE: KVNamespace;
  getCalls: Array<{ key: string; options?: unknown }>;
} {
  const store = new Map<string, string>(
    Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  const getCalls: Array<{ key: string; options?: unknown }> = [];
  return {
    KV_CACHE: {
      get: async (key: string, options?: unknown) => {
        getCalls.push({ key, options });
        const raw = store.get(key);
        if (raw === undefined) return null;
        return JSON.parse(raw);
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    } as unknown as KVNamespace,
    getCalls,
  };
}

/** A campaign fixture as a stored `campaign:<id>` entry, for a KV_CONFIG fake. */
function campaignEntries(campaigns: CampaignConfig[]): Record<string, unknown> {
  return Object.fromEntries(campaigns.map((c) => [`${CAMPAIGN_PREFIX}${c.id}`, toStored(c)]));
}

/** A KV_CONFIG stand-in, matching tests/campaigns.test.ts's `kv()` helper. */
function fakeKvConfig(entries: Record<string, unknown>): { KV_CONFIG: KVNamespace } {
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

// --- buildHeroIndex ---------------------------------------------------------

test('buildHeroIndex: an active campaign contributes one entry per referrer domain, in order', () => {
  const campaign = fixture({
    status: 'active',
    referrerDomains: ['a.example', 'b.example'],
    heroLine: 'Hello from fixture.',
  });
  expect(buildHeroIndex([campaign])).toEqual([
    { domain: 'a.example', heroLine: 'Hello from fixture.' },
    { domain: 'b.example', heroLine: 'Hello from fixture.' },
  ]);
});

test('buildHeroIndex: a retired campaign contributes nothing', () => {
  const campaign = fixture({ status: 'retired', referrerDomains: ['a.example'] });
  expect(buildHeroIndex([campaign])).toEqual([]);
});

test('buildHeroIndex: a staged campaign contributes nothing', () => {
  const campaign = fixture({ status: 'staged', referrerDomains: ['a.example'] });
  expect(buildHeroIndex([campaign])).toEqual([]);
});

test('buildHeroIndex: the ordering trap -- a retired campaign listed before an active one, both claiming the same domain, yields only the active line', () => {
  // `campaignForReferrer` was first-match-wins over KV list order. A naive
  // rewrite that filtered by status AFTER building an object keyed by domain
  // could let a later active entry silently overwrite an earlier retired
  // one, which happens to look right here but is right for the wrong reason
  // -- filter-then-walk, not overwrite-by-key, is what buildHeroIndex does,
  // and the array shape is what makes overwrite-by-key impossible to reach
  // for by accident.
  const retired = fixture({
    id: 'retired-one',
    status: 'retired',
    referrerDomains: ['shared.example'],
    heroLine: 'Should not appear.',
  });
  const active = fixture({
    id: 'active-one',
    status: 'active',
    referrerDomains: ['shared.example'],
    heroLine: 'Should appear.',
  });
  expect(buildHeroIndex([retired, active])).toEqual([
    { domain: 'shared.example', heroLine: 'Should appear.' },
  ]);
});

test('buildHeroIndex: an active campaign with heroLine "" still contributes its entry', () => {
  // Faithful projection of the old campaignForReferrer + heroLine === '' bail:
  // the old code matched the first active campaign claiming the domain and
  // rendered nothing because ITS line was empty, rather than falling through
  // to a later campaign claiming the same domain. Dropping empty lines here
  // would quietly change that to first-match-with-a-line-wins, which is a
  // different bug from the one the old code had -- two campaigns claiming
  // one domain is an authoring mistake either way, and the point is that
  // this change does not decide which mistake it is.
  const campaign = fixture({ status: 'active', referrerDomains: ['a.example'], heroLine: '' });
  expect(buildHeroIndex([campaign])).toEqual([{ domain: 'a.example', heroLine: '' }]);
});

test('buildHeroIndex: no campaigns at all yields []', () => {
  expect(buildHeroIndex([])).toEqual([]);
});

// --- refreshHeroIndex --------------------------------------------------------

test('refreshHeroIndex writes JSON to HERO_INDEX_KEY that round-trips the built index', async () => {
  const campaign = fixture({
    status: 'active',
    referrerDomains: ['a.example'],
    heroLine: 'Hello.',
  });
  const cache = fakeKvCache();
  const env: HeroIndexEnv = {
    ...fakeKvConfig(campaignEntries([campaign])),
    KV_CACHE: cache.KV_CACHE,
  };

  const returned = await refreshHeroIndex(env);
  expect(returned).toEqual([{ domain: 'a.example', heroLine: 'Hello.' }]);

  const stored = await cache.KV_CACHE.get(HERO_INDEX_KEY);
  expect(stored).toEqual([{ domain: 'a.example', heroLine: 'Hello.' }]);
});

test('refreshHeroIndex writes [] rather than writing nothing when there are no campaigns', async () => {
  const cache = fakeKvCache();
  const env: HeroIndexEnv = { ...fakeKvConfig({}), KV_CACHE: cache.KV_CACHE };

  const returned = await refreshHeroIndex(env);
  expect(returned).toEqual([]);

  // Assert the key EXISTS and holds [], not merely that a read of it returns
  // [] -- a missing key and a key holding [] both read back as [] once
  // readHeroIndex's own defaulting is in the loop, so this checks the write
  // directly against the fake's store instead of round-tripping through it.
  const calls = cache.getCalls;
  const stored = await cache.KV_CACHE.get(HERO_INDEX_KEY);
  expect(stored).toEqual([]);
  expect(calls.length).toBeGreaterThan(0); // the get() above happened
});

// --- readHeroIndex ------------------------------------------------------------

test('readHeroIndex: a missing key returns []', async () => {
  const cache = fakeKvCache();
  expect(await readHeroIndex(cache)).toEqual([]);
});

test('readHeroIndex: a value that is not an array returns []', async () => {
  const cache = fakeKvCache({ [HERO_INDEX_KEY]: { not: 'an array' } });
  expect(await readHeroIndex(cache)).toEqual([]);
});

test('readHeroIndex: an array with one good entry and one malformed element returns only the good entry', async () => {
  const cache = fakeKvCache({
    [HERO_INDEX_KEY]: [
      { domain: 'a.example', heroLine: 'Good.' },
      { domain: 'b.example' }, // missing heroLine
      { heroLine: 'No domain.' }, // missing domain
      { domain: 1, heroLine: 'Wrong type.' },
      null,
      'a string',
      42,
    ],
  });
  expect(await readHeroIndex(cache)).toEqual([{ domain: 'a.example', heroLine: 'Good.' }]);
});

test('readHeroIndex passes cacheTtl: HERO_INDEX_CACHE_TTL_SECONDS to get', async () => {
  const cache = fakeKvCache({ [HERO_INDEX_KEY]: [] });
  await readHeroIndex(cache);
  expect(cache.getCalls).toEqual([
    { key: HERO_INDEX_KEY, options: { type: 'json', cacheTtl: HERO_INDEX_CACHE_TTL_SECONDS } },
  ]);
});
