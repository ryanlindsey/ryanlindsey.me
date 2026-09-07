import { getRssString, type RSSFeedItem } from '@astrojs/rss';
import { byPublishedDesc } from './llms-index';
import {
  canonicalUrlFor,
  stripNonPortableMdx,
  toMarkdown,
  type ExportableEntry,
} from './markdown-export';

// Day 3 Task 11 (02 §3): the pure half of `/rss.xml` and `/feed.json`, same
// split as src/lib/llms-index.ts and for the same reason -- `astro:content`
// only resolves inside Astro's own build/dev pipeline, so keeping the actual
// feed-building here (with only a type-only `ExportableEntry` import) is
// what lets tests/pages.test.ts unit-test a populated fixture directly,
// rather than only ever asserting today's real, all-draft, empty output
// (task-11-brief.md's own "fooled eight times" warning).
//
// `@astrojs/rss`'s `getRssString` has no `astro:content` dependency of its
// own -- it is a plain function over zod, fast-xml-parser and piccolore
// (verified: `node_modules/@astrojs/rss/dist/index.js` imports only those
// three plus its own schema/util modules) -- so calling it from here, not
// from the route, is safe and keeps src/pages/rss.xml.ts as thin as
// src/pages/llms.txt.ts.
//
// src/pages/rss.xml.ts and feed.json.ts are the thin, impure routes that
// call `getCollection`/`getResume` and hand the results (plus `context.site`)
// to the functions here.

/**
 * Feed-wide metadata the calling route supplies. `site` is deliberately a
 * parameter, not read from astro.config.mjs or the `SITE_ORIGIN` constant in
 * markdown-export.ts -- task-11-brief.md is explicit that `/rss.xml` must
 * take `site` from the endpoint context (`context.site`), which is the one
 * live source `@astrojs/rss` itself recommends
 * (`node_modules/@astrojs/rss/dist/index.d.ts`'s own doc comment on
 * `RSSOptions.site`). Passing it in here rather than importing it keeps this
 * module runnable under a plain `vitest run` process with no Astro config
 * loaded, same reasoning as markdown-export.ts's `SITE_ORIGIN` comment.
 */
export interface RssFeedMeta {
  title: string;
  description: string;
  site: string | URL;
}

/**
 * Appended to the channel `<description>`, and the second half of the
 * decision `rssItemFor` documents below.
 *
 * `<content:encoded>` conventionally carries HTML and feed readers render it
 * as HTML; what this feed puts there is Markdown source. Publishing the first
 * two case studies made that live, which is what tests/pages.test.ts's RSS
 * tripwire existed to force. The choice taken was to keep Markdown and say so
 * here rather than to render MDX to HTML outside an Astro page render, which
 * in Astro 7 means reaching for the container API (astro.config.mjs's own note
 * on `markdown.processor`: there is no remark pipeline to borrow).
 *
 * This is a disclosure, not a fix. A subscriber still sees literal `##` and
 * `**bold**`; the difference is that the feed now says which format it is
 * handing them instead of implying HTML and shipping something else. If a
 * human subscriber ever complains, that is the signal to spend the container
 * API's cost -- and until one does, the readers this site is actually
 * publishing for read `content_text` in `/feed.json` or the `.md` routes,
 * where Markdown is the correct answer rather than a disclosed compromise.
 */
export const RSS_MARKDOWN_NOTICE = 'Full-content items carry Markdown source, not HTML.' as const;

/** Newest first, matching every other feed/index on this site. */
function sortedEntries(entries: ExportableEntry[]): ExportableEntry[] {
  return [...entries].sort(byPublishedDesc);
}

/**
 * One entry's RSS item. `description` carries the frontmatter one-liner (the
 * excerpt a feed reader shows in a list view); `content` carries the FULL
 * article body -- 02 §3's "full-content, not summaries" rule is about which
 * field holds the whole article, not a ban on also having a short excerpt.
 * `@astrojs/rss` maps `content` to the `<content:encoded>` element (RSS's own
 * full-content extension).
 *
 * WHY THIS IS `stripNonPortableMdx`, NOT `toMarkdown`. `toMarkdown` returns
 * `---\n<yaml>\n---\n\n<body>`, so every item built from it opened with a
 * literal YAML frontmatter block -- 100% of items, not an edge case. In a
 * field feed readers render as HTML that is a duplicate of metadata the item
 * already carries in its own `<title>`, `<link>`, `<description>` and
 * `<pubDate>` elements, dumped on the subscriber as text. So the body alone
 * goes here. The frontmatter block stays in `jsonFeedItemFor`'s
 * `content_text` below, where the whole document is the point and no reader
 * is trying to render it.
 *
 * The Markdown that remains -- `##` headings, `**bold**`, fenced code, and
 * `[text](url)` links -- is DISCLOSED rather than removed.
 * `<content:encoded>` conventionally carries HTML and readers render it as
 * HTML, so a subscriber still sees literal `##` where a heading belongs. What
 * makes that acceptable is that every one of those degrades LOSSLESSLY: a
 * link's URL is still there in the text to read or copy, so the reader is
 * given no less than they would have been, only less styling.
 * `RSS_MARKDOWN_NOTICE` above holds that decision, what it costs, and what
 * would justify paying the container API's price instead. This is DIFFERENT
 * from `jsonFeedItemFor`'s `content_text` below, which IS the textually
 * correct field for markdown in JSON Feed 1.1 (its own spec's distinction
 * between `content_text` and `content_html`) -- RSS 2.0 has no equivalent
 * "this is plain text, not HTML" field to move it to, which is why the
 * disclosure has to live in the channel description.
 *
 * Publishing the first two case studies is what made this live and what
 * fired tests/pages.test.ts's RSS tripwire, exactly as that test was built
 * to do. The tripwire did not go away with the decision: it narrowed to the
 * one thing that must never appear in this field again, a frontmatter fence,
 * and keeps its own arming assertion so it cannot pass vacuously. Its paired
 * test asserts the disclosed markdown really is present, so the notice cannot
 * quietly become a false statement either.
 *
 * `stripNonPortableMdx` THROWS if a component tag survives MDX stripping
 * outside code (markdown-export.ts's module doc) -- deliberately left to
 * propagate, and unaffected by this call no longer going through
 * `toMarkdown`, since the throw was always this function's rather than its
 * caller's: a corrupted feed item belongs in a failed build, not a
 * silently-shipped feed, same reasoning as buildLlmsFullTxt in llms-index.ts.
 */
function rssItemFor(entry: ExportableEntry): RSSFeedItem {
  return {
    title: entry.data.title,
    link: canonicalUrlFor(entry),
    description: entry.data.description,
    pubDate: entry.data.publishedAt,
    content: stripNonPortableMdx(entry.body ?? ''),
  };
}

/**
 * The full `/rss.xml` document, RSS 2.0, via `@astrojs/rss`. Verified
 * (scratch script against `getRssString` directly) that zero items produces
 * a well-formed `<rss version="2.0"><channel>...</channel></rss>` with no
 * `<item>` element at all -- not a malformed document. That is no longer
 * what actually ships (the first case studies are published), but it stays
 * guaranteed: unpublishing everything must degrade to an empty channel
 * rather than to a broken one.
 *
 * `RSS_MARKDOWN_NOTICE` is appended to the channel description HERE rather
 * than in src/pages/rss.xml.ts, so the disclosure travels with the code that
 * creates the thing being disclosed. The route keeps passing the résumé
 * summary unmodified -- one reused summary, not a hand-written fourth copy
 * (that route's own note) -- and cannot forget the notice or drift from it.
 */
export async function buildRssFeed(entries: ExportableEntry[], meta: RssFeedMeta): Promise<string> {
  return getRssString({
    title: meta.title,
    description: `${meta.description} ${RSS_MARKDOWN_NOTICE}`,
    site: meta.site,
    items: sortedEntries(entries).map(rssItemFor),
  });
}

/**
 * JSON Feed 1.1 (jsonfeed.org/version/1.1) -- hand-built rather than pulling
 * in a second dependency (task-11-brief.md Step 2): the shape is small and
 * has been stable since 1.1 shipped. Only the fields this site actually has
 * data for are included; JSON Feed makes every field but `version`, `title`
 * and `items` optional, so there is no "no empty scaffolding" tension here
 * the way llms-index.ts's `buildSection` has to manage for headings.
 */
export interface JsonFeedItem {
  id: string;
  url: string;
  title: string;
  /** The frontmatter one-liner -- JSON Feed's own short-excerpt field. */
  summary: string;
  /**
   * The FULL document via `toMarkdown()` -- 02 §3's "full-content, not
   * summaries" rule. `content_text`, not `content_html`: `toMarkdown()`
   * produces portable markdown, not rendered HTML (same fact
   * markdown-export.ts's module doc gives for why it exists at all), and
   * JSON Feed's own spec draws that line for exactly this case --
   * `content_text` is "the plain text of the item, for a version of the
   * item that contains no HTML".
   */
  content_text: string;
  date_published: string;
  date_modified?: string;
}

export interface JsonFeed {
  version: 'https://jsonfeed.org/version/1.1';
  title: string;
  description: string;
  home_page_url: string;
  feed_url: string;
  items: JsonFeedItem[];
}

export interface JsonFeedMeta {
  title: string;
  description: string;
  /** `new URL('/', context.site).href` -- see RssFeedMeta's `site` note. */
  homePageUrl: string;
  /** `new URL('/feed.json', context.site).href`. */
  feedUrl: string;
}

function jsonFeedItemFor(entry: ExportableEntry): JsonFeedItem {
  const item: JsonFeedItem = {
    // The canonical URL doubles as `id`: JSON Feed only requires an item id
    // be a stable, opaque string, and a URL that will not change (this
    // site's own canonical, per markdown-export.ts) satisfies that without
    // inventing a second identifier.
    id: canonicalUrlFor(entry),
    url: canonicalUrlFor(entry),
    title: entry.data.title,
    summary: entry.data.description,
    content_text: toMarkdown(entry),
    date_published: entry.data.publishedAt.toISOString(),
  };
  if (entry.data.updatedAt) {
    item.date_modified = entry.data.updatedAt.toISOString();
  }
  return item;
}

/**
 * The full `/feed.json` document. Zero entries still produces a
 * well-formed JSON Feed -- `items: []` is valid JSON Feed (the spec
 * requires the key to be present and an array, not that it be non-empty) --
 * matching `buildRssFeed`'s empty-channel guarantee above.
 */
export function buildJsonFeed(entries: ExportableEntry[], meta: JsonFeedMeta): JsonFeed {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: meta.title,
    description: meta.description,
    home_page_url: meta.homePageUrl,
    feed_url: meta.feedUrl,
    items: sortedEntries(entries).map(jsonFeedItemFor),
  };
}
