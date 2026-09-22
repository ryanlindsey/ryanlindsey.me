/**
 * The invariants every page carries for the machines that read it, asserted
 * across the whole site at once (issue #151, epic #150).
 *
 * `<head>` WAS THE WHOLE SCOPE UNTIL #250, and the widening is one rule rather
 * than a new axis: the last test in this file is about `<body>` structure,
 * because the AI Search crawler's content selector reads the body and a page
 * that stops matching it leaves the index silently. Same question either way
 * -- what does this site guarantee to something that fetches every page? --
 * so it belongs beside the canonical, robots and sitemap sweeps rather than in
 * a file of its own.
 *
 * WHY THIS IS NOT MORE OF tests/pages.test.ts. That file is organised by page --
 * this page has this header, that page has that footer -- which is the right
 * axis for what it asserts. These run the other way: one rule, every page. A
 * reader asking "what does this site guarantee about every page?" should find
 * one file that answers it rather than a grep across two thousand lines.
 *
 * Every assertion here runs against RENDERED OUTPUT fetched through the
 * harness, never against the source of `src/layouts/Base.astro`. A test that
 * greps the layout for the string `canonical` passes on a layout that renders
 * the tag into a comment.
 *
 * The five assertions this file shipped with already held when it was
 * written. That is the point rather than a weakness: the file exists so that
 * #152, #153 and #154 each have somewhere to add an assertion that fails
 * first. What made it worth committing was the sitemap/robots test --
 * `the sitemap and the robots tags never contradict each other`, below --
 * the only thing in the repository that checks the sitemap and the robots
 * tags against each other.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { elementWith, stripComments } from './markup';
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
 * Trailing slashes, to match the sitemap's own spelling. All three answer at
 * either spelling, which is a defect rather than a convenience -- see the
 * canonical test below, which records it.
 *
 * `/search` IS HERE ALTHOUGH IT IS `noindex`, and that is the whole reason
 * this list matters for it. The sweeps below check what a page CLAIMS about
 * itself and whether the sitemap agrees, not whether it may be indexed; the
 * contradiction test at the bottom of this file is the only thing in the repo
 * that holds `src/lib/unindexed-routes.mjs`'s new `/search` entry and the
 * route's own `noindex, follow` to each other. tests/search-page.test.ts
 * asserts each of those separately, which is two facts rather than the
 * agreement between them. The description floor exempts it along with every
 * other non-indexable page.
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
const ON_DEMAND_PAGES = ['/chat/', '/ops/', '/search/'];

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

/** Every `content` of every `<meta>` whose `attr` equals `key`, in document order. */
const metaContents = (html: string, attr: 'property' | 'name', key: string): string[] =>
  [...html.matchAll(/<meta\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => tag.includes(`${attr}="${key}"`))
    .map((tag) => /\bcontent="([^"]*)"/.exec(tag)?.[1] ?? '');

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
 * value changes. Measured against this branch's build, the exemption covers
 * exactly one page below the floor: `/writing/type-specimen/`, a draft that
 * renders `noindex, nofollow` and repeats its own 55-character frontmatter
 * description, a specimen no crawler reads. The three `/writing/pillar/*`
 * pages are `noindex, follow` and share `WRITING_DESCRIPTION` with
 * `/writing/`, but this commit rewrote that constant to 107 characters, so
 * all three clear the floor on their own now; they stay out of this test's
 * scope because they are `noindex`, not because they need the exemption.
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

/**
 * Issue #154 (epic #150): give the sitemap a `lastmod` from the content the
 * site already validates, rather than the bare `<loc>` every one of the
 * twelve entries carried before this test was written.
 *
 * Every expected value below is read off disk the same frontmatter-only way
 * tests/pages.test.ts already reads `draft` and `pillar` -- through
 * `readFileSync` against the raw `.mdx`/`.yaml`/`.md` source, never through
 * `astro:content`. That is not a style preference carried over from that
 * file: `src/lib/sitemap-lastmod.mjs`, which this test exercises indirectly
 * through the built sitemap, MUST read the same way, because
 * `astro.config.mjs` runs before the content layer exists and `getCollection`
 * is not available inside it. A test that computed its expectations through
 * `getCollection` would therefore be checking the implementation against a
 * data source the implementation itself is forbidden from using.
 */

/**
 * `updatedAt ?? publishedAt` for every PUBLISHED post or case study in `dir`,
 * as the ISO 8601 string `src/content.config.ts`'s `z.coerce.date()` plus
 * `.toISOString()` produces -- not the bare `YYYY-MM-DD` frontmatter spelling,
 * because that coercion is exactly what the schema already does to these two
 * fields and the sitemap has to serve the same value, not a prettier one.
 *
 * Draft entries are skipped rather than mapped to `undefined`: a draft never
 * reaches the sitemap at all (the filter the previous test in this file
 * checks), so there is no `lastmod` here to assert a value against.
 */
function articleLastmods(dir: URL): Map<string, string> {
  const dates = new Map<string, string>();
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.mdx'))) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    const frontmatterEnd = source.indexOf('\n---', 3);
    if (frontmatterEnd === -1) {
      throw new Error(`${name}: no closing frontmatter fence found`);
    }
    const frontmatter = source.slice(0, frontmatterEnd);
    if (/\ndraft:\s*true\b/.test(frontmatter)) continue;

    // Anchored the same way src/lib/sitemap-lastmod.mjs's copy of this pattern
    // is anchored, and for the same reason: unanchored, it matches only the
    // date prefix of a `publishedAt: 2026-09-12T14:30:00Z` spelling and
    // silently drops the time, which this test's character-identical regex
    // would then reproduce and stay green on, rather than catching it.
    const publishedAt = /\npublishedAt:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m.exec(
      frontmatter,
    )?.[1];
    const updatedAt = /\nupdatedAt:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m.exec(frontmatter)?.[1];
    if (!publishedAt) {
      throw new Error(`${name}: no publishedAt found in frontmatter`);
    }
    dates.set(name.replace(/\.mdx$/, ''), new Date(updatedAt ?? publishedAt).toISOString());
  }
  return dates;
}

/**
 * Every URL the built sitemap should carry a `lastmod` for, mapped to the
 * exact string it should carry. `/writing/<slug>/` and `/work/<slug>/` come
 * from the coerced `Date` fields above. `/resume/` and `/ai-policy/` are set
 * below, separately -- `src/content.config.ts` already types those two as bare
 * `YYYY-MM-DD` strings (`isoDate`) rather than coerced `Date`s, and the value
 * asserted for them is NOT that bare string; see the comment at the point
 * they are added for the measured reason why.
 */
const DATED_ROUTES = new Map<string, string>([
  ...[...articleLastmods(new URL('../src/content/posts/', import.meta.url))].map(
    ([slug, date]): [string, string] => [`/writing/${slug}/`, date],
  ),
  ...[...articleLastmods(new URL('../src/content/caseStudies/', import.meta.url))].map(
    ([slug, date]): [string, string] => [`/work/${slug}/`, date],
  ),
]);

const resumeYamlSource = readFileSync(
  new URL('../src/content/resume/ryan-lindsey.yaml', import.meta.url),
  'utf8',
);
const resumeLastModified = /^\s*lastModified:\s*'(\d{4}-\d{2}-\d{2})'\s*$/m.exec(
  resumeYamlSource,
)?.[1];
if (!resumeLastModified) {
  throw new Error('ryan-lindsey.yaml: no meta.lastModified found');
}

const aiPolicySource = readFileSync(new URL('../governance/ai-policy.md', import.meta.url), 'utf8');
// Same anchored pattern tests/pages.test.ts's `policyUpdated` already uses to
// read this file, so both readers of this one field agree on its shape.
const aiPolicyUpdated = /^updated:\s*'?(\d{4}-\d{2}-\d{2})'?\s*$/m.exec(aiPolicySource)?.[1];
if (!aiPolicyUpdated) {
  throw new Error('ai-policy.md: no updated date found in frontmatter');
}

// Both of these read as PLAIN `YYYY-MM-DD` here, matching what
// src/lib/sitemap-lastmod.mjs's `resumeLastmod`/`aiPolicyLastmod` return --
// but the value asserted below is widened to a full timestamp, and that is
// the served artifact talking rather than a mistake in either of those
// functions. `@astrojs/sitemap` 3.7.4 pipes every `lastmod`, from whatever
// `serialize` returns, through the `sitemap` package's `normalizeURL`, which
// unconditionally runs it through `new Date(x).toISOString()` before writing
// the XML -- the stream flag that would keep a date-only string date-only
// (`lastmodDateOnly`) exists one layer down but `@astrojs/sitemap` never sets
// it and does not expose it. Measured 2026-09-13 against the built
// `sitemap-0.xml`: the two source functions above return unwidened strings,
// and the XML shows the widened ones below regardless. Asserting the bare
// string here would be asserting a value this artifact cannot produce today
// -- exactly what "assert the artifact, not the source" rules out.
DATED_ROUTES.set('/resume/', new Date(resumeLastModified).toISOString());
DATED_ROUTES.set('/ai-policy/', new Date(aiPolicyUpdated).toISOString());

/**
 * Assembled from other content, with no date of their own that would not be a
 * guess (task-3-brief.md's table). `/writing/pillar/<pillar>` and `/fit` are
 * not listed: neither reaches the sitemap at all, so there is no `lastmod` on
 * either for this test to find present or absent.
 */
const DATELESS_ROUTES = ['/', '/writing/', '/work/', '/chat/', '/ops/'];

/** Every `<url>` entry in the served sitemap, as `{ path, lastmod }`. */
async function sitemapEntries(): Promise<{ path: string; lastmod?: string }[]> {
  const response = await server.fetch('/sitemap-0.xml');
  expect(response.status, '/sitemap-0.xml should be 200').toBe(200);
  const xml = await response.text();
  const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]);
  expect(blocks.length, 'the sitemap should list at least one URL').toBeGreaterThan(0);
  return blocks.map((block) => {
    const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
    if (!loc) {
      throw new Error(`sitemap <url> block has no <loc>: ${block}`);
    }
    return {
      path: new URL(loc).pathname,
      lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(block)?.[1],
    };
  });
}

test('every dated URL in the sitemap carries a lastmod traceable to its own content, and no URL is stamped with the build date', async () => {
  const entries = await sitemapEntries();
  const byPath = new Map(entries.map((entry) => [entry.path, entry.lastmod]));
  const problems: string[] = [];

  // Every article, the résumé and the AI policy: the sitemap's lastmod must be
  // the exact value their own frontmatter produces, not merely present.
  for (const [path, expected] of DATED_ROUTES) {
    const actual = byPath.get(path);
    if (actual === undefined) {
      problems.push(`${path} should carry lastmod ${expected} but has none`);
    } else if (actual !== expected) {
      problems.push(`${path} lastmod is ${actual}, expected ${expected} from its own frontmatter`);
    }
  }

  // The index and aggregation pages: no date of their own, so no field at all
  // -- `lastmod` is optional per entry in the sitemap protocol, and omitting
  // it is the honest answer task-3-brief.md asks for.
  for (const path of DATELESS_ROUTES) {
    const actual = byPath.get(path);
    if (actual !== undefined) {
      problems.push(`${path} has no date of its own but carries lastmod ${actual}`);
    }
  }

  // THE TRAP THIS ISSUE IS ABOUT, checked independently of the two loops
  // above: a build-time `new Date()` fallback stamps EVERY url with today's
  // date, which would slip past both loops for any route this file has not
  // enumerated by hand (a route added after this test was written, say, or a
  // typo in one of the two lists above that happens to still read as absent).
  // A `lastmod` landing on today's date is legitimate only when DATED_ROUTES
  // itself says today is the right answer -- true today for `/resume/`,
  // coincidentally, which is exactly why this checks the recorded expectation
  // rather than merely refusing every match against "today".
  const today = new Date().toISOString().slice(0, 10);
  for (const { path, lastmod } of entries) {
    if (lastmod?.startsWith(today) && DATED_ROUTES.get(path) !== lastmod) {
      problems.push(
        `${path} carries today's build date (${lastmod}) with no content of its own that says so`,
      );
    }
  }

  expect(problems, `sitemap lastmod values disagree with content:\n${problems.join('\n')}`).toEqual(
    [],
  );
});

/**
 * The markup the AI Search content selector stands on (issue #250, epic #143),
 * asserted here rather than in tests/search-page.test.ts because this is a
 * fact about what a crawler is served rather than about what `/search` does
 * with it.
 *
 * The instance carries one content selector entry -- path `**`, selector
 * `main` -- so what is indexed from a crawled page is that page's `<main>`
 * element and nothing else.
 *
 * WHAT THAT ACTUALLY BUYS IS THE SKIP LINK, and the first draft of this
 * comment claimed the header and the footer with it. They were already gone:
 * Cloudflare's default pipeline removes `<header>`, `<footer>` and `<head>`
 * before converting, and #145 measured exactly that against this instance --
 * "the header nav and the whole footer are absent from every chunk". The skip
 * link survived because it is a bare `<a>` sitting in `<body>` ahead of the
 * header, which no default rule names. So the selector's delta is that one
 * line plus anything else a layout ever puts outside `<main>` that is not
 * header, footer or head.
 *
 * ONE LINE IS WORTH A SELECTOR BECAUSE OF WHAT RERANKING DOES TO IT. Measured
 * against the live instance on 2026-09-17: `skip to content` returned ten
 * pages scoring 0.8565 to 0.9545. #250 and #148 both record eight, and both
 * are right for when they were written -- #249 raised `max_num_results` from
 * ten to twenty in between, so more of the same answer comes back now. The
 * score range is identical to four decimals either way. Chrome present in
 * every document matching confidently against every document is the shape,
 * and the count is how much of it fits in a response.
 *
 * WHAT MAKES THE CONFIGURATION FRAGILE is not the selector, which is one
 * word. It is that a page whose markup stops matching it is not an error
 * anybody sees. Cloudflare's own documentation is explicit: "If a CSS
 * selector does not match any elements on a page, the resulting Markdown is
 * empty and AI Search marks the item as errored." So a layout change that
 * renamed `<main>` would break no build, no test and no deploy -- it would
 * quietly empty that page out of the index. #145 already measured that the
 * job log cannot see this class of failure either: it reported
 * `Batch: 12 fetched, 12 queued, 0 errored, 0 skipped` and `12 files seen`
 * on runs where a file failed to embed, and the dashboard's Items tab was the
 * only place it showed.
 *
 * SCOPED TO THE SITEMAP rather than to `ALL_PAGES`, because the sitemap IS
 * the crawler's input (`parse_type: sitemap`) and therefore exactly the set
 * the selector has to hold for. That is also the only scope that passes:
 * `/resume.print/` bypasses Shell.astro deliberately (see its own header) and
 * renders no `<main>` at all, so an `ALL_PAGES` sweep would fail today on a
 * page no crawler is ever offered.
 *
 * FOUR ASSERTIONS RATHER THAN ONE, because three of the four ways this breaks
 * leave the fourth green:
 *
 *   - EXACTLY ONE `<main>`, not at least one, for the reason the canonical
 *     sweep above gives about its own tag: a second one matches the selector
 *     too and the crawler would index both.
 *   - THE PAGE'S `<h1>` INSIDE IT, which is what makes this about content
 *     rather than about a tag. An empty `<main>` next to a redesign that moved
 *     the page body out of it satisfies every structural check here and
 *     indexes nothing, which is the same silent emptying the paragraph above
 *     is about.
 *   - THE SKIP LINK PRESENT, spelled exactly. A pure absence check passes
 *     against a link that was deleted or relabelled, and that is not a
 *     hypothetical blind spot: `excerptFrom` in src/lib/search/results.ts
 *     keeps a rule matching this literal for an instance rebuilt without the
 *     selector, and nothing else in the repo pins the words --
 *     tests/pages.test.ts anchors on `href="#main"` and its own comment
 *     records the same trap from the other side.
 *   - AND OUTSIDE `<main>`, which is the position the selector relies on.
 */
test('every page the sitemap lists carries the markup the content selector needs', async () => {
  // COLLECTED AND ASSERTED ONCE, like the two sitemap sweeps above rather than
  // like the older `ALL_PAGES` ones: a rule about the whole crawled set wants
  // an answer about the whole crawled set. A per-page `expect` reports the
  // first page a redesign broke and hides whether it broke one or all twelve,
  // which is the difference between a typo and a layout change.
  const problems: string[] = [];

  for (const path of await sitemapPaths()) {
    const html = await page(path);

    const opens = [...html.matchAll(/<main\b/g)].length;
    if (opens !== 1) {
      problems.push(`${path} renders ${opens} <main> elements, want exactly 1`);
      // Nothing below can be read off a page with no main or two of them, and
      // `elementWith` would throw rather than report the path.
      continue;
    }

    const main = elementWith(html, 'main', 'id="main"');

    const headings = [...main.matchAll(/<h1\b/g)].length;
    if (headings !== 1) {
      problems.push(`${path} renders ${headings} <h1> inside <main>, want exactly 1`);
    }

    if (!html.includes('Skip to content')) {
      problems.push(`${path} renders no "Skip to content" link`);
    } else if (main.includes('Skip to content')) {
      problems.push(`${path} carries the skip link inside <main>, where the selector keeps it`);
    }
  }

  expect(
    problems,
    `the content selector's markup contract is broken:\n${problems.join('\n')}`,
  ).toEqual([]);
});

/**
 * The share card (#363), on EVERY page rather than every indexable one:
 * Base.astro emits these tags unconditionally, and a link shared from a draft
 * or from /fit unfurls exactly as any other does. Each image is fetched back
 * through the harness, because a tag naming a 404 renders as a blank preview
 * and nothing else in the suite would notice.
 */
test('every page names one absolute, sized, described share image that is served', async () => {
  for (const path of ALL_PAGES) {
    const html = await page(path);
    const images = metaContents(html, 'property', 'og:image');
    expect(images, `${path} og:image`).toHaveLength(1);
    const image = new URL(images[0]);
    expect(image.origin, `${path} og:image must be absolute on the site`).toBe(SITE);
    expect(image.pathname, `${path} og:image`).toMatch(/^\/og\/.+\.[0-9a-f]{8}\.png$/);
    expect(metaContents(html, 'property', 'og:image:width'), path).toEqual(['1200']);
    expect(metaContents(html, 'property', 'og:image:height'), path).toEqual(['630']);
    const alt = metaContents(html, 'property', 'og:image:alt');
    expect(alt, `${path} og:image:alt`).toHaveLength(1);
    expect(alt[0].trim(), `${path} og:image:alt`).not.toBe('');
    expect(metaContents(html, 'name', 'twitter:card'), path).toEqual(['summary_large_image']);
    const served = await server.fetch(image.pathname);
    expect(served.status, `${path} names ${image.pathname}`).toBe(200);
    expect(served.headers.get('content-type'), image.pathname).toMatch(/^image\/png/);
  }
});

test('posts and case studies are shared as articles, every other page as a website', async () => {
  const article = /^\/(writing|work)\/(?!pillar\/)[^/]+\/$/;
  for (const path of ALL_PAGES) {
    const html = await page(path);
    expect(metaContents(html, 'property', 'og:type'), path).toEqual([
      article.test(path) ? 'article' : 'website',
    ]);
  }
});

test('the share tags agree with the page they are on', async () => {
  for (const path of ALL_PAGES) {
    const html = await page(path);
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    expect(metaContents(html, 'property', 'og:title'), path).toEqual([title]);
    expect(metaContents(html, 'property', 'og:description'), path).toEqual(metaDescriptions(html));
    expect(metaContents(html, 'property', 'og:url'), path).toEqual([new URL(path, SITE).href]);
    expect(metaContents(html, 'property', 'og:site_name'), path).toEqual(['Ryan Lindsey']);
  }
});
