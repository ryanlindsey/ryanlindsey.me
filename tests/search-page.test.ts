import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { SEARCHABLE_PAGES } from '../src/lib/search/pages';
import {
  countRows,
  filterRows,
  highlight,
  joinResults,
  pathOf,
  type SearchDocument,
} from '../src/lib/search/results';
import { SEARCH_STUB_RESULTS } from '../src/lib/search/engine';
import { isUnindexed, unindexedRoutes } from '../src/lib/unindexed-routes.mjs';
import { BANNED_PATTERNS } from './candidacy-patterns';
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

  const fetchPage = async (path: string): Promise<string> => {
    const response = await server.fetch(path);
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
