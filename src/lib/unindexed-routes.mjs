import { readdirSync, readFileSync } from 'node:fs';

/**
 * The routes that exist but must never enter the sitemap.
 *
 * Consumed by astro.config.mjs's `sitemap({ filter })`, which is why this is
 * `.mjs` and reads the filesystem directly: the config runs before the content
 * layer exists, so `getCollection` is not available to it. Same reason
 * heading-anchors.mjs is `.mjs` and imported the same way.
 *
 * TWO SEPARATE REASONS A ROUTE IS EXCLUDED, and conflating them would be the
 * bug here:
 *
 * 1. DRAFTS. `src/pages/writing/[...slug].astro` deliberately gives every
 *    entry a route, drafts included -- "work in progress is shareable by URL
 *    without entering the site's navigation" (that file's own comment). A
 *    sitemap listing them would hand a crawler the exact thing that comment
 *    exists to prevent, so the draft's own `noindex` would be the only line of
 *    defence. It should not have to be the only one.
 *
 * 2. UNLISTED PAGES. `/fit` and `/fit/r/<id>` are unlisted by requirement
 *    (09 §1: absent from nav, sitemap and llms.txt) and carry their own
 *    `noindex, nofollow`. `/fit/r/<id>` additionally carries a scoped token in
 *    its URL, so a sitemap entry for it would publish the token itself.
 *
 * The draft half is derived from disk rather than hand-listed, so a new draft
 * is covered the day it lands rather than the day someone remembers this file.
 */

/** Frontmatter `draft: true`, read the same way tests/pages.test.ts reads it. */
function draftSlugs(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.mdx'))
    .filter((name) => {
      const source = readFileSync(new URL(name, dir), 'utf8');
      const frontmatterEnd = source.indexOf('\n---', 3);
      if (frontmatterEnd === -1) {
        throw new Error(`${name}: no closing frontmatter fence found`);
      }
      // Only the frontmatter block, so a `draft:` written in prose in the body
      // could never be mistaken for the key.
      return /\ndraft:\s*true\b/.test(source.slice(0, frontmatterEnd));
    })
    .map((name) => name.replace(/\.mdx$/, ''));
}

/**
 * Every path prefix the sitemap must skip, as pathnames with no trailing
 * slash. `/fit` covers `/fit/r/<id>` too -- see `isUnindexed`.
 */
export function unindexedRoutes() {
  const drafts = [
    ...draftSlugs(new URL('../content/posts/', import.meta.url)).map((slug) => `/writing/${slug}`),
    ...draftSlugs(new URL('../content/caseStudies/', import.meta.url)).map(
      (slug) => `/work/${slug}`,
    ),
  ];
  return ['/fit', ...drafts];
}

/**
 * Whether `url` is one of the above. Matches the route itself and anything
 * beneath it, so `/fit` excludes `/fit/r/<id>` without enumerating tokens --
 * which is the point, since those ids are generated, not known at build time.
 *
 * Trailing slashes are normalised away first: Astro emits sitemap entries as
 * absolute URLs with a trailing slash (`https://ryanlindsey.me/fit/`), and a
 * comparison that missed on the slash alone would fail open, which is the
 * wrong direction for a filter whose job is keeping documents out.
 */
export function isUnindexed(url, routes = unindexedRoutes()) {
  const path = new URL(url, 'https://ryanlindsey.me').pathname.replace(/\/+$/, '');
  return routes.some((route) => path === route || path.startsWith(`${route}/`));
}
