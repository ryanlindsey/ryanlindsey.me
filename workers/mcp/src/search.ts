import { classifyRequest, signalsFrom } from '../../../src/lib/agent-intel/classify';
import { recordSearchEvent } from '../../../src/lib/agent-intel/record';
import { checkLimit, retryHint } from '../../../src/lib/mcp/limits';
import {
  SEARCH_CACHE_TTL_SECONDS,
  SEARCH_STUB_RESULTS,
  UNKNOWN_SEARCH_TYPE,
  filterByType,
  normalizeQuery,
  parseSearchType,
  resultsFrom,
  searchCacheKey,
  searchEngineMode,
  type SearchAnswer,
  type SearchResult,
} from '../../../src/lib/search/engine';
import type { McpEnv } from './env';

// `GET /search` (issue #146, epic #143): the site's own search, answered here
// and rendered by `src/pages/search.astro` (#147). This Worker owns the
// binding, the spend, the cache and the rate limit; the page holds none of
// them, the same "one implementation, two frontends" arrangement `/chat` and
// `/fit` already use.
//
// THE SECOND RETRIEVAL PATH ON THIS SITE, ON PURPOSE. src/lib/corpus.ts
// embeds every published document into the `ryanlindsey-me-corpus` Vectorize
// index, and `search_writing`, `/chat` and `/fit` read it. Nothing here
// changes any of that, and neither index should be pointed at the other:
//
//   - THAT index serves agents over published documents, pure vector, and its
//     contract is that the excerpt IS the passage that matched
//     (src/lib/mcp/search.ts's `exact` flag says so when it is not).
//   - THIS index serves people over every page the sitemap lists, `/ops` and
//     `/ai-policy` included, and it promises findability rather than a
//     verified passage. The excerpt below is crawled text and nothing checks
//     it against the document it came from.
//
// FOUR FILES CARRY THIS COMMENT, one for each place a reader can arrive at
// the ambiguity: src/lib/corpus.ts (the index the corpus builds),
// src/lib/mcp/search.ts (the contract that reads it), src/lib/search/engine.ts
// (the rules this one applies) and workers/mcp/src/search.ts (the route that
// serves it). Each names the other three, because a reader who finds two
// indexes over overlapping content is right to suspect one is a mistake.
//
// NO CAPTCHA AND NO TURNSTILE ON THIS PATH, and it is the one guard this
// endpoint deliberately does without. `/search?q=turnstile` is a plain GET
// that a person links, shares and reloads, and a bot check breaks all three,
// which is the entire premise of a results page. The limiter below is what
// bounds abuse instead, and the cache is what keeps the free plan's 20,000
// monthly queries out of reach of anyone hitting this in a loop.
// tests/mcp-site-search.test.ts asserts the absence structurally.
//
// NO CORS HEADERS, unlike /mcp, for the same reason ./chat.ts omits them: no
// third-party page has a reason to read this, so omitting them is free and
// narrows the surface.

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // The answer is already cached in KV for a day, keyed on the query. A second
  // cache in front of it -- the browser's, or Cloudflare's -- would pin a
  // result set to one reader for an unrelated interval and make a fixed index
  // look like a broken page.
  'cache-control': 'no-store',
};

/**
 * A refusal, as a body the page can render as a sentence.
 *
 * A SENTENCE HERE, unlike `/chat`'s `{ code }` and deliberately unlike it.
 * That endpoint answers an `EventSource`-shaped reader that has its own copy
 * of every string; this one answers a server-rendered page whose whole job is
 * to put words on screen, and a second table of codes-to-sentences on the site
 * would be a second place for them to disagree. `error` is still a stable
 * machine-readable label so the page can style the two cases differently.
 */
function refusal(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), { status, headers: JSON_HEADERS });
}

// THE ONE PLACE THIS WORKER WOULD READ CAMPAIGN DOMAINS, and does not, for the
// identical reason ./chat.ts's own copy does not: they live in KV, and this
// route has no more cause to pay a KV read per search than the site has to pay
// one per request.
const CAMPAIGN_DOMAINS_OFF: readonly string[] = [];

/**
 * The results this query has, from KV if they are there and from the index if
 * they are not. Always UNFILTERED: the caller applies the type filter to what
 * comes back, so one retrieval and one cache entry answer every chip.
 *
 * NOT `cached` FROM src/lib/ops/cache.ts, and the reason is the one thing that
 * helper cannot do: it returns the value and never says where it came from,
 * and whether a search was a cache hit is precisely what the datapoint below
 * exists to record. Its failure discipline is copied, BOTH HALVES OF IT, and
 * the second half is the one an earlier version of this function dropped:
 *
 *   - Every KV failure -- an unreadable namespace, a value that is not the
 *     JSON that was written, a rejected `put` -- ends with the fresh value
 *     being returned. A cache that fails degrades to a slow search and never
 *     to an error.
 *   - A FAILED RETRIEVAL IS NEVER STORED. `retrieve` throws rather than
 *     returning nothing (see `return_on_failure` in its own comment), so this
 *     function never reaches the `put` on a failure at all. The version that
 *     did reach it cached an empty array for twenty-four hours, which is a
 *     query answering "nothing found" for a day after a five-minute reindex,
 *     spending nothing and logging nothing unusual. That is the exact failure
 *     cache.ts's own comment was written to prevent.
 *
 * THE CACHED VALUE IS CHECKED, not merely non-null. Only this handler writes
 * this key, so a value of the wrong shape is a leftover from an older contract
 * rather than an attack, but `results.length` on a non-array is `undefined` in
 * the datapoint and an unrenderable body on the page. `SEARCH_CACHE_VERSION`
 * is what makes a deliberate shape change safe; this is what makes an
 * accidental one harmless.
 *
 * ONLY THE RESULTS ARRAY IS STORED, never the answer object. The query is put
 * back on the response by the caller, so no value in KV carries the text
 * anybody searched for -- the matching half of `searchCacheKey`'s decision to
 * hash rather than spell out the key.
 */
async function resultsFor(
  env: McpEnv,
  query: string,
): Promise<{ results: SearchResult[]; cacheHit: boolean }> {
  const key = await searchCacheKey(query);

  try {
    const hit = await env.KV_CACHE.get<unknown>(key, 'json');
    if (Array.isArray(hit)) return { results: hit as SearchResult[], cacheHit: true };
    if (hit !== null) {
      console.error(`search: the cached value at ${key} is not a result array; re-retrieving`);
    }
  } catch (error) {
    console.error(`search: the cache could not be read at ${key}`, error);
  }

  const results = await retrieve(env, query);

  try {
    await env.KV_CACHE.put(key, JSON.stringify(results), {
      expirationTtl: SEARCH_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.error(`search: the cache could not be written at ${key}`, error);
  }

  return { results, cacheHit: false };
}

/**
 * The index, or the fixture that stands in for it under the harness.
 *
 * `retrieval_type` IS OMITTED, AND THAT IS A CORRECTION RATHER THAN AN
 * OVERSIGHT. Issue #146 specified `'hybrid'`, on the epic's reasoning that the
 * keyword half is the whole case for a second index: pure vector is at its
 * worst on the query a person actually types, a product name or a single
 * technical term. #145 then measured the instance and found hybrid unusable on
 * this account today. With `index_method.keyword` on, every query reports
 * `vector_result_count: 0` and no chunk carries a `vector_score` at all; the
 * live instance is therefore `{ vector: true, keyword: false }`, and error
 * `7070` rejects a `retrieval_type` the instance's `index_method` does not
 * support. So asking for hybrid here would refuse every search.
 *
 * Omitted rather than pinned to `'vector'`: the default is the instance's own
 * `index_method`, so the day the beta defect is fixed and keyword indexing
 * goes back on, this call follows the instance without an edit. A literal
 * `'vector'` would keep answering pure-vector searches from a hybrid index and
 * nothing would say so. #148 owns re-measuring this.
 *
 * `query_rewrite` AND `reranking` ARE BOTH DECISIONS, NOT DEFAULTS. Each is
 * model-backed and bills through Workers AI, and each is a way this page's
 * spend grows without any line here looking like it grew. Rewriting is also
 * the wrong thing to do to somebody who typed a literal term, since it works
 * against the keyword half of the hybrid this instance is meant to get back
 * to, so `query_rewrite` stays off.
 *
 * RERANKING IS ON, AND THIS COMMENT USED TO SAY IT WAS OFF. #146 turned it
 * off on the argument that it should be earned rather than installed, and #148
 * measured it against the live instance on 2026-09-17 and earned it. On this
 * corpus it is not a reordering nicety. It is the difference between a search
 * that finds the page carrying your word and one that does not:
 *
 *   - `turnstile` appears as prose on `/ai-policy/` alone. Unreranked, that
 *     page ranked FIFTH of seven, below four pages that do not contain the
 *     word. Reranked it is the only result, at 0.7368.
 *   - `durable objects` appears in ordinary prose on five of the twelve
 *     indexed pages and returned NOTHING. Not a bad ordering; nothing.
 *     Reranked it returns five, led by the pages carrying the exact phrase.
 *   - `vectorize` appears on five pages and returned one result, a page
 *     lacking the word. Reranked it returns `/ops/` and `/writing/`.
 *   - `hyperdrive` appears NOWHERE on this site and returned five results.
 *     Reranked it returns none.
 *
 * TWO THINGS #148 FOUND THAT THE WORD "RERANKING" DOES NOT PREPARE YOU FOR.
 * It changes RETRIEVAL rather than only ordering: the `durable objects` chunks
 * carry vector scores of 0.295 to 0.343, under the 0.4 threshold that had been
 * discarding them, so the pool the reranker scores is drawn wider than
 * `match_threshold` alone would allow and the reranker's score replaces the
 * cosine score on the way out. ("Pool" rather than the term the retrieval
 * literature uses for it, because that term is one of the words the static
 * scan in tests/ bans from every shipped file, and this file is one.) And it
 * is LEXICAL in a way the embedding is not, which is why it repairs exact
 * terms and also why `skip to content` went from five weak matches to eight
 * confident ones. That contamination belongs to the crawl, and a
 * `content_selector` on the data source is its fix rather than anything here.
 *
 * WHAT IT COSTS, both halves. About $0.0000193 per query at the published unit
 * price for `@cf/baai/bge-reranker-base`, which is two cents per thousand
 * searches before the cache takes most of them. The cost that is not trivial
 * is natural language: the #145 baseline question returns six good rows
 * unreranked and ZERO reranked. That is a trade rather than a bug, and the
 * epic is explicit about which side of it this page is on -- `/chat` is this
 * site's answering surface and `src/pages/search.astro` hands questions to it.
 * Somebody searching a half-remembered phrase is worse off than they were, and
 * that handoff link is the only thing catching them.
 *
 * NO `reranking_model`, for the reason the omitted `retrieval_type` above
 * rests on. The instance carries an empty one and the default applies; naming
 * a model here would keep answering with one while the instance moved to
 * another and nothing would say so.
 *
 * `match_threshold` is left at its documented default of 0.4, which is also
 * what the instance carries. #148 swept it at 0.4, 0.3 and 0.2 and found the
 * answers identical query for query and score for score under reranking: the
 * reranker applies its own internal cut and the configured value never binds.
 * It stays at 0.4 because it is inert here, not because 0.4 was measured to be
 * the right number.
 *
 * `max_num_results: 20` IS SERVED NOW AND WAS NOT BEFORE. The binding honors
 * per-request options, which is the whole reason the reranking line below
 * reaches the index at all; wrangler's CLI flags do not, and #145 read that
 * asymmetry as an API limitation when it belongs to the CLI. The instance
 * carried `max_num_results: 10` when #148 measured it, quietly serving half of
 * what #146 asked for here, and #249 raises it to 20 with
 * `wrangler ai-search update` so the two agree. THAT VALUE LIVES IN NO FILE IN
 * THIS REPOSITORY, which is exactly why it is written down in one: nothing in
 * a diff, a test or a deploy will tell the next reader what the instance
 * carries, and `wrangler ai-search get` is the only thing that will.
 *
 * `return_on_failure: false` IS THE MOST IMPORTANT LINE IN THIS CALL, and the
 * default is the trap. The binding's own committed type says of it: "If true
 * (default), return empty results on retrieval failure instead of throwing."
 * So left alone, an index that is paused, mid-reindex or briefly erroring
 * answers `{ chunks: [] }`, which is INDISTINGUISHABLE from a query that
 * genuinely matched nothing. The caller would then cache that emptiness for
 * twenty-four hours: a five-minute outage would make every query issued during
 * it answer "nothing found" for a day, spending nothing, logging nothing
 * unusual, and showing up nowhere except as `result_count: 0, cache_hit: 1` in
 * Analytics Engine. Throwing instead makes the failure loud, keeps it out of
 * the cache, and lets `handleSiteSearch` answer a `503` that says the index is
 * unavailable rather than that the site has nothing to say.
 */
async function retrieve(env: McpEnv, query: string): Promise<SearchResult[]> {
  if (searchEngineMode(env) === 'stub') {
    return resultsFrom(
      {
        chunks: SEARCH_STUB_RESULTS.map((result) => ({
          score: result.score,
          text: result.excerpt,
          item: { key: result.url },
        })),
      },
      null,
    );
  }

  const response = await env.AI_SEARCH.search({
    query,
    ai_search_options: {
      retrieval: { max_num_results: 20, return_on_failure: false },
      query_rewrite: { enabled: false },
      reranking: { enabled: true },
    },
  });

  return resultsFrom(response, null);
}

/**
 * NO `ExecutionContext`, unlike every other route on this Worker.
 *
 * There is nothing here that should outlive the response. The cache write is
 * awaited on purpose -- a `waitUntil` would let the next identical search miss
 * a cache the previous one had already paid for -- and the datapoint write is
 * documented as non-blocking, which is why `recordAgentEvent` takes no context
 * either. A parameter taken and not used would be an invitation to reach for
 * it.
 */
export async function handleSiteSearch(request: Request, env: McpEnv): Promise<Response> {
  if (request.method !== 'GET') {
    // `Allow` and a sentence, because every other refusal on this route is one
    // the page can render. RFC 9110 requires the header on a 405 anyway, and
    // this route genuinely has exactly one method: a search is a URL, so there
    // is nothing for a body to carry.
    return new Response(JSON.stringify({ error: 'method', message: 'Search is a GET request.' }), {
      status: 405,
      headers: { ...JSON_HEADERS, allow: 'GET' },
    });
  }

  const started = Date.now();
  const params = new URL(request.url).searchParams;

  /**
   * Every answer this route gives past the method gate, recorded on its way
   * out.
   *
   * ONE EXIT RATHER THAN ONE CALL PER BRANCH, and a refusal that cost
   * something counts. A search refused by the limiter is still a request this
   * route answered, and it is the single most operationally interesting row
   * this surface can produce: `blob6` carries `4xx` for it, so /ops can see a
   * results page under load without anything new being queried. `/chat` writes
   * a datapoint from its own `refuse` for the same reason.
   *
   * THE TWO SHAPE REFUSALS ARE NOT RECORDED, and that is the other half of the
   * same precedent rather than an inconsistency with it. `/chat`'s Ruling 3
   * leaves a `GET`, a non-JSON body and anything else that never became a chat
   * turn unrecorded, and an absent or unparsable query never became a search.
   * The concrete cost of recording them is that both checks sit BEFORE the
   * limiter, so `GET /search` in a loop would be an unmetered Analytics Engine
   * write path on this Worker, and those rows would inflate the request total,
   * the route-class breakdown and the p50 that /ops publishes. The `405` is
   * unrecorded for the same reason.
   *
   * ONE `Date.now()` PER ANSWER, read here rather than at each call site, so
   * the latency recorded is the latency of the thing being returned.
   */
  const answer = (
    response: Response,
    search: { results: number; cacheHit: boolean; type: string | null },
  ): Response => {
    // NEVER THE QUERY TEXT. What is recorded is how the feature performed --
    // the result count, whether KV answered, the latency and which filter was
    // asked for -- and every field of that is a number or a value from a
    // closed set. `recordSearchEvent` APPENDS to the published blob contract
    // rather than inserting into it, so /ops's existing queries read a search
    // row correctly; see src/lib/agent-intel/record.ts.
    //
    // Nothing is stored, so there is no retention entry to add and no new
    // sentence needed in /ai-policy.
    recordSearchEvent(
      env,
      {
        classification: classifyRequest(signalsFrom(request), CAMPAIGN_DOMAINS_OFF),
        surface: 'search',
        status: response.status,
        durationMs: Date.now() - started,
      },
      search,
    );
    return response;
  };

  // NORMALIZED BEFORE THE KEY IS BUILT, never after. Two spellings of one
  // search have to reach one cache entry or the same query spends twice, and
  // the only way to guarantee that is for nothing downstream of here to see
  // the raw string.
  const query = normalizeQuery(params.get('q'));
  if (query === '') {
    // A 400 rather than an empty search, because the page renders its own
    // landing state without calling here at all: a request with no query
    // reaching this Worker means something upstream is wrong, and answering it
    // with a successful empty result set would hide that.
    return refusal(400, 'empty-query', 'Type something to search for.');
  }

  const type = parseSearchType(params.get('type'));
  if (type === UNKNOWN_SEARCH_TYPE) {
    return refusal(400, 'unknown-type', 'That is not a kind of page this site has.');
  }

  // THE LIMITER, BEFORE THE CACHE READ. A refused caller should cost a Durable
  // Object hop and nothing else -- not a KV read, and certainly not a query
  // against the index. Charging a cache hit a token is the conservative
  // direction and is deliberate: a loop hitting one cached query is still a
  // loop, and a person runs one search at a time.
  //
  // `inference` is the right cost class, and it got more right rather than
  // less: a search computes an embedding, which is the property that makes
  // `search_writing` an `inference` tool, and #249 put reranking behind this
  // same call, so a cache miss now runs a second model as well. Its own bucket
  // name rather than a tool's, so a visitor searching cannot starve an agent's
  // `search_writing` allowance or the other way round. The `null` grant is not an oversight either: this surface is
  // public and holds no token, so the address is the only thing there is to
  // key on.
  //
  // A DURABLE OBJECT AND NOT THE PLATFORM `ratelimits` BINDING. That binding
  // was configured correctly, deployed correctly and enforced nothing --
  // 150 sequential calls against a 60-per-60s bucket, zero refusals, measured
  // on 2026-09-08. workers/mcp/src/rate-limiter.ts carries the whole of #29.
  if (!(await checkLimit(env, 'inference', request, 'site-search', null))) {
    return answer(
      refusal(
        429,
        'rate-limited',
        `That is a lot of searches at once. Try again in ${retryHint('inference')}.`,
      ),
      { results: 0, cacheHit: false, type },
    );
  }

  let retrieved: { results: SearchResult[]; cacheHit: boolean };
  try {
    retrieved = await resultsFor(env, query);
  } catch (error) {
    // THE INDEX BEING UNREACHABLE IS NOT THE SITE HAVING NOTHING TO SAY, and
    // the difference is the whole reason `return_on_failure` is `false` above.
    // Everything that can arrive here is an operator's problem rather than the
    // caller's: a paused or mid-reindex instance, an exhausted quota, or a
    // request AI Search rejected outright -- error `7070`, if a
    // `retrieval_type` is ever asked for that the instance's `index_method`
    // does not support. So the stack goes to observability and the caller gets
    // one sentence, the same split `/chat` makes when its engine throws.
    //
    // 503 RATHER THAN 500, because the request was well formed and will work
    // again. Nothing is cached on this path, so the next request retries.
    console.error('search: retrieval failed', error);
    return answer(
      refusal(503, 'unavailable', 'Search is briefly unavailable. Try again in a moment.'),
      { results: 0, cacheHit: false, type },
    );
  }

  // FILTERED HERE, AFTER THE CACHE, so one retrieval answers every type chip.
  // See `filterByType` in src/lib/search/engine.ts for why that is exactly
  // equivalent to filtering during the mapping, and for what keying the cache
  // on the filter as well used to cost.
  const results = filterByType(retrieved.results, type);
  const body: SearchAnswer = { query, results };

  return answer(new Response(JSON.stringify(body), { headers: JSON_HEADERS }), {
    results: results.length,
    cacheHit: retrieved.cacheHit,
    type,
  });
}
