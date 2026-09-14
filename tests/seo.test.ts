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
 * `index.html` only, so `dist/client/404.html` is not collected: it is an
 * error document rather than a page, and every sweep driven by `ALL_PAGES`
 * below is therefore structurally unable to assert anything about it -- not
 * merely choosing not to.
 *
 * TWO PLACES HANDLE IT SEPARATELY INSTEAD, each for its own reason and each
 * saying so where it lives (fix round 1, issue #153: an earlier version of
 * this paragraph claimed nothing in the file asserted anything about `/404`,
 * which stopped being true the moment the second of these two tests was
 * added). The sitemap/robots test names `/404` explicitly and exempts it from
 * Direction 2, because an error document served with a 404 status has nothing
 * there for a crawler to index and cannot satisfy the sitemap invariant.
 * `the 404 page title carries the site suffix too` fetches `/404` directly,
 * for the same structural reason this list cannot see it, rather than relying
 * on a sweep it is invisible to.
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

/** The `content` of every `<meta name="description">` on a commentless page. */
const metaDescriptions = (html: string): string[] =>
  [...html.matchAll(/<meta name="description" content="([^"]*)"/g)].map((match) => match[1]);

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

/**
 * Every INDEXABLE page's description is at least 70 characters (issue #152).
 *
 * THE BOUND IS A FLOOR, NOT A CEILING, and that is the decision this test
 * records. Google truncates a displayed description at roughly 155 to 160
 * characters, and six pages on this site are already past that -- the
 * reflex is an upper-bound assertion. Rejected: a description on this site
 * has more than one reader. An article's frontmatter `description` is also
 * what `/llms.txt`, `/llms-full.txt`, the feeds and the MCP `list_writing`
 * and `list_case_studies` tools render, `resume.basics.summary` is also the
 * `/llms.txt` blockquote and part of `/resume.md` and `/resume.json`, and
 * `policy.data.summary` is also rendered on `/ai-policy/` itself. Shortening
 * any of them to fit a display limit -- or truncating at render time, or
 * forking a second `metaDescription` field that agrees with `description`
 * until someone edits one and not the other -- trades the reader this site
 * optimizes for on purpose for the one it cannot control anyway, since
 * Google rewrites descriptions most of the time regardless. A floor catches
 * the failure that actually happened here: a page falling through to a
 * generic default rather than a page being too informative.
 *
 * 70 sits above every generic stub on the site today and below every
 * description written on purpose, with one exception.
 *
 * SCOPED TO INDEXABLE PAGES, derived from the page's own rendered
 * `<meta name="robots">` rather than hand-listed, for the reason `ALL_PAGES`
 * itself is walked rather than hand-listed: a hand-listed exemption list is
 * a list that silently stops covering the site the day a route's robots
 * value changes. The three `/writing/pillar/*` pages are `noindex, follow`
 * and repeat `WRITING_DESCRIPTION` verbatim below 70 characters, and that is
 * fine -- they are thin duplicates excluded from the sitemap, not documents
 * this bound is measuring.
 *
 * `/404` IS THE ONE EXCEPTION, and it needs no exemption clause here: a 404
 * has nothing to describe, "Nothing is published at that address." is
 * correct at 37 characters, and `builtPages` collects `index.html` only, so
 * `dist/client/404.html` is never in `ALL_PAGES` to begin with. Named here
 * only so the next reader does not add it.
 */
test('every indexable page carries a description of at least 70 characters', async () => {
  for (const path of ALL_PAGES) {
    const html = await page(path);
    const directives = robotsDirectives(html);

    // Only a page that asks to be indexed is held to this floor. `startsWith`
    // rather than an exact match, because the directive also carries `follow`
    // or `nofollow` (e.g. `index, follow`).
    if (!directives[0]?.startsWith('index')) {
      continue;
    }

    const descriptions = metaDescriptions(html);
    expect(descriptions, `${path} should carry exactly one description`).toHaveLength(1);
    expect(
      descriptions[0].length,
      `${path}'s description is ${descriptions[0].length} characters, want at least 70`,
    ).toBeGreaterThanOrEqual(70);
  }
});

/**
 * The site name suffix, asserted once against every page instead of trusted
 * to whichever template happens to build it (issue #153, epic #150).
 *
 * MEASURED against a clean build, 2026-09-13: `— Ryan Lindsey` was appended by
 * six different files (`src/layouts/ArticleLayout.astro`, the `/writing` and
 * `/work` index pages, `src/pages/ops.astro`, `src/pages/resume.astro` and
 * `src/pages/writing/pillar/[pillar].astro`) and forgotten by two
 * (`/ai-policy/`, whose title was bare, and `/chat/`, whose `Ask my agent` the
 * issue's own audit did not mention). Centralising it in
 * `src/layouts/Base.astro` is what makes it correct on every page without six
 * call sites having to agree.
 *
 * COUNTED, NOT MERELY MATCHED AT THE END (fix round 1, controller ruling).
 * `endsWith(' — Ryan Lindsey')` alone is satisfied by a DOUBLED tail --
 * "Resume — Ryan Lindsey — Ryan Lindsey" ends with the suffix too -- and that
 * blind spot is not hypothetical: `src/pages/resume.astro` and
 * `src/pages/writing/pillar/[pillar].astro` were the two of the six this
 * comment's first draft missed, found only in the later pass fix round 1
 * records, and both would have shipped exactly this doubled title had that
 * pass not caught them. The guard below exists because that already almost
 * happened, not because it might.
 */
test('every page title ends with the site suffix, or is exactly the site name', async () => {
  for (const path of ALL_PAGES) {
    const titles = [...(await page(path)).matchAll(/<title>([^<]*)<\/title>/g)].map(
      (match) => match[1],
    );
    const title = titles[0] ?? '';
    const carriesSuffix = title === 'Ryan Lindsey' || title.endsWith(' — Ryan Lindsey');
    expect(
      carriesSuffix,
      `${path} should end with " — Ryan Lindsey" or be exactly "Ryan Lindsey" -- got "${title}"`,
    ).toBe(true);

    // The home page is the one page that carries the suffix zero times (its
    // title is exactly the site name, asserted above); every other page
    // carries it exactly once, never doubled.
    const suffixCount = [...title.matchAll(/ — Ryan Lindsey/g)].length;
    const expectedSuffixCount = title === 'Ryan Lindsey' ? 0 : 1;
    expect(
      suffixCount,
      `${path} should carry the suffix exactly ${expectedSuffixCount} time(s), not doubled -- got "${title}"`,
    ).toBe(expectedSuffixCount);
  }
});

/**
 * `/404` NEEDS ITS OWN CHECK RATHER THAN A LINE IN `ALL_PAGES`, the same
 * reason the sitemap/robots test at the end of this file names it instead of
 * trusting the sweep to see it: `builtPages` collects `index.html` only (see
 * its own comment), and the 404 is `dist/client/404.html`, so the assertion
 * above cannot see this page at all -- it would stay green even if this
 * title lost its suffix entirely.
 */
test('the 404 page title carries the site suffix too', async () => {
  const response = await server.fetch('/no-such-page-for-title-check');
  expect(response.status, '/no-such-page-for-title-check should 404').toBe(404);
  const titles = [...stripComments(await response.text()).matchAll(/<title>([^<]*)<\/title>/g)].map(
    (match) => match[1],
  );
  expect(titles, '/404 should carry exactly one title').toHaveLength(1);
  // Not `path`-derived and never should be: src/pages/404.astro's own header
  // records why the requested path must not reach this response's markup.
  expect(titles[0], '/404 should carry the site suffix').toBe('404: Not found — Ryan Lindsey');
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
