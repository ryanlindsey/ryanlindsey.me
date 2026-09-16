import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';

// The referrer-adaptive hero (04 §3, 09 §1): one band under the NOW strip,
// rendered only for a visitor arriving from an `active` campaign's own domain.
//
// PRESENTATION, NOT AUTHORIZATION. A `Referer` is attacker-supplied text and
// trivially forged, so everything this feature reveals must be harmless to a
// stranger -- which is what 09 §1's rule that the line carries no company name
// is for. Nothing here gates on the match.

const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });
let origin = '';

beforeAll(async () => {
  const { url } = await server.listen();
  origin = url.origin;
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
});
afterAll(async () => {
  await server.close();
});

function home(referer?: string): Promise<Response> {
  return fetch(`${origin}/`, referer === undefined ? {} : { headers: { referer } });
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

test('the transformed variant is never cached', async () => {
  const response = await home('https://fixture-referrer.test/');
  expect(response.headers.get('cache-control')).toContain('no-store');
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
  // `referrerClassFor` already holds this property for its own path; the hero
  // shares the matcher, so it inherits it, and a test says so rather than
  // trusting that it always will.
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
  const html = await (await home('https://staged-referrer.test/')).text();
  expect(html).not.toContain('data-campaign-hero');
});

test('a retired and an active campaign sharing one referrer domain renders the active one', async () => {
  const site = server.getWorker<{ KV_CONFIG: KVNamespace }>();
  const kv = (await site.getEnv()).KV_CONFIG;
  // KV `list` returns keys in lexicographic order, and `campaignForReferrer` is
  // first-match-wins over whatever it is handed (its own docblock). Naming the
  // retired entry's key `shared-a-retired` and the active one's `shared-b-active`
  // puts the retired entry first in that order on purpose, so this test exercises
  // the ordering trap described in `withCampaignHero`'s docblock rather than
  // depending on an incidental KV write order. Renaming either key without
  // keeping the retired one first would silently stop testing the trap.
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
  const html = await (await home('https://shared-referrer.test/')).text();
  expect(html).toContain('data-campaign-hero');
  expect(html).toContain('The active line that must win.');
  expect(html).not.toContain('The retired line that must not win.');
});
