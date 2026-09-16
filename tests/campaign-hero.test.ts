import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { HERO_INDEX_KEY, refreshHeroIndex, type HeroIndexEnv } from '../src/lib/tier/hero-index';
import { SITE_HARNESS_WORKERS } from './workers';

// The referrer-adaptive hero (04 §3, 09 §1): one band under the NOW strip,
// rendered only for a visitor arriving from an `active` campaign's own domain.
//
// TWO STEPS SINCE #233, where the suite used to have one. The band no longer
// reads the `campaign:` entries this file seeds into `KV_CONFIG`; it reads the
// `hero:index` key in `KV_CACHE` that the cron derives from them, so seeding
// and fetching are separated by `deriveIndex` below and every test that seeds
// has to run it. What each test asserts about the rendered page is unchanged,
// deliberately: these are the properties that had to survive the move.
//
// PRESENTATION, NOT AUTHORIZATION. A `Referer` is attacker-supplied text and
// trivially forged, so everything this feature reveals must be harmless to a
// stranger -- which is what 09 §1's rule that the line carries no company name
// is for. Nothing here gates on the match.

const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

beforeAll(async () => {
  await server.listen();
  const site = server.getWorker<{ KV_CONFIG: KVNamespace }>();
  const kv = (await site.getEnv()).KV_CONFIG;
  await kv.put(
    'campaign:hero-fixture',
    JSON.stringify({
      id: 'hero-fixture',
      company: 'Hero Fixture',
      status: 'active',
      jd_text: 'Not used by this suite.',
      referrer_domains: ['fixture-referrer.test'],
      hero_line: 'A generic line for a referred reader.',
      token_audience: 'hero-fixture',
      gated_narrative_doc: 'narratives/hero.md',
    }),
  );
  await deriveIndex();
});
afterAll(async () => {
  await server.close();
});

/**
 * `server.fetch` rather than a global `fetch` against the harness's own bound
 * origin, which is what this helper used before the conditional-request test
 * below needed it to carry `If-None-Match` too. `tests/negotiation.test.ts`
 * already uses `server.fetch` for exactly its conditional cases, and it is
 * the form that works for them in this harness; switching this helper to the
 * same form rather than keeping two fetch mechanisms side by side in one file
 * is what "extend the helper" means here. Every existing call site keeps
 * working unchanged, since `extraHeaders` defaults to none.
 */
function home(referer?: string, extraHeaders: Record<string, string> = {}) {
  return server.fetch('/', {
    headers: referer === undefined ? extraHeaders : { ...extraHeaders, referer },
  });
}

/**
 * Runs the derivation the deployed Worker's five-minute cron runs (#233):
 * every `active` campaign in `KV_CONFIG` becomes one `hero:index` entry in
 * `KV_CACHE`, which is the only thing the band reads.
 *
 * SEEDING IS NO LONGER ENOUGH, which is the one way this suite changed shape.
 * A `campaign:` entry written to `KV_CONFIG` reaches the home page only once
 * this has run, so every test that seeds must derive before it fetches. The
 * real `refreshHeroIndex` runs here rather than a hand-written index being
 * written to the key directly: a hand-written index would let the derivation
 * the deployed band depends on drift without a single test noticing.
 */
async function deriveIndex(): Promise<void> {
  await refreshHeroIndex(await server.getWorker<HeroIndexEnv>().getEnv());
}

test('a matching referrer renders the band under the NOW strip', async () => {
  const response = await home('https://fixture-referrer.test/some/page');
  const html = await response.text();
  expect(html).toContain('data-campaign-hero');
  expect(html).toContain('A generic line for a referred reader.');
  // UNDER the strip, not above it: the strip carries real information and a
  // referred reader is exactly who should still see it.
  expect(html.indexOf('data-now-strip')).toBeLessThan(html.indexOf('data-campaign-hero'));
});

test('the transformed variant is never cached, and carries no ETag while the plain response does', async () => {
  const plain = await home();
  expect(plain.headers.get('etag'), 'the plain response should carry an ETag').not.toBeNull();

  const response = await home('https://fixture-referrer.test/');
  expect(response.headers.get('cache-control')).toContain('no-store');
  // Defect 2, pinned end to end rather than only in tests/hero-band.test.ts:
  // see `withCampaignHero`'s docblock in src/lib/tier/hero-band.ts for why the
  // validator is dropped rather than suffixed -- a suffixed `ETag` would let a
  // cache that ignores `no-store` revalidate this variant and be handed the
  // untransformed page under the same validator, which is the defect rather
  // than a symptom of it.
  expect(response.headers.get('etag')).toBeNull();
});

test('a conditional request from a referred visitor still renders the band', async () => {
  const plain = await home();
  const etag = plain.headers.get('etag');
  expect(etag, 'the plain response should carry an ETag to revalidate against').not.toBeNull();

  // MEASURED 2026-09-16: this passes today because `matchStaticAsset` in
  // @astrojs/cloudflare discards every request header -- `If-None-Match`
  // included -- before it ever calls `env.ASSETS.fetch`, so `handle()` never
  // answers `/` with a `304` and this request is a plain `200` all the way
  // through (see `withCampaignHero`'s docblock in src/lib/tier/hero-band.ts
  // for the measurement). The test is here anyway, so that if a future
  // adapter release starts forwarding the conditional header, the home
  // page's own end-to-end behavior is what notices -- rather than only
  // `tests/hero-band.test.ts`, which is where the `304` branch itself is
  // exercised, against a `Response` built by hand. Asserted on content
  // rather than on `status`, so the case holds either way: a matched
  // referrer renders the band whether `withCampaignHero` received a fresh
  // representation or resolved one from a `304` itself.
  const revalidated = await home('https://fixture-referrer.test/some/page', {
    'if-none-match': etag ?? '',
  });
  const html = await revalidated.text();
  expect(html).toContain('data-campaign-hero');
  expect(html).toContain('A generic line for a referred reader.');
});

test('no referrer renders no band, and that response stays cacheable', async () => {
  const response = await home();
  const html = await response.text();
  expect(html).not.toContain('data-campaign-hero');
  expect(response.headers.get('cache-control') ?? '').not.toContain('no-store');
});

test('a referrer matching no campaign renders no band', async () => {
  const html = await (await home('https://example.test/')).text();
  expect(html).not.toContain('data-campaign-hero');
});

test('an unparseable referrer is data, not an error', async () => {
  // NOT THE MATCHER'S TOLERANCE FOR JUNK, which is what this comment used to
  // claim. `withCampaignHero`'s own same-origin `try`/`catch` in
  // src/lib/tier/hero-band.ts parses the referrer before `heroLineForReferrer`
  // ever sees it, so an unparseable referrer bails there and the matcher never
  // receives a string `new URL` would reject in the first place.
  //
  // `tests/agent-classify.test.ts`'s `heroLineForReferrer` block is where the
  // matcher's own tolerance for junk is pinned instead.
  //
  // RUN, NOT REASONED THROUGH (2026-09-16): deleting `heroLineForReferrer`'s
  // `try`/`catch` in src/lib/agent-intel/classify.ts reddens exactly that
  // block's `'not a url'` case and leaves every test in this file green, which
  // is the evidence for the claim above.
  const response = await home('not a url at all');
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain('data-campaign-hero');
});

test('markup in a campaign entry is escaped, not rendered', async () => {
  const site = server.getWorker<{ KV_CONFIG: KVNamespace }>();
  const kv = (await site.getEnv()).KV_CONFIG;
  await kv.put(
    'campaign:hero-injection',
    JSON.stringify({
      id: 'hero-injection',
      company: 'Injection Fixture',
      status: 'active',
      jd_text: 'Not used by this suite.',
      referrer_domains: ['injection-referrer.test'],
      hero_line: '<script>alert(1)</script>',
      token_audience: 'hero-injection',
      gated_narrative_doc: 'narratives/injection.md',
    }),
  );
  await deriveIndex();
  const html = await (await home('https://injection-referrer.test/')).text();
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(html).toContain('&lt;script&gt;');
});

test('a retired campaign with a matching referrer renders no band, and that response stays cacheable', async () => {
  const site = server.getWorker<{ KV_CONFIG: KVNamespace }>();
  const kv = (await site.getEnv()).KV_CONFIG;
  await kv.put(
    'campaign:hero-retired',
    JSON.stringify({
      id: 'hero-retired',
      company: 'Retired Fixture',
      status: 'retired',
      jd_text: 'Not used by this suite.',
      referrer_domains: ['retired-referrer.test'],
      hero_line: 'A retired line that must never render.',
      token_audience: 'hero-retired',
      gated_narrative_doc: 'narratives/retired.md',
    }),
  );
  // Derived WITH the retired entry present, so what this asserts is that the
  // derivation dropped it -- not that the index simply predates the seed.
  await deriveIndex();
  const response = await home('https://retired-referrer.test/');
  const html = await response.text();
  expect(html).not.toContain('data-campaign-hero');
  // `no-store` belongs to the transformed variant only (see `withCampaignHero`'s
  // docblock); a retired campaign must not render, so this response must be the
  // untransformed, cacheable one rather than a transformed-but-empty one.
  expect(response.headers.get('cache-control') ?? '').not.toContain('no-store');
});

test('a staged campaign with a matching referrer renders no band', async () => {
  const site = server.getWorker<{ KV_CONFIG: KVNamespace }>();
  const kv = (await site.getEnv()).KV_CONFIG;
  await kv.put(
    'campaign:hero-staged',
    JSON.stringify({
      id: 'hero-staged',
      company: 'Staged Fixture',
      status: 'staged',
      jd_text: 'Not used by this suite.',
      referrer_domains: ['staged-referrer.test'],
      hero_line: 'A staged line that must never render.',
      token_audience: 'hero-staged',
      gated_narrative_doc: 'narratives/staged.md',
    }),
  );
  await deriveIndex();
  const html = await (await home('https://staged-referrer.test/')).text();
  expect(html).not.toContain('data-campaign-hero');
});

test('a retired and an active campaign sharing one referrer domain renders the active one', async () => {
  const site = server.getWorker<{ KV_CONFIG: KVNamespace }>();
  const kv = (await site.getEnv()).KV_CONFIG;
  // KV `list` returns keys in lexicographic order, and matching a referrer is
  // first-match-wins over whatever list it is handed. Naming the retired
  // entry's key `shared-a-retired` and the active one's `shared-b-active` puts
  // the retired entry first in that order on purpose, so this test exercises
  // the ordering trap rather than depending on an incidental KV write order.
  // Renaming either key without keeping the retired one first would silently
  // stop testing the trap.
  //
  // THE GATE IT EXERCISES MOVED IN #233, and the trap did not. `buildHeroIndex`
  // now drops non-`active` campaigns while it walks that same list order, so
  // the retired entry never reaches the index and the active one is what
  // `heroLineForReferrer` finds. A gate applied after the match instead --
  // wherever it lived -- would still return the retired entry first and bail on
  // the whole response. `withCampaignHero`'s docblock in
  // src/lib/tier/hero-band.ts carries the full reasoning and the note that it
  // was checked against a deliberate
  // post-match gate rather than reasoned through.
  await kv.put(
    'campaign:shared-a-retired',
    JSON.stringify({
      id: 'shared-a-retired',
      company: 'Shared Retired Fixture',
      status: 'retired',
      jd_text: 'Not used by this suite.',
      referrer_domains: ['shared-referrer.test'],
      hero_line: 'The retired line that must not win.',
      token_audience: 'shared-a-retired',
      gated_narrative_doc: 'narratives/shared-a.md',
    }),
  );
  await kv.put(
    'campaign:shared-b-active',
    JSON.stringify({
      id: 'shared-b-active',
      company: 'Shared Active Fixture',
      status: 'active',
      jd_text: 'Not used by this suite.',
      referrer_domains: ['shared-referrer.test'],
      hero_line: 'The active line that must win.',
      token_audience: 'shared-b-active',
      gated_narrative_doc: 'narratives/shared-b.md',
    }),
  );
  await deriveIndex();
  const html = await (await home('https://shared-referrer.test/')).text();
  expect(html).toContain('data-campaign-hero');
  expect(html).toContain('The active line that must win.');
  expect(html).not.toContain('The retired line that must not win.');
});

test('with the index present, a referrer matching nothing renders no band and that response stays cacheable', async () => {
  // #233's first condition, and the reason it is a test of its own next to the
  // "matching no campaign" one above: that arrival is the common case -- a
  // search result or a social link is a cross-origin referrer -- so what it
  // costs and what it returns are both properties worth pinning. It must reach
  // the index (the guards above it do not bail on a cross-origin referrer) and
  // it must come back untransformed and cacheable, because a `no-store` on the
  // arrival that matches nothing would hand the cost of the feature to the
  // traffic the feature is not for.
  await deriveIndex();
  const response = await home('https://unmatched-referrer.test/some/page');
  const html = await response.text();
  expect(html).not.toContain('data-campaign-hero');
  expect(response.headers.get('cache-control') ?? '').not.toContain('no-store');
});

test('with no index written at all, a matching referrer renders no band rather than falling back to a walk', async () => {
  // The deliberate decision in `readHeroIndex` made visible: a missing key
  // returns `[]` and never falls back to `listCampaigns`. Nothing else can see
  // that choice -- a fallback would render exactly the same band this suite's
  // first test asserts, and would reintroduce the per-arrival `list` #233 exists
  // to remove, on precisely the requests that used to pay it.
  const env = await server.getWorker<HeroIndexEnv>().getEnv();
  await env.KV_CACHE.delete(HERO_INDEX_KEY);
  // `finally`, not a line after the assertions: every test here shares one
  // harness and one namespace, and a failing expectation throws. Restoring
  // after the assertions would put the key back only on the runs that did not
  // need it put back, turning one red test into every later test in the file
  // going red for a reason that is not theirs.
  try {
    const response = await home('https://fixture-referrer.test/some/page');
    const html = await response.text();
    expect(html).not.toContain('data-campaign-hero');
    expect(html).not.toContain('A generic line for a referred reader.');
    expect(response.headers.get('cache-control') ?? '').not.toContain('no-store');
  } finally {
    await refreshHeroIndex(env);
  }
});
