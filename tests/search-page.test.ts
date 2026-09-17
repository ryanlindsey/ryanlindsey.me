import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { SEARCHABLE_PAGES } from '../src/lib/search/pages';
import {
  countRows,
  EXCERPT_CHARS,
  excerptFrom,
  filterRows,
  highlight,
  joinResults,
  pathOf,
  type SearchDocument,
} from '../src/lib/search/results';
import { SEARCH_STUB_RESULTS } from '../src/lib/search/engine';
import { isUnindexed, unindexedRoutes } from '../src/lib/unindexed-routes.mjs';
import { BANNED_PATTERNS } from './candidacy-patterns';
import { LIMITS } from '../src/lib/mcp/limits';
import { elementWith } from './markup';

/**
 * `/search` (issue #147, epic #143): the results page.
 *
 * TWO HALVES, AND THE FIRST ONE CARRIES THE GUARANTEE. The join, the drop rule
 * and the counts are pure and take no bindings, so they are asserted directly
 * below. The page is then booted in the harness against the `SEARCH_ENGINE:
 * 'stub'` fixture the MCP Worker serves (see src/lib/search/engine.ts's
 * `SEARCH_STUB_RESULTS`), whose third entry deliberately names a DRAFT so the
 * drop rule has something real to bite on end to end.
 *
 * What no test here sees is a real retrieval, a real ranking or a real
 * excerpt; tests/mcp-site-search.test.ts says the same about its own half and
 * for the same reason. The live round trip is verified by hand.
 */

const documents: SearchDocument[] = [
  {
    path: '/writing/armature',
    title: 'Armature',
    publishedAt: new Date('2026-08-01T00:00:00Z'),
    readingMinutes: 7,
    kind: 'writing',
  },
  {
    path: '/work/silent-failure',
    title: 'The silent failure',
    publishedAt: new Date('2026-06-12T00:00:00Z'),
    readingMinutes: 4,
    kind: 'work',
  },
];

const result = (url: string, excerpt = 'some crawled text', score = 0.5) => ({
  url,
  excerpt,
  score,
});

describe('the path a result URL names', () => {
  test('strips the origin and the trailing slash the crawler adds', () => {
    expect(pathOf('https://ryanlindsey.me/writing/armature/')).toBe('/writing/armature');
  });

  test('is null for a key that is not an absolute URL', () => {
    expect(pathOf('writing/armature')).toBeNull();
  });
});

describe('the join', () => {
  test('cleans the crawled chunk on its way into the row', () => {
    const rows = joinResults(
      [
        result(
          'https://ryanlindsey.me/writing/armature/',
          '---\ndescription: x\n---\n\n[Skip to content](#main)\n\n## Armature\n\nA plugin.',
        ),
      ],
      documents,
    );

    expect(rows[0]?.excerpt).toBe('Armature A plugin.');
  });

  test('gives a published post its own date and reading time', () => {
    const rows = joinResults([result('https://ryanlindsey.me/writing/armature/')], documents);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      href: '/writing/armature',
      title: 'Armature',
      kind: 'writing',
      readingMinutes: 7,
    });
    expect(rows[0]?.publishedAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  test('drops a URL naming a draft, because a draft is not in the collection query', () => {
    // The fixture's own draft, rather than an invented URL: this is the exact
    // value the stub serves, so the assertion here and the page's below are
    // about the same result.
    const draft = SEARCH_STUB_RESULTS[2];
    expect(draft?.url).toContain('/writing/type-specimen/');
    expect(joinResults([result(draft!.url)], documents)).toHaveLength(0);
  });

  test('gives a known page a row carrying its path and no date', () => {
    const rows = joinResults([result('https://ryanlindsey.me/ops/')], documents);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ href: '/ops', title: 'Ops', kind: 'page' });
    expect(rows[0]?.publishedAt).toBeNull();
    expect(rows[0]?.readingMinutes).toBeNull();
  });

  test('drops a URL resolving to neither a document nor a known page', () => {
    expect(joinResults([result('https://ryanlindsey.me/nothing-here/')], documents)).toHaveLength(
      0,
    );
  });

  test('keeps the order the scores arrived in', () => {
    const rows = joinResults(
      [
        result('https://ryanlindsey.me/ops/', 'a', 0.9),
        result('https://ryanlindsey.me/writing/armature/', 'b', 0.8),
      ],
      documents,
    );

    expect(rows.map((row) => row.href)).toEqual(['/ops', '/writing/armature']);
  });

  test('renders one row per page even if two keys normalise to it', () => {
    const rows = joinResults(
      [result('https://ryanlindsey.me/ops/'), result('https://ryanlindsey.me/ops')],
      documents,
    );

    expect(rows).toHaveLength(1);
  });
});

describe('the counts and the filter', () => {
  const rows = joinResults(
    [
      result('https://ryanlindsey.me/writing/armature/'),
      result('https://ryanlindsey.me/work/silent-failure/'),
      result('https://ryanlindsey.me/ops/'),
      result('https://ryanlindsey.me/ai-policy/'),
    ],
    documents,
  );

  test('count what survived the join rather than what the index returned', () => {
    expect(countRows(rows)).toEqual({ all: 4, writing: 1, work: 1, page: 2 });
  });

  test('a filter narrows to one kind', () => {
    expect(filterRows(rows, 'page').map((row) => row.href)).toEqual(['/ops', '/ai-policy']);
  });

  test('no filter is every row', () => {
    expect(filterRows(rows, null)).toHaveLength(4);
  });
});

describe('the excerpt', () => {
  test('wraps a matched term in a mark', () => {
    expect(highlight('Turnstile verifies the token.', 'turnstile')).toBe(
      '<mark>Turnstile</mark> verifies the token.',
    );
  });

  test('escapes crawled text, so nothing in it can become markup', () => {
    expect(highlight('<script>alert(1)</script>', 'alert')).toBe(
      '&lt;script&gt;<mark>alert</mark>(1)&lt;/script&gt;',
    );
  });

  test('escapes the text around a match rather than only the match', () => {
    expect(highlight('a & token', 'token')).toBe('a &amp; <mark>token</mark>');
  });

  test('a query term that is regex syntax is matched literally', () => {
    expect(highlight('the (parenthesis) here', '(parenthesis)')).toBe(
      'the <mark>(parenthesis)</mark> here',
    );
  });

  test('ignores a one-character term, which would mark half the excerpt', () => {
    expect(highlight('a token', 'a')).toBe('a token');
  });

  test('marks every term of a multi-word query', () => {
    expect(highlight('the rate limiter', 'rate limiter')).toBe(
      'the <mark>rate</mark> <mark>limiter</mark>',
    );
  });
});

describe('the excerpt, before it is marked', () => {
  test('drops the frontmatter fence the crawler picked up', () => {
    expect(excerptFrom('---\ndescription: A case study.\n---\n\nThe real opening line.')).toBe(
      'The real opening line.',
    );
  });

  test('drops the skip link every page opens with', () => {
    expect(excerptFrom('[Skip to content](#main)\n\nThe real opening line.')).toBe(
      'The real opening line.',
    );
  });

  test("keeps a link's text and discards its target", () => {
    expect(excerptFrom('Built on [Cloudflare](https://www.cloudflare.com) throughout.')).toBe(
      'Built on Cloudflare throughout.',
    );
  });

  test('drops an empty heading anchor rather than leaving its brackets', () => {
    expect(excerptFrom('## Models[](#models)\n\nChat runs on Sonnet.')).toBe(
      'Models Chat runs on Sonnet.',
    );
  });

  test('drops heading markers, bullets and emphasis', () => {
    expect(excerptFrom('## Evals\n\n* **Chat** runs on `sonnet`.')).toBe(
      'Evals Chat runs on sonnet.',
    );
  });

  test('drops a markdown table, which cannot be a paragraph', () => {
    expect(
      excerptFrom('Suites:\n\n| Suite | Pass |\n| --- | --- |\n| chat | 4/4 |\n\nAfter.'),
    ).toBe('Suites: After.');
  });

  test('collapses the whitespace a stripped block leaves behind', () => {
    expect(excerptFrom('One.\n\n\nTwo.   Three.')).toBe('One. Two. Three.');
  });

  test('truncates to the cap, on a word boundary, with an ellipsis', () => {
    const long = 'word '.repeat(80).trim();
    const excerpt = excerptFrom(long);

    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS + 1);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).not.toMatch(/\s…$/);
  });

  test('does not butt the ellipsis against sentence punctuation', () => {
    // Rendered against the live index, the first row read "639 driver
    // sessions.…", which reads as four dots rather than as a continuation.
    const text = `${'word '.repeat(38)}sentences. ${'tail '.repeat(20)}`;
    const excerpt = excerptFrom(text);

    expect(excerpt).toMatch(/sentences…$/);
    expect(excerpt).not.toContain('.…');
  });

  test('leaves a short excerpt alone, with no ellipsis', () => {
    expect(excerptFrom('Short enough.')).toBe('Short enough.');
  });

  test('strips before it truncates, so the cap counts prose rather than syntax', () => {
    // The fence alone is longer than the cap. Truncating first would leave an
    // excerpt made entirely of frontmatter.
    const fence = `---\ndescription: ${'x'.repeat(EXCERPT_CHARS)}\n---\n\nThe real opening line.`;
    expect(excerptFrom(fence)).toBe('The real opening line.');
  });
});

describe('the sitemap', () => {
  test('excludes /search, because a query-driven page is not a document', () => {
    expect(unindexedRoutes()).toContain('/search');
    expect(isUnindexed('https://ryanlindsey.me/search/')).toBe(true);
  });
});

describe('the page', () => {
  const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

  beforeAll(async () => {
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  /**
   * EVERY CALL GETS ITS OWN ADDRESS, and the trap this avoids had already been
   * measured one issue earlier.
   *
   * This page forwards `cf-connecting-ip` to the MCP Worker, so a request
   * carrying none keys `site-search:unknown`, whose capacity is
   * `LIMITS.inference.limit` -- ten. The limiter sits in front of the cache, so
   * a repeated query still spends a token. This block issues more than ten
   * query-bearing requests in under a second, and the bucket refills by nothing
   * in that time.
   *
   * WHAT THAT COST BEFORE IT WAS FIXED IS THE REASON THE NOTE IS THIS LONG. The
   * failures were not merely flaky: the last three tests in source order were
   * reading the UNAVAILABLE page and passing against it, because that page also
   * carries no `<script>` and no candidacy vocabulary. So the candidacy sweep,
   * whose entire job is scanning the results and empty states, was scanning
   * neither. A shuffled run then failed four times in five, on assertions that
   * read as a limiter bug rather than as an exhausted allowance.
   *
   * tests/mcp-site-search.test.ts carries the same counter and records the same
   * measurement from the other side of the service binding. A counter rather
   * than a constant, so a test added in the middle cannot silently share a
   * bucket with one added at the end, and TEST-NET-1 rather than the blocks
   * that suite uses, so the two files stay readable side by side.
   */
  let addresses = 0;
  const fetchPage = async (path: string): Promise<string> => {
    addresses += 1;
    return fetchFrom(path, `192.0.2.${addresses % 200}`);
  };

  const fetchFrom = async (path: string, address: string): Promise<string> => {
    const response = await server.fetch(path, {
      headers: { 'cf-connecting-ip': address },
    });
    // A refused search still renders a page. The far side's `429` is the
    // page's unavailable STATE, not the page's status, which is the whole
    // reason this route holds the rendering and the MCP Worker holds the
    // limiter.
    expect(response.status).toBe(200);
    return response.text();
  };

  test('is never indexed', async () => {
    const html = await fetchPage('/search');
    expect(html).toMatch(/<meta name="robots" content="noindex, follow"\s*\/?>/);
  });

  test('offers the form and says what is searchable when there is no query', async () => {
    const html = await fetchPage('/search');
    const form = elementWith(html, 'form', 'data-search-form');

    expect(form).toContain('action="/search"');
    expect(form).toContain('method="get"');
    expect(form).toContain('name="q"');
    expect(html).toContain('data-search-landing');
    expect(html).not.toContain('data-search-row');
  });

  /**
   * The rows alone.
   *
   * SCOPED RATHER THAN SEARCHED FOR ACROSS THE WHOLE RESPONSE, and that is a
   * measurement rather than caution. `not.toContain('/writing/armature')`
   * against the full page failed while the filter was working perfectly: the
   * site header ships a long HTML comment that names that path. tests/markup.ts
   * records the same trap from two earlier issues, and every assertion below
   * about what is and is not rendered goes through here.
   */
  const rowsOf = (html: string): string => elementWith(html, 'ul', 'data-search-results');

  test('renders a row for every stub result that resolves to something published', async () => {
    const rows = rowsOf(await fetchPage('/search?q=armature'));

    // Two of the fixture's three URLs are published; the third is a draft.
    expect(rows.match(/data-search-row/g)).toHaveLength(2);
    expect(rows).toContain('/writing/armature');
    expect(rows).toContain('/work/silent-failure');
    expect(rows).not.toContain('type-specimen');
  });

  test('sets a short query as the page headline', async () => {
    const html = await fetchPage('/search?q=armature');
    expect(elementWith(html, 'h1', 'data-search-heading')).toContain('text-display');
  });

  test('steps the headline down a size for a query too long to set as display type', async () => {
    // Capped at MAX_QUERY_CHARS, so this is the widest heading the page can
    // ever be asked to render.
    const html = await fetchPage(`/search?q=${'supercalifragilistic '.repeat(5)}`);
    const heading = elementWith(html, 'h1', 'data-search-heading');

    expect(heading).toContain('text-title');
    expect(heading).not.toContain('text-display');
  });

  test('puts the query back in the form so a search can be refined', async () => {
    const form = elementWith(await fetchPage('/search?q=armature'), 'form', 'data-search-form');
    expect(form).toContain('value="armature"');
  });

  test('counts the chips from the rows it is about to render', async () => {
    const chips = elementWith(await fetchPage('/search?q=armature'), 'nav', 'data-search-filters');

    expect(chips).toContain('All 2');
    expect(chips).toContain('Writing 1');
    expect(chips).toContain('Work 1');
    expect(chips).toContain('Pages 0');
  });

  test('a chip is a link carrying the query and its own type', async () => {
    const chips = elementWith(await fetchPage('/search?q=armature'), 'nav', 'data-search-filters');
    expect(chips).toContain('href="/search?q=armature&amp;type=writing"');
  });

  test('a filter narrows the rows without a second query', async () => {
    const rows = rowsOf(await fetchPage('/search?q=armature&type=work'));

    expect(rows.match(/data-search-row/g)).toHaveLength(1);
    expect(rows).toContain('/work/silent-failure');
    expect(rows).not.toContain('/writing/armature');
  });

  test('says so plainly when a filter leaves nothing, and still offers /chat', async () => {
    const html = await fetchPage('/search?q=armature&type=page');

    expect(html).toContain('data-search-empty');
    expect(html).not.toContain('data-search-row');
    expect(html).toContain('/chat?q=armature');
  });

  test('hands the query to /chat under the results', async () => {
    expect(await fetchPage('/search?q=armature')).toContain('/chat?q=armature');
  });

  test('never offers a bot check, because a results page is a link people share', async () => {
    const html = await fetchPage('/search?q=armature');
    expect(html).not.toContain('cf-turnstile');
  });

  test('needs no script of its own', async () => {
    const html = await fetchPage('/search?q=armature');
    const main = elementWith(html, 'main', 'id="main"');
    expect(main).not.toContain('<script');
  });

  test('renders the excerpt as markup, with the matched term marked', async () => {
    const rows = rowsOf(await fetchPage('/search?q=armature'));

    // The stub's own excerpt for that URL opens with the word. What this holds
    // is the `set:html`: swap it for `{highlight(...)}` and every other test in
    // this file still passes while a visitor sees literal `&lt;mark&gt;` tags,
    // which is what the second assertion exists to catch.
    expect(rows).toContain('<mark>Armature</mark>');
    expect(rows).not.toContain('&lt;mark&gt;');
  });

  test('says the search is unavailable when the far side refuses it', async () => {
    /**
     * THE ONLY STATE THIS SUITE CANNOT REACH BY ASKING FOR IT, so it is reached
     * by spending the allowance the far side enforces. One pinned address,
     * outside the rotating range above, and `LIMITS.inference.limit` requests
     * to exhaust it: the next one comes back `429` and the page renders the
     * sentence that Worker wrote.
     *
     * A real refusal rather than a stubbed one, which is the point. What is
     * being checked is that the sentence travelled across the service binding
     * and reached the markup, and a mocked `fetch` would prove only that this
     * file can build a string.
     */
    const address = '192.0.2.250';
    for (let spent = 0; spent < LIMITS.inference.limit; spent += 1) {
      await fetchFrom(`/search?q=armature`, address);
    }

    const html = await fetchFrom('/search?q=armature', address);

    expect(html).toContain('data-search-unavailable');
    // The far side's own words, not this page's fallback: workers/mcp/src/search.ts
    // is where the retry hint is known, and the sentence is shaped so this page
    // can print it rather than keep a second table of codes.
    expect(html).toContain('That is a lot of searches at once.');
    // The form survives, so the visitor can try again without going back.
    expect(elementWith(html, 'form', 'data-search-form')).toContain('name="q"');
    // And nothing pretends there were results to filter.
    expect(html).not.toContain('data-search-filters');
    expect(html).not.toContain('data-search-row');
  });

  test('carries no candidacy vocabulary on any of its states', async () => {
    const pages = await Promise.all([
      fetchPage('/search'),
      fetchPage('/search?q=armature'),
      fetchPage('/search?q=armature&type=page'),
    ]);

    for (const html of pages) {
      for (const pattern of BANNED_PATTERNS) {
        expect(html).not.toMatch(pattern);
      }
    }
  });
});

describe('the pages list', () => {
  test('names every non-collection route worth finding', () => {
    expect(SEARCHABLE_PAGES.map((page) => page.path)).toEqual([
      '/writing',
      '/work',
      '/resume',
      '/chat',
      '/ops',
      '/ai-policy',
    ]);
  });

  test('holds no path the sitemap excludes, which would be a row nobody can reach', () => {
    for (const page of SEARCHABLE_PAGES) {
      expect(isUnindexed(`https://ryanlindsey.me${page.path}/`)).toBe(false);
    }
  });
});
