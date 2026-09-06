import { getRssString, type RSSFeedItem } from '@astrojs/rss';
import { byPublishedDesc } from './llms-index';
import { canonicalUrlFor, toMarkdown, type ExportableEntry } from './markdown-export';

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

/** Newest first, matching every other feed/index on this site. */
function sortedEntries(entries: ExportableEntry[]): ExportableEntry[] {
  return [...entries].sort(byPublishedDesc);
}

/**
 * One entry's RSS item. `description` carries the frontmatter one-liner (the
 * excerpt a feed reader shows in a list view); `content` carries the FULL
 * document via `toMarkdown()` -- 02 §3's "full-content, not summaries" rule
 * is about which field holds the whole article, not a ban on also having a
 * short excerpt. `@astrojs/rss` maps `content` to the `<content:encoded>`
 * element (RSS's own full-content extension), so a reader that only shows
 * `<description>` still gets an honest excerpt rather than the entire
 * document crammed into the summary slot.
 *
 * `toMarkdown` THROWS if a component tag survives MDX stripping outside code
 * (markdown-export.ts's module doc) -- deliberately left to propagate: a
 * corrupted feed item belongs in a failed build, not a silently-shipped feed,
 * same reasoning as buildLlmsFullTxt in llms-index.ts.
 */
function rssItemFor(entry: ExportableEntry): RSSFeedItem {
  return {
    title: entry.data.title,
    link: canonicalUrlFor(entry),
    description: entry.data.description,
    pubDate: entry.data.publishedAt,
    content: toMarkdown(entry),
  };
}

/**
 * The full `/rss.xml` document, RSS 2.0, via `@astrojs/rss`. Verified
 * (scratch script against `getRssString` directly) that zero items produces
 * a well-formed `<rss version="2.0"><channel>...</channel></rss>` with no
 * `<item>` element at all -- not a malformed document -- which is exactly
 * what ships today, since every real content entry is `draft: true`
 * (task-11-brief.md's "thing that will ship wrong if you are not careful").
 */
export async function buildRssFeed(entries: ExportableEntry[], meta: RssFeedMeta): Promise<string> {
  return getRssString({
    title: meta.title,
    description: meta.description,
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
