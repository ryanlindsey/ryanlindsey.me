import { readdirSync, readFileSync } from 'node:fs';

/**
 * The routes that exist but must never enter the sitemap.
 *
 * Consumed by astro.config.mjs's `sitemap({ filter })`, which is why this is
 * `.mjs` and reads the filesystem directly: the config runs before the content
 * layer exists, so `getCollection` is not available to it. Same reason
 * heading-anchors.mjs is `.mjs` and imported the same way.
 *
 * FOUR SEPARATE REASONS A ROUTE IS EXCLUDED, and conflating them would be the
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
 * 3. THIN DUPLICATES. `/writing/pillar/<pillar>` is the writing index filtered
 *    to one of 02 §2's three pillars (2026-09 redesign, design 1h). Every row
 *    on it is a row on `/writing`, so the four pages are one page and three
 *    subsets of it, and a sitemap that offered all four would be asking a
 *    crawler to pick a canonical among near-identical documents. It carries
 *    `/writing`. The filtered routes exist because a chip has to be an address
 *    -- that is the whole reason they are routes and not a client-side toggle
 *    -- and being addressable is not the same as being worth indexing.
 *
 *    THE PAGES ALSO SAY `noindex, follow` THEMSELVES, and both halves are
 *    deliberate for the same reason reason 1 gives: neither is sufficient
 *    alone. A sitemap omission does not stop a crawler that followed a chip,
 *    and a `noindex` page still listed in a sitemap is a contradiction Search
 *    Console reports as one. `follow` rather than `nofollow`, because unlike a
 *    draft these pages link only published posts and are a fine path to them.
 *
 *    Revisit when a pillar carries enough posts to be a destination rather than
 *    a filter; it is one line here and one prop on the route.
 *
 * 4. RENDER SOURCES. `/resume.print` (issue #181) is not a page for a reader.
 *    It is a document that exists so a renderer can fetch the résumé over HTTP
 *    and print it, and every measurement in src/styles/resume-sheet.css was
 *    made on paper rather than on a screen. Nothing links to it and nobody is
 *    meant to arrive at it.
 *
 *    THIS IS NOT REASON 2. An unlisted page is a real page kept quiet -- `/fit`
 *    serves a form to a person holding a token. A render source has no audience
 *    at all: offering it to a crawler would publish a second, chromeless copy
 *    of `/resume`, which is the duplicate-content problem reason 3 describes
 *    with none of reason 3's excuse that the filtered view is worth addressing.
 *    It carries its own `noindex, nofollow` as well, for the reason reason 1
 *    gives about drafts: neither mechanism should ever be the only one.
 *
 * The draft half is derived from disk rather than hand-listed, so a new draft
 * is covered the day it lands rather than the day someone remembers this file.
 * The pillar half is a single prefix, which `isUnindexed` already extends to
 * everything beneath it, so a fourth pillar needs no edit here either.
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
 * slash. `/fit` covers `/fit/r/<id>` too, and `/writing/pillar` covers every
 * pillar beneath it -- see `isUnindexed`.
 *
 * `/writing/pillar` excludes the filtered indexes WITHOUT touching `/writing`
 * itself: `isUnindexed` matches a route exactly or as a path prefix, and
 * `/writing` is neither equal to nor beneath `/writing/pillar`.
 *
 * `/resume.print` leaves `/resume` alone by the same rule, and the dot is not
 * a suffix on the résumé's own route: the two are separate pathnames that
 * happen to share a prefix, and prefix matching here is on path SEGMENTS
 * (`${route}/`), so neither can ever swallow the other. MEASURED against the
 * build: `src/pages/resume.print.astro` emits
 * `dist/client/resume.print/index.html`, so the route is `/resume.print/` and
 * tests/seo.test.ts's `builtPages()` does collect it.
 */
export function unindexedRoutes() {
  const drafts = [
    ...draftSlugs(new URL('../content/posts/', import.meta.url)).map((slug) => `/writing/${slug}`),
    ...draftSlugs(new URL('../content/caseStudies/', import.meta.url)).map(
      (slug) => `/work/${slug}`,
    ),
  ];
  return ['/fit', '/writing/pillar', '/resume.print', ...drafts];
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
