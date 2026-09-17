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
 *
 * WHAT IS NORMALISED IS THE TRAILING SLASH AND NOTHING ELSE, which is worth
 * writing down because the omissions look like oversights and two of them were
 * raised in review:
 *
 *   - PERCENT-ENCODING SURVIVES. `pathname` does not decode, so
 *     `/writing/arm%61ture/` misses the collection id and the result is
 *     dropped. Decoding here would mean deciding what to do with an encoded
 *     `/`, `.` or `..`, which is a path-traversal question this function has
 *     no reason to open when the alternative is one result fewer.
 *   - CASE SURVIVES. `/Writing/Armature/` misses for the same reason. Astro's
 *     routes are case-sensitive, so a lowercase match would render a row whose
 *     `href` differs from the URL the crawler actually saw.
 *
 * Both are the safe direction, and both are invisible rather than loud: a
 * crawler emitting either would look like an index returning fewer results.
 * Nothing has been observed emitting either, and #145's measurement of the live
 * instance found twelve keys, all lowercase and unencoded.
 *
 * THE ORIGIN IS DISCARDED, WHICH IS THE ONE OMISSION THAT IS A JUDGMENT RATHER
 * THAN A SAFE DEFAULT. A result naming `https://elsewhere.example/writing/armature/`
 * becomes a row whose href, title, date and reading time are all this site's
 * own, with only the excerpt coming from the foreign document. Enforcing the
 * origin was considered and not done: it costs two lines, but it makes a crawl
 * pointed at a staging hostname drop every result silently, and the condition
 * it defends against is an AI Search instance configured to crawl a domain the
 * owner does not control, which is a bigger problem than the excerpt it
 * produces. The excerpt is escaped either way (`highlight`). Left as a
 * deliberate gap rather than an unexamined one.
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
 * THE EXCERPT IS CLEANED HERE, once, for both row kinds. `excerptFrom` is what
 * turns a crawled markdown chunk into the sentence a row shows, and doing it in
 * the join rather than in the page means the truncation and the stripping are
 * asserted by the same tests that assert the drop rule, and a second renderer
 * could not forget them.
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
        excerpt: excerptFrom(result.excerpt),
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
      excerpt: excerptFrom(result.excerpt),
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
 * The longest excerpt a row renders.
 *
 * MATCHED TO THE HAND-WRITTEN DESCRIPTIONS the index rows carry, because this
 * sits in exactly the slot those occupy on `/writing` and `/work` and the
 * epic's argument is that a search result IS an index row. Two to three lines
 * at the row's `max-w-[64ch]` measure.
 */
export const EXCERPT_CHARS = 200;

/**
 * Everything the crawler keeps that a reader should never see.
 *
 * MEASURED AGAINST THE LIVE INSTANCE on 2026-09-17 rather than guessed at, and
 * every entry below is something that was actually rendered on the page before
 * this function existed. `ai_search`'s website source hands back page text as
 * markdown, so a chunk arrives carrying the document's YAML frontmatter fence,
 * the `Skip to content` link every page opens with, heading markers, list
 * bullets, table pipes, emphasis, and links in full `[text](target)` form.
 * Chunks ran 1,300 to 3,000 characters and the page printed all of it, so a
 * result row was a wall of syntax.
 *
 * STRIPPED RATHER THAN RENDERED, WHICH IS A SECURITY DECISION BEFORE IT IS A
 * VISUAL ONE. Parsing this into real HTML was the alternative and was rejected:
 * it would hand `set:html` markup derived from crawled third-party text, which
 * is the one thing this page is built not to do (see `highlight`), and it would
 * put headings, tables and lists inside a three-line row slot, which reads
 * worse rather than better. What a reader wants here is a sentence about the
 * page, and a sentence is what markdown syntax is in the way of.
 *
 * ORDER MATTERS AND IS ASSERTED. The fence goes before the link unwrapping, so
 * a `description:` containing brackets cannot leave fragments behind, and every
 * strip happens before the truncation, so the cap counts prose rather than
 * syntax. A document whose frontmatter alone is longer than `EXCERPT_CHARS`
 * would otherwise render an excerpt made entirely of frontmatter, which is the
 * exact shape the live `/work` chunk had.
 *
 * NOT A MARKDOWN PARSER, deliberately. This runs on every result of every
 * search and has to produce a paragraph, not a document tree; a parser would be
 * a dependency, a bundle cost and a far larger surface for a page whose whole
 * posture is that crawled text is data. What it cannot do is understood: a
 * literal asterisk in prose is removed with the emphasis markers, and a line
 * that merely looks like a table row is dropped. Both are acceptable in an
 * excerpt whose own contract (src/lib/search/engine.ts) is findability rather
 * than a verified passage.
 */
const STRIPS: ReadonlyArray<readonly [RegExp, string]> = [
  // The document's own frontmatter, which the crawler keeps as literal text.
  // Anchored to the start, because a `---` later in a page is a horizontal
  // rule and its text is real content.
  [/^\s*---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, ' '],
  // The skip link, which is the first thing inside every page's <body> and
  // therefore the first thing in a chunk taken from the top of one.
  [/\[Skip to content\]\([^)]*\)/g, ' '],
  // Images before links, since an image is a link with a `!` in front and the
  // link rule would otherwise leave the `!` and the alt text behind.
  [/!\[[^\]]*\]\([^)]*\)/g, ' '],
  // A link keeps its text and loses its target. An empty text is a heading
  // anchor -- `## Models[](#models)` -- and leaves nothing at all.
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  // A table row cannot be a sentence, so the whole line goes rather than its
  // pipes, which would otherwise run the cells together into a false one.
  [/^[ \t]*\|.*$/gm, ' '],
  [/^[ \t]{0,3}#{1,6}[ \t]+/gm, ''],
  [/^[ \t]*[-*+][ \t]+/gm, ''],
  [/^[ \t]*>[ \t]?/gm, ''],
  [/[*_`~]/g, ''],
];

/**
 * One chunk of crawled text, as the sentence a row shows.
 *
 * PLAIN TEXT OUT. Nothing here emits markup, and the result is handed to
 * `highlight`, which escapes every character of it before adding the only tags
 * this page writes. The two functions are the whole of the excerpt path and
 * neither trusts the input.
 *
 * TRUNCATED ON A WORD BOUNDARY, with the ellipsis closed up against the last
 * word rather than following a space, because a space before an ellipsis reads
 * as a missing word rather than as a continuation.
 *
 * TRAILING PUNCTUATION GOES WITH THE SPACE, for the same reason and MEASURED
 * ON THE LIVE INDEX: the first row of `?q=turnstile` cut after a full stop and
 * rendered "639 driver sessions.…", which reads as four dots rather than as a
 * sentence that continues. Whatever the cut lands on -- a stop, a comma, a
 * colon, a dash, the middle dot this site uses between metadata -- is
 * punctuation joining the excerpt to text nobody is going to see, so it goes.
 */
export function excerptFrom(chunk: string): string {
  let text = chunk;
  for (const [pattern, replacement] of STRIPS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length <= EXCERPT_CHARS) return text;

  const cut = text.lastIndexOf(' ', EXCERPT_CHARS);
  // A single word longer than the cap has no boundary to cut on, so the hard
  // cut is the fallback rather than the rule.
  const kept = text.slice(0, cut === -1 ? EXCERPT_CHARS : cut);
  return `${kept.replace(/[\s.,;:!?·\u2013\u2014-]+$/, '')}…`;
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
