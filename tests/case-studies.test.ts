import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { CASE_STUDY_SECTIONS } from '../src/lib/case-study-shape';

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

const html = async (path: string) => {
  const response = await server.fetch(path);
  expect(response.status, `${path} should be 200`).toBe(200);
  return response.text();
};

// Read off disk rather than hardcoding a list, so a case study added tomorrow is
// covered by the shape assertion without anyone remembering to edit this file.
// That is the whole value of the ratchet: it has to apply to content that does
// not exist yet.
const slugs = readdirSync('src/content/caseStudies')
  .filter((file) => file.endsWith('.mdx'))
  .map((file) => file.replace(/\.mdx$/, ''));

// Draft state read the same way for the same reason: the index test below
// needs to know which slugs the aggregation surface is supposed to carry, and
// hardcoding "everything except shape-specimen" would go quietly wrong the day
// a second specimen or an unfinished case study lands. Same frontmatter-only
// regex tests/pages.test.ts uses, so `draft:` in prose cannot be mistaken for
// the field.
const isDraft = (slug: string) => {
  const source = readFileSync(`src/content/caseStudies/${slug}.mdx`, 'utf8');
  const end = source.indexOf('\n---', 3);
  return /\ndraft:\s*true\b/.test(end === -1 ? source : source.slice(0, end));
};

const publishedSlugs = slugs.filter((slug) => !isDraft(slug));
const draftSlugs = slugs.filter(isDraft);

// Markdown turns a straight apostrophe into a typographic one, so "What I'd do
// differently" does not match its own source text after rendering.
const straighten = (text: string) => text.replace(/[‘’]/g, "'");

const sectionHeadings = (page: string) =>
  [...page.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)]
    // The heading-anchor plugin puts an empty <a> inside every heading, so the
    // tags have to come out before the text is comparable.
    .map((match) => straighten(match[1].replace(/<[^>]*>/g, '')).trim())
    .filter(Boolean);

test('there is at least one case study to check', () => {
  // A suite that silently checks nothing reports that nobody minds it having
  // asked nothing. If this collection is ever emptied, that is a finding rather
  // than a reason for the shape assertions below to pass vacuously.
  expect(slugs.length, 'src/content/caseStudies has no .mdx entries').toBeGreaterThan(0);
});

test.each(slugs)('/work/%s carries the 02 §4 shape, in order', async (slug) => {
  const page = await html(`/work/${slug}`);
  // Exact equality, not a subset. 02 §4 calls the shape fixed, so an extra
  // top-level section is a shape change and should have to be argued for in a
  // diff to src/lib/case-study-shape.ts. Subsections are <h3> and are free.
  expect(sectionHeadings(page)).toEqual([...CASE_STUDY_SECTIONS]);
});

test('renders a case study through the article template', async () => {
  // Pinned to the specimen rather than slugs[0]: this asserts the template's
  // furniture, not any particular case study, and an index into a list that the
  // guard above may have just found empty reports itself as "/work/undefined".
  const page = await html('/work/shape-specimen');
  expect(page).toContain('data-testid="reading-time"');
  expect(page).toMatch(/\d+ min read/);
  expect(page).toMatch(/<nav[^>]*aria-label="Table of contents"/);
  // Case studies are not posts and have no series, so the pillar label must not
  // leak into their meta line and the series nav must not render.
  expect(page).toContain('data-testid="article-kicker"');
  expect(page).toMatch(/data-testid="article-kicker"[^>]*>Case study</);
  expect(page).not.toContain('data-series-nav');
});

test('renders code blocks in a case study with Expressive Code frames', async () => {
  // The Mechanism section is where excerpts live, so the integration has to
  // work on this route and not only on /writing.
  const page = await html('/work/shape-specimen');
  expect(page).toContain('class="expressive-code');
  expect(page).toContain('data-language="ts"');
  expect(page).toContain('data-code=');
});

test('lists every published case study in the index and keeps drafts out of it', async () => {
  // Both halves, deliberately. Until the first case studies shipped this test
  // asserted only the exclusion plus `data-testid="work-empty"`, which an
  // index that had silently stopped listing anything would also have passed.
  // The inclusion half is what stops that, and the guards below are what stop
  // either half from going vacuous if the collection's makeup changes.
  expect(publishedSlugs.length, 'expected at least one published case study').toBeGreaterThan(0);
  expect(draftSlugs.length, 'expected at least one draft case study').toBeGreaterThan(0);

  const index = await html('/work');
  for (const slug of publishedSlugs) {
    expect(index, `/work should link /work/${slug}`).toContain(`/work/${slug}`);
  }
  for (const slug of draftSlugs) {
    expect(index, `/work must not link the draft /work/${slug}`).not.toContain(`/work/${slug}`);
  }
  // The empty state is the other side of the same branch in
  // src/pages/work/index.astro, so it must be gone now that entries exist.
  expect(index).not.toContain('data-testid="work-empty"');
});

test('serves a draft case study by URL even though the index omits it', async () => {
  // The detail tier of the draft rule (tests/pages.test.ts's own framing):
  // aggregation surfaces filter on `!data.draft`, detail routes do not.
  for (const slug of draftSlugs) {
    expect((await server.fetch(`/work/${slug}`)).status, `/work/${slug} should be 200`).toBe(200);
  }
});

test('links Work from the primary navigation and marks it current', async () => {
  const index = await html('/work');
  expect(index).toMatch(/<a[^>]+href="\/work"[^>]*aria-current="page"/);
  // And the link exists from elsewhere, without the current marker.
  const home = await html('/');
  expect(home).toMatch(/<a[^>]+href="\/work"/);
  expect(home).not.toMatch(/<a[^>]+href="\/work"[^>]*aria-current/);
});
