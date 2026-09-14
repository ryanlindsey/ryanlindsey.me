/**
 * The invariants every page's `<head>` carries, asserted across the whole site
 * at once (issue #151, epic #150).
 *
 * WHY THIS IS NOT MORE OF tests/pages.test.ts. That file is organised by page --
 * this page has this header, that page has that footer -- which is the right
 * axis for what it asserts. These run the other way: one rule, every page. A
 * reader asking "what does this site guarantee about every `<head>`?" should
 * find one file that answers it rather than a grep across two thousand lines.
 *
 * Every assertion here runs against RENDERED OUTPUT fetched through the
 * harness, never against the source of `src/layouts/Base.astro`. A test that
 * greps the layout for the string `canonical` passes on a layout that renders
 * the tag into a comment.
 *
 * All five assertions below already held when this file was written. That is
 * the point rather than a weakness: the file exists so that #152, #153 and #154
 * each have somewhere to add an assertion that fails first. What makes it worth
 * committing today is the last test, which is the only thing in the repository
 * that checks the sitemap and the robots tags against each other.
 */
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { stripComments } from './markup';
import { isUnindexed } from '../src/lib/unindexed-routes.mjs';

// See ./workers.ts for why the site Worker is booted from the build output and
// why the MCP Worker is always listed with it.
const server = createTestHarness({
  workers: SITE_HARNESS_WORKERS,
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

/** The origin every canonical and every sitemap entry is written against. */
const SITE = 'https://ryanlindsey.me';

/**
 * Every page fetched here is scanned COMMENTLESS, and that is load-bearing
 * rather than tidy.
 *
 * This codebase writes long HTML comments into its own pages, and it has
 * already been bitten once by exactly this: `src/layouts/Base.astro` used to
 * ship a comment containing the word "noindex", which was enough to keep two
 * `toContain('noindex')` assertions green against a page that had just become
 * indexable (that file's own comment records it). Counting `<meta name="robots">`
 * or `<link rel="canonical">` occurrences in raw markup has the same failure in
 * the other direction: a comment that mentions the tag inflates the count and
 * fails a page that is correct.
 */
const page = async (path: string): Promise<string> => {
  const response = await server.fetch(path);
  expect(response.status, `${path} should be 200`).toBe(200);
  return stripComments(await response.text());
};

/**
 * Every static page the build produced, as pathnames with a trailing slash.
 *
 * Walked out of the build output rather than hand-listed. A hand-listed array
 * is a list that silently stops covering the site the day a route is added,
 * which is the failure this whole epic exists to close -- and a suite that
 * asserts a site-wide rule against a stale subset of the site is worth less
 * than no suite at all, because it reads as coverage.
 *
 * `index.html` only, so `dist/client/404.html` is not collected: it is an error
 * document rather than a page. Nothing in this file asserts anything about it,
 * deliberately -- see the last test for why an error document cannot satisfy
 * the sitemap invariant and should not be made to.
 */
function builtPages(dir: URL, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...builtPages(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    } else if (entry.name === 'index.html') {
      found.push(`/${prefix}`);
    }
  }
  return found;
}

/**
 * The routes that render on demand and therefore leave no `index.html` for
 * `builtPages` to find (`export const prerender = false`). Listed by hand
 * because there is nothing on disk to derive them from, and kept short on
 * purpose: if this list grows past a handful, derive it from the route files
 * instead.
 *
 * Trailing slashes, to match the sitemap's own spelling of these two. Both
 * answer at either spelling, which is a defect rather than a convenience --
 * see the canonical test below, which records it.
 *
 * `/fit` IS NOT HERE, and its absence is written down because it looks like
 * exactly the oversight this file exists to prevent. A tokenless `/fit` is a
 * deliberate 404 rather than a page: 09 §1 says an unlisted page must not
 * announce itself to someone holding the URL but not the token, so it 404s
 * rather than 403s, and tests/fit-pages.test.ts asserts that in those words.
 * There is no page there to carry a canonical or a robots directive, and
 * minting a scoped token to reach one would pull the whole tier fixture into a
 * suite about `<head>` tags. `/fit`'s own `noindex, nofollow` is asserted where
 * a granted token already exists, in tests/fit-pages.test.ts.
 */
const ON_DEMAND_PAGES = ['/chat/', '/ops/'];

const ALL_PAGES = [
  ...builtPages(new URL('../dist/client/', import.meta.url)),
  ...ON_DEMAND_PAGES,
].sort();

/** Every `<loc>` in the served sitemap, as pathnames. */
async function sitemapPaths(): Promise<string[]> {
  const response = await server.fetch('/sitemap-0.xml');
  expect(response.status, '/sitemap-0.xml should be 200').toBe(200);
  const xml = await response.text();
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  expect(locations.length, 'the sitemap should list at least one URL').toBeGreaterThan(0);
  return locations.map((url) => new URL(url).pathname).sort();
}

/** The `content` of every `<meta name="robots">` on a commentless page. */
const robotsDirectives = (html: string): string[] =>
  [...html.matchAll(/<meta name="robots" content="([^"]*)"/g)].map((match) => match[1]);

/**
 * A FINDING THIS TEST DOES NOT YET CATCH, recorded here so it is not
 * rediscovered as a surprise (measured 2026-09-13, through this harness).
 *
 * A prerendered page normalises its own canonical: `/resume` and `/resume/`
 * both answer with `https://ryanlindsey.me/resume/`, because the tag was baked
 * in at build time. The two ON_DEMAND_PAGES do not. They render per request
 * from `Astro.url.pathname`, so `/chat` answers `.../chat` and `/chat/`
 * answers `.../chat/` -- two live URLs for one page, each declaring itself
 * canonical, which is the one thing a canonical exists to prevent. The sitemap
 * advertises the trailing-slash spelling while the site's own navigation links
 * the bare one, so both are reachable by a crawler.
 *
 * Not fixed here: this issue adds no `src/` change, and the fix is a decision
 * about which spelling wins. The assertion below is self-referential and
 * therefore passes at either spelling, so it does not paper over the problem;
 * it simply cannot see it. Filed for its own issue.
 */
test('every page carries exactly one canonical, absolute and pointing at itself', async () => {
  for (const path of ALL_PAGES) {
    const html = await page(path);
    const hrefs = [...html.matchAll(/<link rel="canonical" href="([^"]*)"/g)].map(
      (match) => match[1],
    );

    // Exactly one, not merely at least one. A layout that renders the tag twice
    // is the regression a presence check cannot see, and two canonicals is the
    // same as none: a crawler picks one or ignores both.
    expect(hrefs, `${path} should carry exactly one canonical`).toHaveLength(1);

    // Pointing at ITSELF. A canonical naming a different page is the failure
    // actually worth catching here -- it is how a page removes itself from
    // search while still rendering a tag that looks correct.
    expect(hrefs[0], `${path} should canonicalise to its own URL`).toBe(`${SITE}${path}`);
  }
});

test('every page carries exactly one robots directive', async () => {
  for (const path of ALL_PAGES) {
    const directives = robotsDirectives(await page(path));
    // `src/layouts/Base.astro` renders this tag unconditionally, so a page
    // carrying two has been handed a second one somewhere else -- and when the
    // two disagree, which one wins is a crawler's choice rather than this
    // site's.
    expect(directives, `${path} should carry exactly one robots directive`).toHaveLength(1);
  }
});

test('every page carries exactly one non-empty title', async () => {
  for (const path of ALL_PAGES) {
    const titles = [...(await page(path)).matchAll(/<title>([^<]*)<\/title>/g)].map(
      (match) => match[1],
    );
    expect(titles, `${path} should carry exactly one title`).toHaveLength(1);
    expect(titles[0].trim(), `${path} should carry a non-empty title`).not.toBe('');
  }
});

test('every JSON-LD block on every page parses and declares the schema.org context', async () => {
  for (const path of ALL_PAGES) {
    const blocks = [
      ...(await page(path)).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    ].map((match) => match[1]);

    // Every page carries at least the sitewide Person node, so an empty result
    // means the block stopped rendering rather than that this page has none.
    expect(blocks.length, `${path} should carry at least one JSON-LD block`).toBeGreaterThan(0);

    for (const [index, block] of blocks.entries()) {
      // THIS IS THE `</script>` BREAKOUT CHECK, and parsing is what makes it
      // one. `stringifyJsonLd` escapes every `<` so that a headline containing
      // a literal closing script tag cannot end the element early, and
      // tests/structured-data.test.ts asserts that on the function -- but
      // nothing verified the escape survived into a rendered page. If it ever
      // stops, the non-greedy match above ends at the injected tag exactly as a
      // browser's parser would, and this parse throws on the truncation.
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(block);
      }, `${path} JSON-LD block ${index} should be valid JSON`).not.toThrow();

      expect(
        (parsed as { '@context'?: string })['@context'],
        `${path} JSON-LD block ${index} should declare the schema.org context`,
      ).toBe('https://schema.org');
    }
  }
});

/**
 * The one genuinely new invariant in this file, and the reason it is worth
 * committing before anything in #152, #153 or #154 lands.
 *
 * Keeping a draft out of search rests on two independent mechanisms by design:
 * the `robots` prop on the page, and the sitemap filter in
 * `src/lib/unindexed-routes.mjs`. That file's own header argues for both, on
 * the grounds that neither should ever be the only defence. Nothing checked
 * that the two still AGREE with each other, and they can drift apart in either
 * direction without a single existing test going red:
 *
 *   - A page dropped from the filter but still `noindex` puts a contradiction
 *     in front of a crawler, which Search Console reports as an error.
 *   - A page that loses its `noindex` while staying out of the sitemap is a
 *     document that is indexable by any crawler that finds a link to it, with
 *     nothing left to stop it.
 */
test('the sitemap and the robots tags never contradict each other', async () => {
  const listed = await sitemapPaths();

  // EVERY violation is collected and asserted once at the end, rather than each
  // being its own `expect` inside the loop. A site-wide rule wants a site-wide
  // answer: the first spelling of this test died on the first bad URL and said
  // nothing about the other four, which turns fixing a drift into one rebuild
  // per offending page.
  const problems: string[] = [];

  // Direction 1: nothing advertised for indexing is missing or refuses to be
  // indexed. The 200 check is not scaffolding for the noindex check below it --
  // a sitemap that advertises a URL which does not resolve is its own defect,
  // and it is the shape the filter regression below actually takes.
  for (const path of listed) {
    const response = await server.fetch(path);
    if (response.status !== 200) {
      problems.push(`${path} is in the sitemap but answers ${response.status}`);
      continue;
    }
    const directives = robotsDirectives(stripComments(await response.text()));
    if (directives[0]?.includes('noindex')) {
      problems.push(`${path} is in the sitemap but says "${directives[0]}"`);
    }
  }

  // Direction 2: nothing that refuses to be indexed is advertised, and
  // everything the filter excludes really does refuse.
  //
  // `/404` is exempt from this direction and needs to be. It is an error
  // document rather than a page: it is absent from the sitemap, correctly, and
  // it carries the permissive default, also correctly, because a 404 is served
  // with a 404 status and there is nothing there for a crawler to index. It is
  // not collected by `builtPages` and is named here only so the next reader
  // does not add it.
  for (const path of ALL_PAGES) {
    const excluded = isUnindexed(`${SITE}${path}`);
    const directives = robotsDirectives(await page(path));

    if (excluded) {
      if (listed.includes(path)) {
        problems.push(`${path} is filtered out of the sitemap but appears in it anyway`);
      }
      if (!directives[0]?.includes('noindex')) {
        problems.push(
          `${path} is filtered out of the sitemap but says "${directives[0]}" rather than noindex`,
        );
      }
    } else if (directives[0]?.includes('noindex')) {
      problems.push(`${path} says "${directives[0]}" but is not filtered out of the sitemap`);
    }
  }

  expect(problems, `the sitemap and the robots tags disagree:\n${problems.join('\n')}`).toEqual([]);
});
