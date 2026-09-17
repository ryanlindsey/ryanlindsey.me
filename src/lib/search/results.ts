import type { SearchResult, SearchType } from './engine';
import { SEARCHABLE_PAGES, type SearchablePage } from './pages';

/**
 * The join (issue #147, epic #143): what turns the URLs, excerpts and scores
 * `GET /search` returns into the rows `src/pages/search.astro` renders.
 *
 * THIS IS THE EPIC'S THIRD GATE AND THE ONLY ONE THAT LIVES IN CODE. The other
 * two are configuration on the AI Search instance -- a sitemap that omits
 * drafts, `/fit` and the thin pillar duplicates, and a path filter excluding
 * `/fit` -- both set in the Cloudflare dashboard, which this repository
 * neither writes nor can read (src/lib/search/engine.ts's
 * `SEARCH_STUB_RESULTS` records the measurement and its limits). So a draft
 * that reached the index through a regressed sitemap filter, or a bot
 * following a link, arrives here as an ordinary result. What stops it is that
 * `joinResults` is handed the collection query's own output, drafts already
 * filtered, and a URL it does not find there produces nothing.
 *
 * DROPPED, NEVER GUESSED, and the difference is the guarantee rather than a
 * preference. A row rendered from the result alone would need a title, and the
 * only title available is crawled text; a page that guesses is a page that
 * publishes a draft's headline the moment the crawl gets ahead of the sitemap.
 * `src/lib/mcp/search.ts` follows the same rule from the other side, returning
 * `null` for a vector id it does not recognise: an unrecognised result is
 * dropped and the rest of the search still answers.
 *
 * PURE, AND THAT IS WHY THE DOCUMENTS ARE A PARAMETER. `getCollection` needs
 * `astro:content`, which only resolves inside Astro's own build, so a module
 * that called it could not be exercised by a plain Vitest run --
 * src/lib/case-study-figures.ts records the same constraint for the same
 * reason. The route reads the collections and hands the result down.
 */

/**
 * One published document, as the route's `getCollection` call describes it.
 *
 * `kind` comes from WHICH COLLECTION the entry was read from rather than from
 * its URL. `typeFor` in src/lib/search/engine.ts guesses from the path because
 * the handler has nothing else to guess from, and it must: it filters results
 * before anything has been joined. Here the answer is known, so it is read
 * rather than derived, and the two cannot disagree about `/writing/` the index
 * versus `/writing/armature/` the post.
 */
export interface SearchDocument {
  /** Site-relative, no trailing slash: `/writing/armature`. */
  path: string;
  title: string;
  publishedAt: Date;
  readingMinutes: number;
  kind: Extract<SearchType, 'writing' | 'work'>;
}

/**
 * One row the page renders.
 *
 * `publishedAt` and `readingMinutes` are `null` for a page rather than absent,
 * because the left column of the row has to decide between two treatments --
 * a date and a reading time for a document, the path for a page -- and an
 * optional property makes "this is a page" and "somebody forgot to set it"
 * the same value.
 */
export interface SearchRow {
  href: string;
  title: string;
  excerpt: string;
  kind: SearchType;
  publishedAt: Date | null;
  readingMinutes: number | null;
}

/** How many rows each chip on the page stands for. */
export interface SearchCounts {
  all: number;
  writing: number;
  work: number;
  page: number;
}

/**
 * The site-relative path a result URL names, or `null` if it is not a URL.
 *
 * THE TRAILING SLASH IS THE POINT. #145 measured `item.key` as a full absolute
 * URL carrying one (`https://ryanlindsey.me/writing/armature/`), and every
 * path this repository writes down -- a collection id, `NAV_LINKS`,
 * `SEARCHABLE_PAGES` -- carries none. Comparing the two without normalising
 * matches nothing at all, which would drop every result and look exactly like
 * an index that returned nothing.
 *
 * `null` rather than a throw, for the reason `typeFor` gives about the same
 * value: `item.key` comes off the crawler, and one measurement on one day is
 * not a guarantee. A key that cannot be read is one result fewer, not a page
 * that fails to render.
 */
export function pathOf(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The results that resolve to something published, in the order they arrived.
 *
 * THE ORDER IS THE INDEX'S. `resultsFrom` already sorted by score and deduped
 * to one row per URL, so re-ranking here would be this page inventing an
 * opinion about relevance that nothing measured. #148 owns ranking.
 *
 * DEDUPED AGAIN ANYWAY, on the normalised path rather than on the raw key.
 * Upstream's dedupe is per URL string, so `…/ops/` and `…/ops` survive it as
 * two entries and would render as two identical rows. Nothing has been
 * observed emitting both; this costs a `Set` and removes the question.
 */
export function joinResults(
  results: readonly SearchResult[],
  documents: readonly SearchDocument[],
  pages: readonly SearchablePage[] = SEARCHABLE_PAGES,
): SearchRow[] {
  const byPath = new Map<string, SearchDocument>(documents.map((doc) => [doc.path, doc]));
  const pageByPath = new Map<string, SearchablePage>(pages.map((page) => [page.path, page]));

  const rows: SearchRow[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const path = pathOf(result.url);
    if (path === null || seen.has(path)) continue;

    const document = byPath.get(path);
    if (document !== undefined) {
      seen.add(path);
      rows.push({
        href: path,
        title: document.title,
        excerpt: result.excerpt,
        kind: document.kind,
        publishedAt: document.publishedAt,
        readingMinutes: document.readingMinutes,
      });
      continue;
    }

    const page = pageByPath.get(path);
    if (page === undefined) continue;

    seen.add(path);
    rows.push({
      href: page.path,
      title: page.title,
      excerpt: result.excerpt,
      kind: 'page',
      publishedAt: null,
      readingMinutes: null,
    });
  }

  return rows;
}

/**
 * The chip counts.
 *
 * COUNTED AFTER THE JOIN, never before, and that is what makes them exact for
 * what is shown. A count taken from the index's own results would include
 * every URL the join is about to drop, so a query matching one draft would
 * offer a `Writing 3` chip leading to two rows.
 */
export function countRows(rows: readonly SearchRow[]): SearchCounts {
  return {
    all: rows.length,
    writing: rows.filter((row) => row.kind === 'writing').length,
    work: rows.filter((row) => row.kind === 'work').length,
    page: rows.filter((row) => row.kind === 'page').length,
  };
}

/**
 * The rows one chip shows.
 *
 * FILTERED FROM THE SAME JOINED SET THE COUNTS WERE TAKEN FROM, so a chip
 * click costs no index query and no cache read: the page asks the handler for
 * the unfiltered results and every chip is a view of them. That is the site
 * half of the arrangement `filterByType` describes in
 * src/lib/search/engine.ts, and the same reasoning applies -- `kind` is a
 * property of the row, so filtering after the join gives exactly what
 * filtering during it would.
 */
export function filterRows(rows: readonly SearchRow[], kind: SearchType | null): SearchRow[] {
  if (kind === null) return [...rows];
  return rows.filter((row) => row.kind === kind);
}

/** The five characters that could turn crawled text into markup. */
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/**
 * The shortest query term worth marking.
 *
 * A single character matches inside most words on the page, so `?q=a` would
 * render an excerpt that is more `<mark>` than text and tell a reader nothing
 * about why the row matched. Two is the shortest term anybody searches for on
 * purpose.
 */
const MIN_MARKED_TERM = 2;

/**
 * The excerpt, escaped, with the query's terms marked.
 *
 * THE ONLY FUNCTION IN THIS REPOSITORY THAT HANDS `set:html` A STRING BUILT
 * FROM CRAWLED TEXT, so the order of operations below is the security
 * property rather than an implementation detail. Every character of the
 * excerpt is escaped; the ONLY unescaped bytes in the result are the `<mark>`
 * tags this function writes itself.
 *
 * SEGMENTED FIRST, THEN ESCAPED, and the obvious spelling is wrong in a way
 * that looks right. Escaping the whole excerpt and then running the term
 * regex over the escaped copy would let a query term match inside an entity:
 * a search for `amp` would mark the middle of `&amp;` and emit
 * `&<mark>amp</mark>;`, which renders as literal `&amp;` to the reader and,
 * worse, means the regex is being run against bytes this function produced
 * rather than against the text. Splitting the RAW excerpt on the terms and
 * escaping each piece keeps the match against real text and keeps the escape
 * over every byte of it.
 *
 * THE TERMS ARE THE QUERY'S OWN WORDS, sorted longest first so a query like
 * `rate rate-limiter` marks the longer phrase rather than stranding `-limiter`
 * outside a mark. They are escaped for the regex, not for HTML: they are
 * matched against text and never emitted -- what is emitted is the slice of
 * the excerpt they matched, escaped with everything else.
 *
 * LINEAR, WITH NO CATASTROPHIC BACKTRACKING AVAILABLE: the pattern is an
 * alternation of literal strings with no nesting and no quantifier, and
 * `normalizeQuery` caps the query at 100 characters, so there are at most a
 * few dozen branches.
 *
 * NOT `<em>`, NOT A BACKGROUND WASH. `<mark>` is the element HTML has for
 * "relevant in the current context", which is exactly what this is, and
 * src/styles/global.css sets it as accent ink with an accent underline --
 * never a highlighter block, which would be the one thing on this site that
 * glows (src/styles/tokens.css's first paragraph).
 */
export function highlight(excerpt: string, query: string): string {
  const terms = query
    .split(/\s+/)
    .filter((term) => term.length >= MIN_MARKED_TERM)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (terms.length === 0) return escapeHtml(excerpt);

  const pattern = new RegExp(`(${terms.join('|')})`, 'gi');
  return excerpt
    .split(pattern)
    .map((piece, index) =>
      index % 2 === 1 ? `<mark>${escapeHtml(piece)}</mark>` : escapeHtml(piece),
    )
    .join('');
}
