import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { SITE_ORIGIN } from '../src/lib/markdown-export';
import {
  SCHEMA_CONTEXT,
  buildPerson,
  buildBlogPosting,
  buildTechArticle,
  buildBreadcrumbList,
  stringifyJsonLd,
  type PersonNode,
  type BlogPostingNode,
  type TechArticleNode,
  type BreadcrumbListNode,
} from '../src/lib/structured-data';

// Day 3 Task 10 (02 §3): JSON-LD structured data. Two halves, matching this
// file's own split between src/lib/structured-data.ts (pure builders) and
// the .astro files that call them:
//
// 1. Pure unit tests against the builders directly, with fixtures -- no
//    server, no `astro:content`, exactly the reasoning
//    tests/series.test.ts and tests/llms-index.ts's own tests give.
// 2. HTTP tests against the real built site (same harness as
//    tests/pages.test.ts), because "every URL in it resolves to a real
//    route" (task-10-brief.md Step 3) can only be checked against an
//    actual server -- a pure function has no routes to resolve against.
//
// task-10-brief.md's own warning: "the block parses as JSON" passes for
// `{}`. Every HTTP assertion below checks specific field values pulled from
// the real page (a post's own <h1>, its real .mdx frontmatter) rather than
// only checking that *a* script tag exists, and the type-membership checks
// use exact set equality (not `toContain`) so an extra or missing node is a
// failure, not a pass.

// --- 1. Pure builder tests ------------------------------------------------

describe('buildPerson', () => {
  test('carries @context and @type, omitting jobTitle and sameAs when absent', () => {
    expect(buildPerson({ name: 'Ada Lovelace', url: 'https://example.com/' })).toEqual({
      '@context': SCHEMA_CONTEXT,
      '@type': 'Person',
      name: 'Ada Lovelace',
      url: 'https://example.com/',
    });
  });

  test('omits sameAs when given an empty array, not just when absent', () => {
    // Proves the builder checks length, not just presence -- a weaker
    // `sameAs !== undefined` guard would let `sameAs: []` leak into the
    // output, which is exactly the "empty scaffolding" this repo's other
    // generators (buildLlmsTxt's section omission) refuse to ship.
    const person = buildPerson({ name: 'Ada Lovelace', url: 'https://example.com/', sameAs: [] });
    expect(person).not.toHaveProperty('sameAs');
  });

  test('includes jobTitle and sameAs, in the given order, when provided', () => {
    const person = buildPerson({
      name: 'Ada Lovelace',
      url: 'https://example.com/',
      jobTitle: 'Mathematician',
      sameAs: ['https://github.com/ada', 'https://linkedin.com/in/ada'],
    });
    expect(person.jobTitle).toBe('Mathematician');
    expect(person.sameAs).toEqual(['https://github.com/ada', 'https://linkedin.com/in/ada']);
  });
});

const articleInput = {
  headline: 'A Fixture Headline',
  description: 'A fixture description used only to prove the builder works.',
  url: 'https://example.com/writing/fixture/',
  datePublished: new Date('2026-01-15T00:00:00Z'),
  author: { name: 'Ada Lovelace', url: 'https://example.com/' },
};

describe('buildBlogPosting and buildTechArticle', () => {
  test('map headline/description/url/datePublished/author straight through, omitting dateModified when absent', () => {
    expect(buildBlogPosting(articleInput)).toEqual({
      '@context': SCHEMA_CONTEXT,
      '@type': 'BlogPosting',
      headline: 'A Fixture Headline',
      description: 'A fixture description used only to prove the builder works.',
      url: 'https://example.com/writing/fixture/',
      datePublished: '2026-01-15T00:00:00.000Z',
      author: { '@type': 'Person', name: 'Ada Lovelace', url: 'https://example.com/' },
    });
  });

  test('includes dateModified as an ISO string when a Date is given', () => {
    const node = buildBlogPosting({
      ...articleInput,
      dateModified: new Date('2026-02-01T00:00:00Z'),
    });
    expect(node.dateModified).toBe('2026-02-01T00:00:00.000Z');
  });

  test('buildTechArticle shares every field with buildBlogPosting except @type', () => {
    // The research appendix (B3.1/B3.2) says these are the same shape with a
    // different, semantically-better-fitting @type for a case study -- this
    // asserts the two builders actually agree, rather than trusting the
    // comment in src/lib/structured-data.ts that says so.
    const blogPosting = buildBlogPosting(articleInput);
    const techArticle = buildTechArticle(articleInput);
    expect(techArticle).toEqual({ ...blogPosting, '@type': 'TechArticle' });
  });
});

describe('buildBreadcrumbList', () => {
  test('returns an empty itemListElement for an empty trail', () => {
    expect(buildBreadcrumbList([])).toEqual({
      '@context': SCHEMA_CONTEXT,
      '@type': 'BreadcrumbList',
      itemListElement: [],
    });
  });

  test('assigns 1-based position by array order, not by any property of the input', () => {
    const list = buildBreadcrumbList([
      { name: 'Ryan Lindsey', url: 'https://example.com/' },
      { name: 'Writing', url: 'https://example.com/writing' },
      { name: 'A Fixture Post', url: 'https://example.com/writing/fixture/' },
    ]);
    expect(list.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Ryan Lindsey', item: 'https://example.com/' },
      { '@type': 'ListItem', position: 2, name: 'Writing', item: 'https://example.com/writing' },
      {
        '@type': 'ListItem',
        position: 3,
        name: 'A Fixture Post',
        item: 'https://example.com/writing/fixture/',
      },
    ]);
  });
});

describe('stringifyJsonLd', () => {
  test('round-trips an ordinary node exactly', () => {
    const person = buildPerson({ name: 'Ada Lovelace', url: 'https://example.com/' });
    expect(JSON.parse(stringifyJsonLd(person))).toEqual(person);
  });

  test('neutralises an embedded "</script>" so it cannot close the surrounding tag, without corrupting the value', () => {
    const node = buildBlogPosting({ ...articleInput, headline: 'Escape </script> attempt' });
    const serialized = stringifyJsonLd(node);
    expect(serialized).not.toContain('</script>');
    // Still valid, and still the ORIGINAL string once parsed back -- the
    // escape is cosmetic to the raw bytes, not a mutation of the data.
    expect(JSON.parse(serialized).headline).toBe('Escape </script> attempt');
  });
});

// --- 2. HTTP tests against the real built site ----------------------------

const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

/** Every `<script type="application/ld+json">` block in `html`'s `<head>`, parsed. */
function jsonLdBlocksIn(html: string): unknown[] {
  const head = html.slice(0, html.indexOf('</head>'));
  const matches = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  // Fails loudly (JSON.parse throws) rather than silently, if a block is
  // malformed -- exactly task-10-brief.md's "parses as JSON" assertion.
  return matches.map((match) => JSON.parse(match[1]));
}

const typeOf = (block: unknown): string | undefined =>
  (block as { '@type'?: string } | null)?.['@type'];

const isPerson = (block: unknown): block is PersonNode => typeOf(block) === 'Person';
const isBlogPosting = (block: unknown): block is BlogPostingNode => typeOf(block) === 'BlogPosting';
const isTechArticle = (block: unknown): block is TechArticleNode => typeOf(block) === 'TechArticle';
const isBreadcrumbList = (block: unknown): block is BreadcrumbListNode =>
  typeOf(block) === 'BreadcrumbList';

/** Every string value anywhere in `value` that is one of this site's own URLs. */
function siteUrlsIn(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    // sameAs (GitHub, LinkedIn, ...) is deliberately excluded: those are
    // other sites' URLs, not routes of this one, and this suite must not
    // make a real network call to them.
    if (value.startsWith(SITE_ORIGIN)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) siteUrlsIn(item, found);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) siteUrlsIn(entry, found);
  }
  return found;
}

/** Fetches every same-origin URL found anywhere in `block` and requires a 200. */
async function expectEveryUrlToResolve(block: unknown, label: string): Promise<void> {
  const urls = siteUrlsIn(block);
  expect(urls.size, `${label} should carry at least one URL to check`).toBeGreaterThan(0);
  for (const url of urls) {
    const path = new URL(url).pathname;
    const response = await server.fetch(path);
    expect(response.status, `${label}: ${url} should resolve`).toBe(200);
  }
}

const html = async (path: string) => {
  const response = await server.fetch(path);
  expect(response.status, `${path} should be 200`).toBe(200);
  return response.text();
};

test('every JSON-LD block on every checked page parses and carries the schema.org context', async () => {
  for (const path of ['/', '/resume', '/writing/type-specimen', '/work/shape-specimen']) {
    const blocks = jsonLdBlocksIn(await html(path));
    expect(blocks.length, `${path} should carry at least one JSON-LD block`).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block, `${path}'s block should carry @context`).toHaveProperty(
        '@context',
        SCHEMA_CONTEXT,
      );
    }
  }
});

test('every page carries a Person node, sitewide, and its url resolves', async () => {
  for (const path of ['/', '/resume', '/writing', '/work']) {
    const blocks = jsonLdBlocksIn(await html(path));
    const person = blocks.find(isPerson);
    expect(person, `${path} should carry a Person node`).toBeDefined();
    await expectEveryUrlToResolve(person, `${path} Person`);
  }
});

test('/resume carries only Person -- no article node leaks onto a page with no structuredData prop', async () => {
  const blocks = jsonLdBlocksIn(await html('/resume'));
  expect(blocks.map(typeOf)).toEqual(['Person']);
});

test('a post carries Person, BlogPosting and BreadcrumbList, matching the real content and each resolving', async () => {
  const page = await html('/writing/type-specimen');
  const blocks = jsonLdBlocksIn(page);
  // Exact set, not `toContain` -- an extra or a missing node is a failure.
  expect(new Set(blocks.map(typeOf))).toEqual(new Set(['Person', 'BlogPosting', 'BreadcrumbList']));

  const blogPosting = blocks.find(isBlogPosting);
  expect(blogPosting).toBeDefined();
  // Cross-checked against the page's OWN rendered <h1>, not a second
  // hand-typed copy of the title, so this stays true if the specimen's
  // frontmatter ever changes.
  const h1 = page.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1];
  expect(h1).toBeTruthy();
  expect(blogPosting!.headline).toBe(h1);
  expect(blogPosting!.description).toBe('Every block the article template supports, on one page.');
  // type-specimen.mdx carries no `updatedAt` -- see the frontmatter directly.
  expect(blogPosting).not.toHaveProperty('dateModified');
  await expectEveryUrlToResolve(blogPosting, '/writing/type-specimen BlogPosting');

  const breadcrumb = blocks.find(isBreadcrumbList);
  expect(breadcrumb).toBeDefined();
  expect(breadcrumb!.itemListElement.map((item) => item.name)).toEqual([
    'Ryan Lindsey',
    'Writing',
    h1,
  ]);
  await expectEveryUrlToResolve(breadcrumb, '/writing/type-specimen BreadcrumbList');
});

test("a case study carries Person and TechArticle, but no BreadcrumbList (the brief's own asymmetry)", async () => {
  const page = await html('/work/shape-specimen');
  const blocks = jsonLdBlocksIn(page);
  expect(new Set(blocks.map(typeOf))).toEqual(new Set(['Person', 'TechArticle']));

  const techArticle = blocks.find(isTechArticle);
  expect(techArticle).toBeDefined();
  const h1 = page.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1];
  expect(techArticle!.headline).toBe(h1);
  expect(techArticle!.description).toBe(
    'A rendering fixture for the fixed case-study shape. Not a case study, and not about any real work; it exercises the six sections, the table of contents, and the article furniture.',
  );
  expect(techArticle).not.toHaveProperty('dateModified');
  await expectEveryUrlToResolve(techArticle, '/work/shape-specimen TechArticle');
});
