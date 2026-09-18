// Issue #146 (epic #143): the pure half of `/search` -- everything about a
// site search that can be decided without a binding, a network call or a
// spend. The Worker wiring lives in workers/mcp/src/search.ts; this module is
// what tests/mcp-site-search.test.ts can exercise with nothing bound at all,
// and it is the same split `src/lib/mcp/search.ts` already makes around
// `search_writing` for the same reason.
//
// THE SECOND RETRIEVAL PATH ON THIS SITE, AND DELIBERATELY SO. The first is
// the Vectorize corpus in src/lib/corpus.ts, read by `search_writing`, `/chat`
// and `/fit`. The two are not duplicates and neither should be pointed at the
// other:
//
//   - The corpus serves AGENTS over PUBLISHED DOCUMENTS -- posts, case studies
//     and the resume -- with pure vector retrieval, and its contract is that
//     the excerpt it returns is the passage that actually matched
//     (src/lib/mcp/search.ts's `exact` flag, which says so when it is not).
//   - This index serves PEOPLE over EVERY PAGE THE SITEMAP LISTS, `/ops` and
//     `/ai-policy` included, and it promises findability rather than a verified
//     passage: the excerpt here is crawled text and nothing checks it against
//     the document it came from.
//
// FOUR FILES CARRY THIS COMMENT, one for each place a reader can arrive at
// the ambiguity: src/lib/corpus.ts (the index the corpus builds),
// src/lib/mcp/search.ts (the contract that reads it), src/lib/search/engine.ts
// (the rules this one applies) and workers/mcp/src/search.ts (the route that
// serves it). Each names the other three, because a reader who finds two
// indexes over overlapping content is right to suspect one is a mistake.

/**
 * The kind of page a result URL names.
 *
 * NAMED AFTER THE URL SEGMENTS rather than after `CorpusType` (`post`,
 * `case-study`, `resume`), and the difference is a promise rather than a
 * spelling. A `CorpusType` comes off a document the corpus embedded and
 * carries that job's guarantees; this is derived from a crawled URL and
 * carries none of them. Borrowing the corpus's vocabulary would invite a
 * reader to assume the corpus's contract.
 */
export type SearchType = 'writing' | 'work' | 'page';

/**
 * What `parseSearchType` answers for a filter value that is not one of the
 * above. A sentinel rather than a throw, because this is caller input and the
 * handler owes it a `400` rather than a `500`.
 */
export const UNKNOWN_SEARCH_TYPE = 'unknown';

/** Every accepted `type` filter, as a closed set. */
const SEARCH_TYPES: readonly SearchType[] = ['writing', 'work', 'page'];

/**
 * The longest query this endpoint will search for.
 *
 * It bounds two different things and the second is the one that costs money:
 * an embedding is computed over whatever is passed, and AI Search bills it. A
 * hundred characters is a long natural-language question and is already
 * further than the baseline queries in #145 reach; anything past it is a paste
 * rather than a search.
 *
 * CAPPED RATHER THAN REFUSED, deliberately. A refusal would make a stray
 * paste into an error page, and the first hundred characters of a paste are
 * very often the thing the person meant to look for.
 */
export const MAX_QUERY_CHARS = 100;

/**
 * How long a cached answer lives, matched to the instance's 24-hour sync
 * interval (#145 recorded `sync_interval: 86400` on `ryanlindsey-me-search`).
 *
 * The pairing is what makes the cache correct rather than merely cheap: the
 * index only changes when a sync job runs, so within one interval a repeated
 * query genuinely has the same answer. If that interval is ever shortened on
 * the instance, this number has to follow it down or `/search` will keep
 * serving yesterday's index for a day.
 *
 * THE WORST CASE IS TWICE THIS, NOT THIS, and an earlier version of this
 * comment implied otherwise. A sync does not invalidate anything in KV, so an
 * entry written one minute before a sync serves pre-sync results for nearly a
 * full interval after it: up to about forty-eight hours from a page being
 * published to that page appearing in a previously-searched query. Accepted
 * rather than fixed, because the fix is a cache keyed on the index's own
 * version and the instance publishes no such thing today. The bound that
 * matters is still a bound, and the epic's alternative was to pay an index
 * query per request on a page anybody can hit in a loop.
 */
export const SEARCH_CACHE_TTL_SECONDS = 86_400;

/**
 * Bump when the cached VALUE changes, so entries written by the old code are
 * never read by the new. Same job as `RESUME_PDF_CONTRACT_VERSION` and
 * `CORPUS_CONTRACT_VERSION`, and needed for the same reason: a cache entry
 * outlives the deploy that wrote it.
 *
 * SHAPE IS NOT THE ONLY REASON, AND THIS COMMENT SAID IT WAS. It read "when
 * the cached VALUE's shape changes" until #249, which is the case that is easy
 * to spot and not the case that bites. A change to the value's CONTENT under
 * an unchanged shape needs a bump just as badly, because `searchCacheKey` is
 * built from the query alone: nothing in the key names the index, the instance
 * configuration or the retrieval options, so a query searched before the
 * deploy keeps serving its old answer for up to `SEARCH_CACHE_TTL_SECONDS`
 * and looks exactly like a change that did not ship.
 *
 * #148 REPORTED HAVING SEEN THAT, AND ITS EVIDENCE DOES NOT SHOW IT. That
 * issue read `/search?q=turnstile` still serving pre-reranking results after
 * the instance flag flipped as the cache holding a stale answer. It cannot
 * have been: the handler was sending `reranking: { enabled: false }` at the
 * time, and that request value wins, so a completely cold query would have
 * answered the same way. What it actually demonstrated is the override this
 * change exists to remove. The bump below is still right -- v1 entries really
 * do hold pre-reranking answers once this deploys -- but it rests on the key
 * being the query alone rather than on that observation.
 *
 * v1 -> v2 (#249): reranking turned on for the call in
 * workers/mcp/src/search.ts. Same `SearchResult` fields, different results in
 * them, and different scores -- roughly 0.53 to 0.99 where the cosine scores
 * v1 cached sit between 0.40 and 0.56.
 *
 * v2 -> v3 (#250): the instance grew a content selector -- path `**`,
 * selector `main` -- so a chunk is a page's `<main>` rather than its whole
 * document. Same fields again; the chunk text loses the skip link, and every
 * chunk boundary behind it moves, so the scores and the URLs move with it.
 *
 * THE SKIP LINK, AND NOT THE HEADER OR THE FOOTER, and an earlier draft of
 * this line claimed all three. Cloudflare's default pipeline already removes
 * `<header>`, `<footer>` and `<head>` before converting, and #145 measured
 * that against this instance: "the header nav and the whole footer are absent
 * from every chunk". What survived was a bare `<a>` in `<body>` ahead of the
 * header, which no default rule names. Worth keeping straight, because the
 * overstated version is what would send the next reader after a selector for
 * a problem the default already solves.
 *
 * THIS ONE IS THE CASE THE PARAGRAPH BELOW SAYS CANNOT BE COVERED, AND IT IS
 * COVERED ONLY BECAUSE OF WHEN IT HAPPENS. A content selector is instance
 * configuration: nothing in this repository forces the bump, and a later
 * change to it will not. What makes v3 honest is that #250 applies the
 * selector BEFORE this deploys, so every entry written against the old chunks
 * is a v2 entry and this bump discards all of them. Reversing the order would
 * not work -- v3 entries written in the gap would come from the old index and
 * outlive the selector by up to `SEARCH_CACHE_TTL_SECONDS`.
 *
 * "BEFORE THIS DEPLOYS" MEANS AFTER THE SYNC IT TRIGGERS HAS FINISHED, which
 * is the narrower condition and the one to hold. Saving a content selector
 * starts a sync immediately, and until it completes the index still holds old
 * chunks, so a deploy landing mid-sync writes v3 entries built from them and
 * keeps each for a full TTL. Twelve pages makes that window small rather than
 * absent, and #145 watched a single file stall in the retry queue across
 * successive syncs, so "small" is not "over when the job log says so".
 *
 * IT WAS AN UPDATE RATHER THAN A REBUILD, which matters to whoever changes it
 * next, because #250 and #148 both say it cannot be. They rest on #145's
 * finding that `source_params` is settable at create time and not by
 * `update` -- true of the path filter, and not true of this field:
 * Cloudflare documents content selectors as configured "when creating or
 * updating an AI Search instance", with an update triggering an immediate
 * sync. `wrangler ai-search update` still exposes no flag for it, so the
 * dashboard is the only way in either case. The distinction is worth the
 * sentence: a rebuild would also have to re-enter `sync_interval: 86400`, the
 * path filter excluding `/fit`, `reranking` and `max_num_results: 20` by
 * hand, and the second of those is one of the epic's three gates.
 *
 * WHAT THIS CANNOT COVER is the instance moving underneath a deploy that
 * changes no file here: `reranking_model`, `embedding_model`, the crawl's
 * chunking, the content selector once it is set, or simply the index's
 * contents after a sync. Each changes what a query answers and
 * `wrangler ai-search update` leaves nothing in this repository to bump. Not
 * `reranking` itself, which is the one that used to belong on this list and no
 * longer does: #249 pins it in the request, and the request value wins. That
 * lag is the one above, bounded by the TTL, and the epic's alternative was a
 * cache keyed on a version the instance does not publish.
 */
export const SEARCH_CACHE_VERSION = 3;

/** One result, flat, with nothing in it that was not measured or crawled. */
export interface SearchResult {
  url: string;
  excerpt: string;
  score: number;
}

/** What `GET /search` answers with. */
export interface SearchAnswer {
  query: string;
  results: SearchResult[];
}

/** Whatever `AI_SEARCH.search()` returned, narrowed to the parts used here. */
export interface SearchChunks {
  chunks: ReadonlyArray<{
    score: number;
    text: string;
    item: { key: string };
  }>;
}

/**
 * The query, reduced to its one canonical spelling.
 *
 * ORDER MATTERS AND IT IS TRIM, COLLAPSE, CAP. Collapsing before capping means
 * the cap counts characters a reader typed rather than the whitespace between
 * them, so `a<50 spaces>b` and `a b` cap identically. Capping first would let
 * the same search land under two keys and spend twice, which is the whole
 * reason normalization happens before the key is built rather than after.
 *
 * `\s` rather than a space literal: a query pasted out of a document arrives
 * carrying newlines and tabs, and those are the spellings a person is least
 * likely to notice they sent.
 *
 * THE CAP CLEANS UP AFTER ITSELF, and both cases were review findings. A cap
 * landing on a space leaves a trailing one, which the response echoes back to
 * the page. A cap landing between the two halves of a surrogate pair leaves a
 * lone high surrogate, which is not a character at all: `TextEncoder` turns it
 * into a replacement, so it would reach the index and the cache key as one.
 * Dropping the orphan whole is the only reading that is true of what the
 * person typed.
 *
 * CASE IS DELIBERATELY PRESERVED HERE and folded in `searchCacheKey` instead.
 * The query in the response is what the page renders above the results, so
 * lowercasing it would show somebody who typed `Armature` a heading that says
 * `armature`. What case must not do is buy a second cache entry, and the key
 * is where that is decided.
 */
export function normalizeQuery(raw: string | null): string {
  return (raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_QUERY_CHARS)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();
}

/**
 * The `type` filter a request asked for: one of the closed set, `null` for a
 * request that asked for no filter, or `UNKNOWN_SEARCH_TYPE`.
 *
 * An unrecognised value is REPORTED rather than ignored, and the direction is
 * the point: silently dropping an unknown filter answers a search the caller
 * did not ask for, and answers it with more results than they expected, which
 * reads as the filter being broken rather than as the value being wrong.
 */
export function parseSearchType(
  raw: string | null,
): SearchType | null | typeof UNKNOWN_SEARCH_TYPE {
  if (raw === null || raw === '') return null;
  return SEARCH_TYPES.includes(raw as SearchType) ? (raw as SearchType) : UNKNOWN_SEARCH_TYPE;
}

/**
 * The kind of page a result URL names.
 *
 * DERIVED FROM THE URL because there is nothing else to derive it from.
 * #145 measured what a `web-crawler` source puts in `item.metadata` and it is
 * exactly `{ description, chunk_modality }` -- the `folder` and `filename`
 * attributes the epic hoped to filter on are R2 source attributes and do not
 * exist here at all. So there is no index-side filter available and no
 * built-in string attribute to put one on.
 *
 * ONE DERIVATION, HERE, for both callers. The handler filters with it and
 * #147's type chips label with it; a second copy on the page would be a second
 * place for `/writing/` (the index) and `/writing/armature/` (a post) to be
 * confused with each other.
 *
 * A section INDEX is a page rather than a post, which is the distinction the
 * slug segment carries: `/writing/` lists posts and is not one.
 *
 * `null` RATHER THAN A THROW for a key that is not an absolute URL, which is
 * caller data as far as this code is concerned: `item.key` comes off the
 * crawler, and #145 measured it as a full absolute URL with the trailing slash
 * for every one of the twelve indexed pages. That is a measurement of one
 * source type on one day rather than a guarantee, and this function is exported
 * for #147's chips as well, so an unparseable value has to have an answer. A
 * throw here would surface as `?type=work` being broken rather than as a key
 * that could not be read.
 */
export function typeFor(url: string): SearchType | null {
  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
  const [, section = '', slug = ''] = path.split('/');
  if (slug === '') return 'page';
  if (section === 'writing') return 'writing';
  if (section === 'work') return 'work';
  return 'page';
}

/**
 * The chunks AI Search returned, as the flat rows a caller sees.
 *
 * ONE ROW PER URL, not one per chunk. A long page matches on several of its
 * chunks and the index returns each of them (#145's baselines show
 * `/writing/armature/` four times in one top five), so an unfolded list is a
 * results page whose first four entries are the same link. The best-scoring
 * chunk wins, because it is the passage that best answers the query and it is
 * the one worth showing as the excerpt.
 *
 * NO TITLE, NO DATE, NO READING TIME, and their absence is the contract rather
 * than an omission. AI Search has no publish date -- `item.timestamp` records
 * when the crawler last saw the page -- and a title taken from crawled text
 * can drift from the document it claims to name. #147 joins these URLs against
 * `getCollection` and takes both from the canonical source, which is the same
 * move src/lib/corpus.ts makes when it reads published `.md` assets rather
 * than re-deriving their frontmatter. Returning a crawled title from here
 * would invite the page to trust it.
 *
 * `item.metadata.description` is dropped for the same reason, and #145 flagged
 * it specifically: it is the crawled meta description, so it is crawled text
 * wearing a canonical-looking name.
 *
 * A CHUNK WHOSE KEY IS NOT AN ABSOLUTE URL IS DROPPED rather than rendered.
 * Everything a caller is handed here is a link, and a link nobody can follow
 * is worse than one result fewer.
 *
 * THE FILTER IS APPLIED AFTER RETRIEVAL, not as part of it, because there is
 * nothing to filter on in the index (see `typeFor`). The cost is real and
 * belongs to #148: a filtered search sees only the types present in the
 * retrieved window, so `?type=work` over twenty mixed results can show fewer
 * work pages than the index holds.
 */
export function resultsFrom(response: SearchChunks, type: SearchType | null): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const chunk of response.chunks) {
    const url = chunk.item.key;
    const kind = typeFor(url);
    if (kind === null) continue;
    if (type !== null && kind !== type) continue;
    const current = best.get(url);
    if (current !== undefined && current.score >= chunk.score) continue;
    best.set(url, { url, excerpt: chunk.text, score: chunk.score });
  }
  // Re-sorted rather than trusting insertion order: the map preserves the
  // order each URL was FIRST seen in, and a later chunk that replaced it can
  // carry a higher score than a URL inserted before it.
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * The same filter, applied to rows that have already been mapped.
 *
 * THIS IS WHAT MAKES ONE INDEX QUERY ANSWER EVERY CHIP (review finding 8).
 * `typeFor` is a pure function of the URL and `resultsFrom`'s dedupe is per
 * URL, so filtering the deduped unfiltered list produces exactly what
 * filtering during the mapping produces: same members, same scores, same
 * order. tests/mcp-site-search.test.ts asserts that equality rather than
 * leaving it as an argument.
 *
 * The consequence is the whole point. The cache is keyed on the query ALONE,
 * one retrieval is paid for, and clicking through the type chips on one query
 * costs nothing more. Keying the cache on the filter as well -- the shape this
 * first shipped as -- made `?q=x` and `?q=x&type=writing` two paid index
 * queries for one retrieval, against a free plan of 20,000 a month.
 */
export function filterByType(
  results: readonly SearchResult[],
  type: SearchType | null,
): SearchResult[] {
  if (type === null) return [...results];
  return results.filter((result) => typeFor(result.url) === type);
}

/**
 * The KV key a query is cached under.
 *
 * THE QUERY ALONE, NOT THE QUERY AND THE FILTER. One retrieval answers every
 * type chip, because `filterByType` above applies the filter on the way out;
 * see its comment for why that is exactly equivalent and for what the earlier
 * shape cost.
 *
 * CASE IS FOLDED HERE AND NOWHERE ELSE. Both mobile keyboards capitalize the
 * first letter of a text input by default, so `Armature` and `armature` are
 * one search typed by two people and must not be two index queries, two cache
 * entries and two rows in Analytics Engine. Folding in `normalizeQuery`
 * instead would lowercase the heading the page renders above the results, and
 * folding nowhere is the double spend. The trade, said out loud: the second
 * caller is served results retrieved for the first caller's casing, and the
 * embeddings of the two differ slightly, so the ranking can differ slightly
 * from what their own casing would have produced. Worth it while the instance
 * is vector-only, since case carries no keyword signal to preserve; worth
 * re-reading if #148 gets keyword indexing back.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: this runs in a Worker with no
 * caller locale, and a locale-sensitive fold would make the key depend on
 * something the cache cannot see.
 *
 * HASHED RATHER THAN PLAIN, and this is the only decision in this module that
 * is about privacy rather than about correctness. A plain key would put the
 * text of every search into the KV namespace's key listing for a day, readable
 * in the dashboard, which is a quieter version of exactly the thing this
 * feature promises not to do (the Analytics Engine row carries no query text
 * either). The stored VALUE is the results array alone for the same reason --
 * the handler puts the query back on the answer it returns -- so nothing
 * persisted here is the query.
 *
 * SAID PLAINLY BECAUSE IT WOULD BE EASY TO OVERSTATE: a SHA-256 of a short
 * search term is a key, not anonymization. The space of plausible queries is
 * small enough to enumerate, so this raises the effort of reading the cache
 * back rather than making it impossible. What it does buy is that no ordinary
 * glance at the namespace shows anybody what was searched for, and that the
 * key expires with the entry.
 *
 * ASYNC, which `crypto.subtle` forces and which is worth the cost here: the
 * alternative is a hand-rolled synchronous hash, and a weak one would make the
 * paragraph above less true rather than more convenient.
 */
export async function searchCacheKey(query: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(query.toLowerCase()),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `search:v${SEARCH_CACHE_VERSION}:${hex}`;
}

/** The bindings and seams the pure half reads. */
export interface SearchEngineEnv {
  /**
   * Test-only seam, the tenth of the shape this repository already uses
   * after `CORPUS_REFRESH`, `MCP_SEARCH_EMBEDDER`, `RLME_TOKEN_KEY_SOURCE`,
   * `FIT_ENGINE`, `RLME_TURNSTILE_MODE`, `CHAT_ENGINE` and `JUDGE_ENGINE`: no
   * deployed config declares it, the deployed behaviour comes from its
   * ABSENCE, `'stub'` is the only other accepted value, and anything else
   * throws rather than guessing.
   *
   * IT IS NOT A CONVENIENCE HERE, it is the only thing that makes any of this
   * testable. #144 measured what `AI_SEARCH` does under the harness:
   * tests/workers.ts has to override the binding to a service Worker or
   * booting the MCP Worker opens a remote proxy session and every suite that
   * touches it fails at startup. Under that override `env.AI_SEARCH` is a
   * `Fetcher`, and an RPC stub answers every property access -- so
   * `typeof env.AI_SEARCH.search` is `'function'` and the `TypeError` arrives
   * at the await. A reachability probe would therefore pass and then throw,
   * which is why this is a var rather than a check.
   */
  SEARCH_ENGINE?: string;
}

/**
 * Which half of the seam this environment selects.
 *
 * A plain `Error` on an unrecognised value, never a refusal the caller can
 * see: a mis-set var is an operator's mistake and must not be dressed up as an
 * outage. Same shape as `CHAT_ENGINE`'s throw in src/lib/chat/engine.ts.
 */
export function searchEngineMode(env: SearchEngineEnv): 'live' | 'stub' {
  if (env.SEARCH_ENGINE === undefined) return 'live';
  if (env.SEARCH_ENGINE === 'stub') return 'stub';
  throw new Error(`unrecognised SEARCH_ENGINE: ${env.SEARCH_ENGINE}`);
}

/**
 * What the stub answers with.
 *
 * THE DRAFT URL IS THE POINT OF THE FIXTURE. `/writing/type-specimen/` is
 * `draft: true` in src/content/posts/, so `src/lib/unindexed-routes.mjs` keeps
 * it out of the sitemap and `getCollection`'s published query does not return
 * it. #147's join has to DROP a result whose URL does not resolve to a
 * published document rather than render it with a guessed title, and a fixture
 * containing only publishable URLs gives that assertion nothing to bite on.
 *
 * SAYING WHAT IS AND IS NOT KNOWN ABOUT THE LIVE INDEX, because an earlier
 * version of this comment claimed the draft was simply "absent from the live
 * index" and that is a measurement rather than a guarantee. #145 queried the
 * instance once per sitemap URL at a threshold of 0.05 on 2026-09-17 and
 * reached exactly the twelve the sitemap lists and nothing else: no draft, no
 * `/fit` URL, no `/writing/pillar/*` page. What produced that set is the
 * instance's `parse_type: sitemap` and its path filter excluding `/fit`, both
 * configured in the Cloudflare dashboard, which this repository neither sets
 * nor can read. So the exclusion holds today and rests on something no test
 * here can see.
 *
 * #250 ADDED A THIRD DASHBOARD-ONLY SETTING THAT CAN CHANGE THAT SET, which is
 * the one to know about because it shrinks the index rather than growing it. A
 * content selector -- path `**`, selector `main` -- narrows each page to its
 * own `<main>`, and Cloudflare's documentation says a selector matching
 * nothing leaves empty markdown and marks the item errored. So a layout that
 * stopped rendering `<main>` would drop that page out of the index with no
 * build, test or deploy going red, and #145 measured that the job log reports
 * a clean batch through exactly this kind of per-item failure. That half IS
 * testable from here and tests/seo.test.ts now holds it: every page the
 * sitemap lists renders exactly one `<main>`.
 *
 * WHICH IS WHY THE JOIN IS THE AUTHORITATIVE GATE, as the epic says in its own
 * words. This endpoint is a public GET on its own origin and it applies no
 * publish check: it returns whatever the index named. The sitemap omission and
 * the path filter are the first two of the epic's three gates and both are
 * configuration; #147's `getCollection` join is the third and the only one
 * that lives in code a test can hold.
 *
 * The other two are real published URLs, so a stub answer still looks like an
 * answer: the shape a page renders is exercised rather than merely the shape a
 * parser accepts.
 */
export const SEARCH_STUB_RESULTS: readonly SearchResult[] = [
  {
    url: 'https://ryanlindsey.me/writing/armature/',
    excerpt: 'Armature is a Claude Code plugin for working a board across repositories.',
    score: 0.82,
  },
  {
    url: 'https://ryanlindsey.me/work/silent-failure/',
    excerpt: 'A control that was configured correctly, deployed correctly and enforced nothing.',
    score: 0.61,
  },
  {
    url: 'https://ryanlindsey.me/writing/type-specimen/',
    excerpt: 'A draft, which is why it is in this fixture and not in the sitemap.',
    score: 0.44,
  },
];
