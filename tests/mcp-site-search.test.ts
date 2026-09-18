import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS, MCP_WORKER } from './workers';
import { LIMITS } from '../src/lib/mcp/limits';
import { searchDataPointFor } from '../src/lib/agent-intel/record';
import { classifyRequest, signalsFrom } from '../src/lib/agent-intel/classify';
import {
  MAX_QUERY_CHARS,
  SEARCH_CACHE_TTL_SECONDS,
  SEARCH_CACHE_VERSION,
  normalizeQuery,
  parseSearchType,
  resultsFrom,
  searchCacheKey,
  searchEngineMode,
  typeFor,
} from '../src/lib/search/engine';
import type { McpEnv } from '../workers/mcp/src/env';

/**
 * `GET /search` on the MCP Worker (issue #146, epic #143).
 *
 * WHAT THIS SUITE CANNOT PROVE, said first because it decides the shape of
 * everything below: `AI_SEARCH` is overridden to workers/mock-ai here, so
 * `env.AI_SEARCH.search()` is an RPC call into a Worker that does not
 * implement the method and throws at the await (#144 measured exactly that,
 * and tests/workers.ts records why the override is not optional). No test in
 * this file sees a real retrieval, a real ranking or a real excerpt. The live
 * round trip is verified by hand against `ryanlindsey-me-search`, the same way
 * `search_writing`'s is.
 *
 * What it DOES prove is the half that has the branches: normalization, the
 * cache key, the mapping, the seam, the limiter and the refusal shapes.
 */
/**
 * The `AE` binding double, built here the same way tests/chat-endpoint.test.ts
 * builds it and for the same reason: `MCP_WORKER` is shared by every suite
 * that boots this Worker, and widening it for the two files that want a
 * readable Analytics Engine would make every other suite pay for a mock it
 * never reads. Deriving the rest of the list from `MCP_HARNESS_WORKERS` keeps
 * any worker added there in the future reachable from here automatically.
 */
type MockAeModule = typeof import('../workers/mock-ae/src/index');
const MOCK_AE_WORKER = { configPath: './workers/mock-ae/wrangler.jsonc' };

const server = createTestHarness({
  workers: [
    { ...MCP_WORKER, bindingOverrides: { ...MCP_WORKER.bindingOverrides, AE: 'mock-ae' } },
    ...MCP_HARNESS_WORKERS.filter((worker) => worker !== MCP_WORKER),
    MOCK_AE_WORKER,
  ],
});
let env: McpEnv;
let mockAe: Awaited<
  ReturnType<ReturnType<typeof server.getWorker<unknown, MockAeModule>>['getExport']>
>;

beforeAll(async () => {
  await server.listen();
  env = await server.getWorker<McpEnv>('ryanlindsey-me-mcp').getEnv();
  mockAe = await server.getWorker<unknown, MockAeModule>('mock-ae').getExport();
});

afterAll(async () => {
  await server.close();
});

/**
 * EVERY CALL GETS ITS OWN ADDRESS, and the default is derived rather than
 * omitted.
 *
 * A request with no `cf-connecting-ip` keys `site-search:unknown`, whose
 * capacity is `LIMITS.inference.limit` -- ten. The suite runs in about a
 * second, so the bucket refills by nothing while it does, which means ten
 * un-addressed requests spend the whole allowance and the eleventh test anybody
 * adds fails on an unrelated 429 that reads as a limiter bug. MEASURED during
 * review: one extra request before the last test turned a green file red.
 *
 * A counter rather than a constant, so a test added in the middle cannot
 * silently share a bucket with one added at the end. The two limiter tests pass
 * a fixed address of their own precisely because they DO want one bucket.
 */
let addresses = 0;
const search = (query: string, headers: Record<string, string> = {}) => {
  addresses += 1;
  return server.getWorker('ryanlindsey-me-mcp').fetch(`/search${query}`, {
    // A different TEST-NET block from the one the two limiter tests pin, so a
    // rotating address can never land in a bucket those tests are counting.
    headers: { 'cf-connecting-ip': `198.51.100.${addresses % 200}`, ...headers },
  });
};

describe('the pure half: normalization and the cache key', () => {
  test('surrounding whitespace is trimmed away', () => {
    expect(normalizeQuery('  turnstile  ')).toBe('turnstile');
  });

  test('internal whitespace collapses to one space', () => {
    expect(normalizeQuery('agent   native\n\tsite')).toBe('agent native site');
  });

  test('an over-long query is capped', () => {
    expect(normalizeQuery('x'.repeat(MAX_QUERY_CHARS + 50))).toHaveLength(MAX_QUERY_CHARS);
  });

  test('a query of only whitespace normalizes to empty', () => {
    expect(normalizeQuery(' \n\t ')).toBe('');
  });

  test('a cap that lands on a space leaves no trailing space', () => {
    const query = normalizeQuery(`${'x'.repeat(MAX_QUERY_CHARS - 1)} more words`);
    expect(query).toBe(query.trimEnd());
  });

  test('a cap that would split a surrogate pair drops it whole', () => {
    // A lone high surrogate is not a character; `TextEncoder` turns it into a
    // replacement, so it would reach both the index and the cache key as one.
    expect(normalizeQuery(`${'x'.repeat(MAX_QUERY_CHARS - 1)}\u{1F600}`)).toBe(
      'x'.repeat(MAX_QUERY_CHARS - 1),
    );
  });

  test('two spellings of one query produce one cache key', async () => {
    const [loose, tight] = await Promise.all([
      searchCacheKey(normalizeQuery('  agent   native  site ')),
      searchCacheKey(normalizeQuery('agent native site')),
    ]);
    expect(loose).toBe(tight);
  });

  test('two different queries produce different cache keys', async () => {
    const [one, two] = await Promise.all([searchCacheKey('turnstile'), searchCacheKey('armature')]);
    expect(one).not.toBe(two);
  });

  test('case does not double-spend, because a phone capitalizes the first letter', async () => {
    const [typed, autocapitalized] = await Promise.all([
      searchCacheKey('armature'),
      searchCacheKey('Armature'),
    ]);
    expect(typed).toBe(autocapitalized);
  });

  test('the cache key carries no query text', async () => {
    expect(await searchCacheKey('turnstile')).not.toContain('turnstile');
  });

  test('the TTL matches the instance sync interval', () => {
    expect(SEARCH_CACHE_TTL_SECONDS).toBe(86_400);
  });

  test('the cache namespace moved off v2, so boilerplate-era answers are unreadable', async () => {
    // Twice now for the same reason, which is why this test is named after the
    // namespace rather than after either change.
    //
    // #249 turned reranking on. #250 put a content selector on the instance,
    // so a chunk is a page's `<main>` rather than the whole document: the skip
    // link stops reaching the index, every chunk boundary behind it moves, and
    // the scores, the URLs and the excerpts a query answers with move with
    // them. (The skip link alone -- the header and the footer were never in a
    // chunk, which src/lib/search/engine.ts records.) Both are changes to the
    // CONTENT of a cached value under an unchanged shape, and `searchCacheKey`
    // is built from the query alone -- nothing in it names the index, the
    // instance configuration or the retrieval options. Without the bump every
    // query anybody had already run keeps serving its old answer for up to
    // twenty-four hours, and the by-hand verification both issues ask for
    // reads as a failure.
    //
    // ORDER THE TWO HALVES, because only one direction is clean. The instance
    // change and this deploy are separate acts, and #250 applies the selector
    // FIRST, waiting for the sync it triggers to finish: entries written
    // before that point are v2 and this bump discards them. Deploying first
    // inverts it -- v3 entries written before the new chunks exist come from
    // the old index and survive it by up to a day.
    //
    // PINNED TO A LITERAL, and going red on the next legitimate bump is the
    // point rather than a defect: this repo pins `SEARCH_CACHE_TTL_SECONDS`
    // the same way. Whoever bumps it updates this line and reads the comment
    // above while doing so. The key prefix derives from the constant, so only
    // this one line carries the number.
    expect(SEARCH_CACHE_VERSION).toBe(3);
    expect(await searchCacheKey('turnstile')).toMatch(
      new RegExp(`^search:v${SEARCH_CACHE_VERSION}:`),
    );
  });
});

describe('the pure half: the type a result URL names', () => {
  test('a post under /writing is writing', () => {
    expect(typeFor('https://ryanlindsey.me/writing/armature/')).toBe('writing');
  });

  test('a case study under /work is work', () => {
    expect(typeFor('https://ryanlindsey.me/work/silent-failure/')).toBe('work');
  });

  test('the writing index itself is a page, not a post', () => {
    expect(typeFor('https://ryanlindsey.me/writing/')).toBe('page');
  });

  test('a standalone page is a page', () => {
    expect(typeFor('https://ryanlindsey.me/ai-policy/')).toBe('page');
  });

  test('a key that is not an absolute URL has no type', () => {
    expect(typeFor('writing/armature')).toBeNull();
  });

  test('an accepted filter parses to itself', () => {
    expect(parseSearchType('work')).toBe('work');
  });

  test('an absent filter is null rather than a default', () => {
    expect(parseSearchType(null)).toBeNull();
  });

  test('an unknown filter is rejected rather than ignored', () => {
    expect(parseSearchType('resume')).toBe('unknown');
  });
});

describe('the pure half: mapping chunks to results', () => {
  const response = {
    search_query: 'armature',
    chunks: [
      {
        id: 'c1',
        type: 'text',
        score: 0.8,
        text: 'Armature is a Claude Code plugin.',
        // `metadata` carries what #145 measured a web-crawler source to put
        // there, `description` included, precisely so the assertion that no
        // crawled description reaches the caller has something to bite on.
        item: {
          key: 'https://ryanlindsey.me/writing/armature/',
          metadata: { description: 'a crawled meta description', chunk_modality: 'text' },
        },
      },
      {
        id: 'c2',
        type: 'text',
        score: 0.5,
        text: 'A silent failure, measured.',
        item: { key: 'https://ryanlindsey.me/work/silent-failure/' },
      },
    ],
  };

  test('a chunk becomes a url, an excerpt and a score, and nothing else', () => {
    const [first] = resultsFrom(response, null);
    expect(Object.keys(first ?? {}).sort()).toEqual(['excerpt', 'score', 'url']);
  });

  test('the url is the crawled item key', () => {
    expect(resultsFrom(response, null)[0]?.url).toBe('https://ryanlindsey.me/writing/armature/');
  });

  test('no crawled title or description reaches the caller', () => {
    expect(JSON.stringify(resultsFrom(response, null))).not.toContain('description');
  });

  test('a type filter drops the results it does not name', () => {
    expect(resultsFrom(response, 'work').map((r) => r.url)).toEqual([
      'https://ryanlindsey.me/work/silent-failure/',
    ]);
  });

  test('one url appears once even when several of its chunks match', () => {
    const repeated = {
      search_query: 'armature',
      chunks: [response.chunks[0]!, { ...response.chunks[0]!, id: 'c3', score: 0.7 }],
    };
    expect(resultsFrom(repeated, null)).toHaveLength(1);
  });

  test('the kept chunk is the best-scoring one', () => {
    const repeated = {
      search_query: 'armature',
      chunks: [
        { ...response.chunks[0]!, id: 'c3', score: 0.4, text: 'the weaker passage' },
        response.chunks[0]!,
      ],
    };
    expect(resultsFrom(repeated, null)[0]?.score).toBe(0.8);
  });

  test('a chunk whose key is not an absolute URL is dropped, not rendered', () => {
    const relative = {
      search_query: 'armature',
      chunks: [{ ...response.chunks[0]!, item: { key: 'writing/armature' } }],
    };
    expect(resultsFrom(relative, null)).toEqual([]);
  });

  test('filtering the mapped list matches filtering during the mapping', () => {
    // The property the cache relies on (review finding 8): the type filter is
    // a pure function of the URL and the dedupe is per URL, so one retrieval
    // answers every filter and only one index query has to be paid for.
    expect(resultsFrom(response, 'work')).toEqual(
      resultsFrom(response, null).filter((result) => typeFor(result.url) === 'work'),
    );
  });
});

describe('the SEARCH_ENGINE seam', () => {
  test('an absent value is the deployed behaviour', () => {
    expect(searchEngineMode({})).toBe('live');
  });

  test('the harness value selects the stub', () => {
    expect(searchEngineMode({ SEARCH_ENGINE: 'stub' })).toBe('stub');
  });

  test('an unrecognised value throws rather than guessing', () => {
    expect(() => searchEngineMode({ SEARCH_ENGINE: 'maybe' })).toThrow(
      /unrecognised SEARCH_ENGINE/,
    );
  });

  test('the harness sets it, so this Worker never reaches the binding', () => {
    expect(env.SEARCH_ENGINE).toBe('stub');
  });
});

describe('GET /search', () => {
  test('POST is not the endpoint, and the refusal says which method is', async () => {
    const response = await server
      .getWorker('ryanlindsey-me-mcp')
      .fetch('/search?q=armature', { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  test('an absent query is a 400 rather than an empty search', async () => {
    expect((await search('')).status).toBe(400);
  });

  test('a whitespace-only query is a 400 too', async () => {
    expect((await search('?q=%20%20')).status).toBe(400);
  });

  test('an unknown type filter is a 400', async () => {
    expect((await search('?q=armature&type=resume')).status).toBe(400);
  });

  test('a refusal carries a sentence the page can render', async () => {
    const body = (await (await search('')).json()) as { error: string; message: string };
    expect(body.error).toBe('empty-query');
    expect(body.message.length).toBeGreaterThan(0);
  });

  test('the stub answers with its fixture', async () => {
    const body = (await (await search('?q=armature')).json()) as {
      query: string;
      results: { url: string }[];
    };
    expect(body.query).toBe('armature');
    expect(body.results.length).toBeGreaterThan(0);
  });

  test('the fixture names a draft, so #147 has something its join must drop', async () => {
    const body = (await (await search('?q=armature')).json()) as { results: { url: string }[] };
    expect(body.results.some((r) => r.url.includes('/writing/type-specimen'))).toBe(true);
  });

  test('the answer is the normalized query, not the raw one', async () => {
    const body = (await (await search('?q=%20%20armature%20%20')).json()) as { query: string };
    expect(body.query).toBe('armature');
  });

  test('the response is JSON and is not cached by the browser', async () => {
    const response = await search('?q=armature');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('a cache hit is served without reaching retrieval', async () => {
    // Seeded with something the stub fixture would never produce, so a
    // response carrying it proves the cache short-circuited the engine rather
    // than proving the two happen to agree.
    const key = await searchCacheKey('cache-probe');
    await env.KV_CACHE.put(
      key,
      JSON.stringify([{ url: 'https://ryanlindsey.me/ops/', excerpt: 'seeded', score: 0.99 }]),
      { expirationTtl: SEARCH_CACHE_TTL_SECONDS },
    );
    const body = (await (await search('?q=cache-probe')).json()) as {
      results: { excerpt: string }[];
    };
    expect(body.results[0]?.excerpt).toBe('seeded');
  });

  test('a miss stores the answer under the normalized key', async () => {
    await search('?q=store-probe');
    const stored = await env.KV_CACHE.get(await searchCacheKey('store-probe'), 'json');
    expect(stored).not.toBeNull();
  });

  test('a filtered search reuses the unfiltered answer rather than paying again', async () => {
    // Review finding 8. The cache is keyed on the query alone and the filter is
    // applied on the way out, so clicking through the type chips on one query
    // is one index query rather than four.
    const key = await searchCacheKey('chip-probe');
    await env.KV_CACHE.put(
      key,
      JSON.stringify([
        { url: 'https://ryanlindsey.me/ops/', excerpt: 'a page', score: 0.9 },
        { url: 'https://ryanlindsey.me/work/silent-failure/', excerpt: 'a study', score: 0.7 },
      ]),
      { expirationTtl: SEARCH_CACHE_TTL_SECONDS },
    );
    const body = (await (await search('?q=chip-probe&type=work')).json()) as {
      results: { url: string }[];
    };
    expect(body.results.map((r) => r.url)).toEqual(['https://ryanlindsey.me/work/silent-failure/']);
  });

  test('a cached value that is not an array is treated as a miss', async () => {
    await env.KV_CACHE.put(
      await searchCacheKey('junk-probe'),
      JSON.stringify({ not: 'an array' }),
      {
        expirationTtl: SEARCH_CACHE_TTL_SECONDS,
      },
    );
    const response = await search('?q=junk-probe');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[] };
    expect(body.results.length).toBeGreaterThan(0);
  });

  test('the limiter refuses the search after the allowance is spent', async () => {
    const allowance = LIMITS.inference.limit;
    const headers = { 'cf-connecting-ip': '203.0.113.42' };
    const statuses: number[] = [];
    for (let i = 0; i <= allowance; i += 1) {
      statuses.push((await search(`?q=limit-probe-${i}`, headers)).status);
    }
    expect(statuses.slice(0, allowance).every((status) => status === 200)).toBe(true);
    expect(statuses[allowance]).toBe(429);
  });

  test('a rate-limited search says how long to wait', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.43' };
    for (let i = 0; i <= LIMITS.inference.limit; i += 1) {
      await search(`?q=wait-probe-${i}`, headers);
    }
    const body = (await (await search('?q=wait-probe-final', headers)).json()) as {
      error: string;
      message: string;
    };
    expect(body.error).toBe('rate-limited');
    expect(body.message).toContain('seconds');
  });

  test('a search is one datapoint, and the datapoint never carries the query', async () => {
    await mockAe.reset();
    await search('?q=datapoint-probe');
    const points = await vi.waitFor(async () => {
      const recorded = await mockAe.points();
      expect(recorded).toHaveLength(1);
      return recorded;
    });
    expect(JSON.stringify(points[0])).not.toContain('datapoint-probe');
  });

  test('the appended fields say what happened without saying what was asked', async () => {
    await mockAe.reset();
    await search('?q=appended-probe&type=writing');
    const [point] = await vi.waitFor(async () => {
      const recorded = await mockAe.points();
      expect(recorded).toHaveLength(1);
      return recorded;
    });
    // blob7, doubles[2] and doubles[3] -- the three fields #146 appends. The
    // positions are asserted rather than the names, because positions are what
    // the SQL API addresses and what a reorder would silently re-label.
    expect(point?.blobs?.[6]).toBe('writing');
    // Two of the three fixture rows are under /writing, so the count is the
    // count AFTER the filter rather than the size of the retrieved window.
    expect(point?.doubles?.[2]).toBe(2);
    expect(point?.doubles?.[3]).toBe(0);
  });

  test('the second identical search records a cache hit', async () => {
    await search('?q=hit-probe');
    await mockAe.reset();
    await search('?q=hit-probe');
    const [point] = await vi.waitFor(async () => {
      const recorded = await mockAe.points();
      expect(recorded).toHaveLength(1);
      return recorded;
    });
    expect(point?.doubles?.[3]).toBe(1);
  });

  test('a request that never became a search is not recorded at all', async () => {
    // The same ruling `/chat` reached for its own shape refusals: an empty
    // query never became a search, and recording it would make `GET /search`
    // in a loop an UNMETERED write path on this Worker -- the limiter has not
    // run yet at that point -- whose rows would inflate the request total, the
    // route-class breakdown and the p50 that /ops publishes.
    await mockAe.reset();
    expect((await search('')).status).toBe(400);
    expect((await search('?q=x&type=resume')).status).toBe(400);
    expect(await mockAe.points()).toEqual([]);
  });

  test('a rate-limited search is recorded too, so /ops sees the refusal', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.44' };
    for (let i = 0; i <= LIMITS.inference.limit; i += 1) {
      await search(`?q=refusal-ae-probe-${i}`, headers);
    }
    await mockAe.reset();
    expect((await search('?q=refusal-ae-probe-final', headers)).status).toBe(429);
    const [point] = await vi.waitFor(async () => {
      const recorded = await mockAe.points();
      expect(recorded).toHaveLength(1);
      return recorded;
    });
    // `blob6` is `status_class`, which is how /ops tells a refused search from
    // a served one without a column of its own.
    expect(point?.blobs?.[5]).toBe('4xx');
  });

  test('the first six blobs still mean what every other row means', () => {
    // The guard on `AE_BLOB_FIELDS`'s append-only contract. A search row that
    // shifted `route_class` off `blob3` would silently re-label every
    // historical row in the /ops query that groups by it, and both sides would
    // still be internally consistent.
    const request = new Request('https://mcp.ryanlindsey.me/search?q=x');
    const point = searchDataPointFor(
      {
        classification: classifyRequest(signalsFrom(request), []),
        surface: 'search',
        status: 200,
        durationMs: 12,
      },
      { results: 3, cacheHit: false, type: null },
    );
    expect(point.blobs?.slice(0, 6)).toEqual([
      ...Object.values(classifyRequest(signalsFrom(request), [])),
      'search',
      '2xx',
    ]);
    expect(point.blobs?.[6]).toBe('all');
  });

  test('no bot check stands in front of it, because a results page is a URL', async () => {
    // A Turnstile challenge on a plain GET breaks linking, sharing and
    // reloading, which is the whole premise of `/search?q=...`. This asserts
    // the absence structurally rather than trusting the next edit.
    expect(await handlerSource()).not.toContain('verifyTurnstile');
  });

  test('reranking is asked for, with nothing else pinned inside it', async () => {
    // STRUCTURAL, because the live branch cannot execute here: under
    // `SEARCH_ENGINE: 'stub'` nothing in this suite reaches the binding, so an
    // edit that turned reranking back off would ship green.
    //
    // THIS ASSERTION INVERTED IN #249, AND THE REASON IS WORTH KEEPING. It read
    // `reranking: { enabled: false }` from #146 until #148 measured the
    // instance: without reranking `durable objects` returns nothing while
    // sitting in prose on five pages, and `hyperdrive` returns five results
    // while appearing on none. The request value wins over the instance
    // setting, so the flag #148 turned on did not reach this page until that
    // line changed. What this guards is now the opposite of what it guarded,
    // and both directions ship green rather than loud.
    //
    // THE WHOLE OBJECT, NOT `toContain('reranking')`, and the difference is the
    // review finding that caught it. `AiSearchOptions` gives the per-request
    // `reranking` a `model` and a `match_threshold` besides `enabled`, so a
    // pinned model is written `{ enabled: true, model: '...' }` INSIDE this
    // object. A guard reading for the instance's spelling, `reranking_model`,
    // never sees it. Matching the literal exactly is what rejects both.
    expect(await retrieveCallSource()).toMatch(/reranking:\s*\{\s*enabled:\s*true\s*\}/);
  });

  test('query rewriting stays off, which reranking being on does not change', async () => {
    // The other model-backed option, and #148 moved nothing about it. It is
    // the wrong thing to do to somebody who typed a literal term, and the
    // literal term is exactly what reranking is now here to get right. Same
    // whole-object match, for the same reason: `query_rewrite` also takes a
    // `model`.
    expect(await retrieveCallSource()).toMatch(/query_rewrite:\s*\{\s*enabled:\s*false\s*\}/);
  });

  test('the retrieval type stays unasked, so the instance decides it', async () => {
    // #145 measured hybrid unusable on this account, and the live instance is
    // `{ vector: true, keyword: false }`. Error 7070 rejects a `retrieval_type`
    // the instance's `index_method` does not support, so re-adding
    // `'hybrid'` here would refuse every search; pinning `'vector'` would keep
    // answering pure-vector searches from a hybrid index the day the beta
    // defect is fixed.
    //
    // NARROWED TO THE CALL, which is what makes this negative honest. The
    // prose around this call discusses `retrieval_type` at length, and a
    // file-wide scan would be satisfied or broken by a comment.
    expect(await retrieveCallSource()).not.toContain('retrieval_type');
  });
});

/**
 * The handler's whole source, with whole-line comments stripped, for the one
 * assertion that is genuinely about the whole file: that `verifyTurnstile`
 * appears nowhere in it.
 *
 * THE STRIPPER IS NOT THE NARROWING, and its own docblock used to imply it
 * was. It said this was "narrowed to the body of `retrieve`", which it never
 * did -- it reads the file and drops lines that start with `//`, `*` or `/**`.
 * That held only as long as no comment in the file mentioned a guarded token
 * on a line shaped some other way, which #249's rewritten comments do not
 * respect: they name `retrieval_type`, `reranking_model` and `reranking.model`
 * in prose. `retrieveCallSource` below is the real narrowing, and the option
 * assertions use it.
 */
async function handlerSource(): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('workers/mcp/src/search.ts', 'utf8');
  return source.replace(/^\s*(\/\/.*|\*.*|\/\*\*?)$/gm, '');
}

/**
 * Just the `env.AI_SEARCH.search({ ... })` call, so an assertion about what
 * this Worker ASKS THE INDEX FOR cannot be satisfied or broken by a sentence
 * written about it. Sliced rather than stripped: the comment above that call
 * runs to well over a hundred lines and discusses every option by name.
 *
 * Throws rather than returning `''` on a miss, because an empty string would
 * pass every negative assertion in this file and fail every positive one for a
 * reason that has nothing to do with what is being tested.
 */
async function retrieveCallSource(): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('workers/mcp/src/search.ts', 'utf8');
  const start = source.indexOf('await env.AI_SEARCH.search(');
  if (start === -1) throw new Error('the AI_SEARCH call moved; this helper needs updating');
  const end = source.indexOf('});', start);
  if (end === -1) throw new Error('the AI_SEARCH call is unterminated; this helper needs updating');
  return source.slice(start, end + 3);
}
