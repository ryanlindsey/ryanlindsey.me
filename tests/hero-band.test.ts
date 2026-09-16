import { expect, test, vi } from 'vitest';
import { withCampaignHero, type HeroBandEnv } from '../src/lib/tier/hero-band';
import { HERO_INDEX_KEY, type HeroIndexEntry } from '../src/lib/tier/hero-index';

// The campaign band's own unit suite (#234), and the reason it is harness-free
// is the one thing tests/campaign-hero.test.ts cannot do. That suite drives the
// band over real HTTP through `createTestHarness`, which means every request it
// makes goes through `handle()` -- and `handle()` never answers a conditional
// request with a `304`, because Astro's adapter drops the request headers
// before the `ASSETS` binding sees them (see the module header on
// src/lib/tier/hero-band.ts for the measurement). So the `304` branch is
// unreachable from there, and reaching it needs a `Response` built by hand and
// handed straight to the exported transform. That is what #234's first task
// moved this function into its own module for.
//
// NO `createTestHarness` AND NO SEAM IN PRODUCTION CODE. The override variables
// this repository does have exist to keep tests off paid or remote services,
// and a `304` is neither; adding a tenth one to fake a status code would put a
// test-shaped branch in the hot path of the home page. Calling the exported
// function directly is the whole mechanism.

/**
 * A stand-in for `HTMLRewriter`, which is a workerd global that Node does not
 * have -- `typeof HTMLRewriter` is `undefined` under vitest's default node
 * environment (measured 2026-09-16, Node v24.18.0), so without this the
 * transform throws before any assertion in this file is reached.
 *
 * IT IMPLEMENTS EXACTLY THE SUBSET `withCampaignHero` USES, an attribute
 * selector plus `element.after(html, { html: true })`, and it must never go
 * quietly green on a selector it does not understand. Two different mechanisms
 * hold that, and they are worth telling apart rather than claiming as one: a
 * selector FORM this stand-in does not parse -- anything but `[attribute]` --
 * throws outright, while a selector naming an attribute the fixture does not
 * carry finds no match and returns the document unchanged. The no-op case is
 * still caught, but by the assertions rather than by the stand-in: cases 1 and
 * 3 assert the band is in the body, so a transform that inserted nothing fails
 * them. What the real rewriter does with the real page is pinned over HTTP by
 * tests/campaign-hero.test.ts; what this file pins is which branch runs, how
 * many times each binding is called, and which headers come back.
 */
interface StubElement {
  after(content: string, options?: { html?: boolean }): void;
}
interface StubElementHandlers {
  element(element: StubElement): void;
}

function insertAfter(html: string, selector: string, handlers: StubElementHandlers): string {
  const attribute = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
  if (attribute === undefined) {
    throw new Error(
      `the stand-in rewriter understands only an attribute selector, not ${selector}`,
    );
  }
  // THE ATTRIBUTE BOUNDARIES ARE HAND-ROLLED RATHER THAN `\b`, and the reason
  // is that `\b` made the docblock's claim above false for the three selectors
  // most likely to arrive from a typo or a rename. `\bdata-now\b` matches
  // inside `data-now-strip`, because `-` is a word boundary, so `[data-now]`,
  // `[data]` and `[now]` all found the fixture's element where workerd's
  // rewriter matches none of them -- a stand-in quietly agreeing with a
  // selector production would reject. Whitespace before and a real attribute
  // terminator after is what actually delimits an attribute name in a tag.
  const match = new RegExp(
    `<(\\w+)([^>]*(?:^|\\s)${attribute}(?=[\\s=>/]|$)[^>]*)>([\\s\\S]*?)</\\1>`,
  ).exec(html);
  if (match === null) return html;
  let inserted = '';
  handlers.element({
    after(content: string) {
      inserted += content;
    },
  });
  const end = match.index + match[0].length;
  return html.slice(0, end) + inserted + html.slice(end);
}

class StubHTMLRewriter {
  private readonly handlers: Array<[string, StubElementHandlers]> = [];

  on(selector: string, handlers: StubElementHandlers): this {
    this.handlers.push([selector, handlers]);
    return this;
  }

  transform(response: Response): Response {
    const handlers = this.handlers;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let html = await response.text();
        for (const [selector, handler] of handlers) html = insertAfter(html, selector, handler);
        controller.enqueue(new TextEncoder().encode(html));
        controller.close();
      },
    });
    // Status, statusText and headers carry over, the same way the real
    // rewriter's `transform` leaves everything but the body alone.
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

// Through `unknown`, because `globalThis.HTMLRewriter` is typed as workerd's
// own class and this stand-in implements two of its methods rather than all of
// them -- the narrow assertion is the honest way to say so.
(globalThis as unknown as { HTMLRewriter: unknown }).HTMLRewriter = StubHTMLRewriter;

/**
 * A generic hero line and a generic referrer domain, following
 * tests/hero-index.test.ts's fixture rule: nothing in this repository names a
 * real campaign, company or posting, because that meaning arrives as runtime
 * data (10 §2.3).
 */
const HERO_LINE = 'A generic line for a referred reader.';
const REFERRER_DOMAIN = 'fixture-referrer.example';
const INDEX: HeroIndexEntry[] = [{ domain: REFERRER_DOMAIN, heroLine: HERO_LINE }];

/**
 * The page the band is inserted into. Hand-written rather than read out of
 * `dist`, because the only thing about the real home page this transform cares
 * about is that a `data-now-strip` element exists to insert after -- and a
 * fixture that has to be rebuilt before this suite can run would cost the
 * speed that is the point of a harness-free suite.
 */
const PAGE =
  '<!doctype html><html><body>' +
  '<div data-now-strip><p>A generic NOW line.</p></div>' +
  '<main><p>The rest of the page.</p></main>' +
  '</body></html>';

function htmlResponse(status = 200, headers: Record<string, string> = {}): Response {
  return new Response(PAGE, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

function homeRequest(referer?: string): Request {
  return new Request(
    'https://ryanlindsey.me/',
    referer === undefined ? undefined : { headers: { referer } },
  );
}

/**
 * The two bindings `withCampaignHero` touches, as hand-written objects with
 * call logs. Only `get` and `fetch` are ever called, so the cast to the binding
 * types is honest about what it stands in for -- the same fake-KV pattern
 * tests/hero-index.test.ts and tests/chat-engine.test.ts already use.
 *
 * `asset` defaults to a throw so an unexpected re-fetch fails loudly rather
 * than being absorbed by a test that was not looking for it.
 *
 * THE INIT IS RECORDED, NOT JUST THE URL, and that is the whole reason this
 * helper is shaped the way it is. The re-fetch's `init` is where the
 * feature lives or dies: forwarding the conditional headers would have the
 * binding answer `304` again, `!source.ok` would fire, and #234's defect
 * would be back with every test still green. An earlier version of this stub
 * took only `(input: string)` and dropped the second argument on the floor,
 * so `headers: request.headers` could have been added to the production call
 * without a single case noticing.
 */
function stubEnv(
  index: HeroIndexEntry[],
  asset: () => Response = () => {
    throw new Error('ASSETS.fetch was called by a test that expected no re-fetch');
  },
): {
  env: HeroBandEnv;
  kvGets: string[];
  assetFetches: Array<{ url: string; init?: RequestInit }>;
} {
  const kvGets: string[] = [];
  const assetFetches: Array<{ url: string; init?: RequestInit }> = [];
  return {
    env: {
      KV_CACHE: {
        get: async (key: string) => {
          kvGets.push(key);
          return key === HERO_INDEX_KEY ? index : null;
        },
      } as unknown as KVNamespace,
      ASSETS: {
        fetch: async (input: string, init?: RequestInit) => {
          assetFetches.push({ url: String(input), init });
          return asset();
        },
      } as unknown as Fetcher,
    },
    kvGets,
    assetFetches,
  };
}

// Case 1. PINS the whole point of #234: a returning visitor revalidating with
// `If-None-Match` still sees the band. BREAKS on the content-type bail, which
// returns early on a `304` because a `304` carries no `Content-Type` at all --
// before the fix this returns the `304` unchanged, with no band and no
// `ASSETS` call.
//
// THE FETCH IS ASSERTED WHOLE, url and init together, and the `toEqual` is
// exact rather than a spot check on each field. The url is `request.url`
// verbatim, which is what carries a query string to the binding exactly as
// `handle()` would have sent it. The init is `{ method: 'GET' }` and nothing
// else, which is the assertion that BREAKS on `headers: request.headers` --
// the one line a later reader is most likely to add helpfully, and the one
// that would restore #234's defect in silence by having the binding answer
// `304` again. An exact `toEqual` is what makes any added field fail here; a
// check that only asserted the url could not see it at all.
test('a 304 for a matching referrer renders the band from a re-fetched representation', async () => {
  const { env, assetFetches } = stubEnv(INDEX, () => htmlResponse());
  const response = await withCampaignHero(
    homeRequest(`https://${REFERRER_DOMAIN}/some/page`),
    new Response(null, { status: 304, headers: { etag: '"abc"' } }),
    env,
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('data-campaign-hero');
  expect(html).toContain(HERO_LINE);
  expect(assetFetches).toEqual([{ url: 'https://ryanlindsey.me/', init: { method: 'GET' } }]);
});

// Case 2. PINS that one URL never serves two bodies under one validator. The
// variant is `no-store`, so no cache may keep it; echoing the source's `ETag`
// onto it hands a cache that ignores `no-store` a validator this origin would
// answer with the untransformed page. BREAKS today, where the returned headers
// are copied from the source response and the `ETag` rides along.
test('the transformed variant carries no validator', async () => {
  const { env } = stubEnv(INDEX);
  const response = await withCampaignHero(
    homeRequest(`https://${REFERRER_DOMAIN}/`),
    htmlResponse(200, {
      etag: '"abc"',
      'last-modified': 'Mon, 15 Sep 2026 00:00:00 GMT',
    }),
    env,
  );
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('etag')).toBeNull();
  expect(response.headers.get('last-modified')).toBeNull();
});

// Case 3. PINS the existing behavior, and it is here so the `304` branch cannot
// be implemented by re-fetching unconditionally. A `200` already carries the
// body, so the band costs no second trip to the asset binding. BREAKS if the
// re-fetch is hoisted above the status check.
test('a 200 for a matching referrer renders the band and costs no extra fetch', async () => {
  const { env, assetFetches } = stubEnv(INDEX);
  const response = await withCampaignHero(
    homeRequest(`https://${REFERRER_DOMAIN}/some/page`),
    htmlResponse(),
    env,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(HERO_LINE);
  expect(assetFetches).toEqual([]);
});

// Case 4. PINS that carving the `304` out of the content-type bail does not
// open that bail up to everything else. A body this transform cannot rewrite is
// returned as the very same object, validator intact, before any storage is
// touched. BREAKS if the guard is loosened past the one status it needs to let
// through.
test('a response that is neither HTML nor a 304 is returned untouched', async () => {
  const { env, kvGets, assetFetches } = stubEnv(INDEX);
  const source = new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json', etag: '"abc"' },
  });
  const response = await withCampaignHero(homeRequest(`https://${REFERRER_DOMAIN}/`), source, env);
  expect(response).toBe(source);
  expect(response.headers.get('etag')).toBe('"abc"');
  expect(kvGets).toEqual([]);
  expect(assetFetches).toEqual([]);
});

// Case 5. PINS the safe direction of the re-fetch. An asset server's own error
// page is HTML, so a content-type test alone would let a `500` through to the
// transform -- and because the returned response is built from the transformed
// status, what the visitor gets is not a `200` wearing the home page's band,
// as an earlier version of this comment said, but their valid `304` replaced
// by a `500`. That is the harm worth naming: it takes away a cached copy the
// client already holds and answers its revalidation with an error body. The
// `text/html` on the stub is deliberate for the same reason the guard is: a
// `500` with no content type would be refused by the content-type check alone
// and would prove nothing. BREAKS if the re-fetch checks only the content type
// and not the status.
test('a 304 whose re-fetch does not come back as a usable page is returned untouched', async () => {
  const { env } = stubEnv(
    INDEX,
    () =>
      new Response('<!doctype html><html><body>An error page.</body></html>', {
        status: 500,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
  );
  const source = new Response(null, { status: 304, headers: { etag: '"abc"' } });
  const response = await withCampaignHero(homeRequest(`https://${REFERRER_DOMAIN}/`), source, env);
  expect(response).toBe(source);
  expect(response.status).toBe(304);
  expect(response.headers.get('etag')).toBe('"abc"');
  expect(response.headers.get('cache-control')).toBeNull();
});

// Case 6. PINS that the cheap guards stay in front of the index read. A direct
// visit, a same-origin navigation and any path but `/` are the overwhelming
// majority of arrivals, and none of them may pay a KV round trip. BREAKS if a
// guard is reordered behind `readHeroIndex`.
test('the plain paths bail before the index is read', async () => {
  const cases: Array<[string, Request]> = [
    ['no referrer', homeRequest()],
    ['a same-origin referrer', homeRequest('https://ryanlindsey.me/writing/')],
    [
      'a path that is not /',
      new Request('https://ryanlindsey.me/writing/', {
        headers: { referer: `https://${REFERRER_DOMAIN}/` },
      }),
    ],
  ];
  for (const [name, request] of cases) {
    const { env, kvGets, assetFetches } = stubEnv(INDEX);
    const source = htmlResponse();
    expect(await withCampaignHero(request, source, env), name).toBe(source);
    expect(kvGets, name).toEqual([]);
    expect(assetFetches, name).toEqual([]);
  }
});

// Case 7. PINS WHERE THE RE-FETCH SITS, which is the one constraint the five
// cases above cannot see. A cross-origin referrer is what a search result and a
// social link both produce, so an arrival that matches NO campaign domain is
// the common case rather than the exotic one, and it must not pay an asset
// fetch to discover that. The two assertions are a pair and neither works
// alone: no `ASSETS` call proves the re-fetch did not run, and `kvGets` holding
// exactly the index key proves the bail happened AFTER the lookup rather than
// at one of the cheap guards that would have made the first assertion true for
// the wrong reason.
//
// BREAKS if the re-fetch block is hoisted to sit under the content-type guard,
// still gated on `status === 304`. Every other case survives that move -- case
// 1 still fetches once, case 3 is a `200` and never enters the branch, case 5
// still returns its source, and cases 4 and 6 never see a `304` at all -- which
// is exactly why this one exists. The failure surfaces on the `assetFetches`
// assertion rather than on the default stub's throw, because the production
// code now catches a rejected re-fetch (case 9); the call log is what stays
// visible through that catch.
test('a 304 that matches no campaign domain costs no re-fetch', async () => {
  const { env, kvGets, assetFetches } = stubEnv(INDEX);
  const source = new Response(null, { status: 304, headers: { etag: '"abc"' } });
  const response = await withCampaignHero(
    homeRequest('https://unmatched-referrer.example/some/page'),
    source,
    env,
  );
  expect(response).toBe(source);
  expect(assetFetches).toEqual([]);
  expect(kvGets).toEqual([HERO_INDEX_KEY]);
});

// Case 8. PINS that the method is FORWARDED rather than hardcoded, which case
// 1's `{ method: 'GET' }` cannot tell apart on its own: the request it sends is
// a `GET`, so a literal `'GET'` in the production call would satisfy it. A
// `HEAD` is what distinguishes the two. Without the forward, a `HEAD /`
// revalidation is re-fetched as a `GET` and answered with a body, which is the
// same opposite-choices problem `serveMarkdownAsset` avoided by forwarding
// `method: request.method` on this same binding. BREAKS if the init's method
// is dropped or written as a constant.
test('the re-fetch carries the request method rather than assuming GET', async () => {
  const { env, assetFetches } = stubEnv(INDEX, () => htmlResponse());
  const request = new Request('https://ryanlindsey.me/', {
    method: 'HEAD',
    headers: { referer: `https://${REFERRER_DOMAIN}/` },
  });
  await withCampaignHero(
    request,
    new Response(null, { status: 304, headers: { etag: '"abc"' } }),
    env,
  );
  expect(assetFetches).toEqual([{ url: 'https://ryanlindsey.me/', init: { method: 'HEAD' } }]);
});

// Case 9. PINS that a REJECTED re-fetch cannot escape the Worker. Nothing above
// this function catches -- not the call site in src/worker.ts, not its exported
// `fetch` -- so without the `try` a rejection from the asset binding answers the
// home page with the runtime's error page, on exactly the arrivals the band
// exists for. src/lib/tier/hero-index.ts closed this same hazard one call
// further along the path on 2026-09-16, and this branch added a second remote
// call beside the one it had just guarded.
//
// `assetFetches` HAVING ONE ENTRY IS HALF THE TEST. Without it this case would
// also pass if the function had bailed before reaching the re-fetch at all,
// which is the same trap case 7's paired assertions avoid. The warning is
// asserted rather than merely silenced, because a failed re-fetch is otherwise
// indistinguishable from an arrival that matched nothing. BREAKS if the `try`
// is removed: the rejection propagates and the test errors instead of failing.
test('a re-fetch that rejects returns the original 304 rather than escaping', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { env, assetFetches } = stubEnv(INDEX, () => {
    throw new TypeError('the asset binding rejected');
  });
  const source = new Response(null, { status: 304, headers: { etag: '"abc"' } });
  const response = await withCampaignHero(homeRequest(`https://${REFERRER_DOMAIN}/`), source, env);
  expect(response).toBe(source);
  expect(response.status).toBe(304);
  expect(assetFetches).toHaveLength(1);
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});
