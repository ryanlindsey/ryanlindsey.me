import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { CASE_STUDY_SECTIONS } from '../src/lib/case-study-shape';

// Both Workers are listed for the same reason as tests/site.smoke.test.ts: the
// site's `MCP` service binding names the MCP Worker, and workerd refuses to
// start a Worker whose service binding names an undefined service.
const server = createTestHarness({
  workers: [{ configPath: './wrangler.jsonc' }, { configPath: './workers/mcp/wrangler.jsonc' }],
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

test('keeps case-study drafts out of the index but reachable by URL', async () => {
  const index = await html('/work');
  expect(index).not.toContain('/work/shape-specimen');
  expect(index).toContain('data-testid="work-empty"');
  expect((await server.fetch('/work/shape-specimen')).status).toBe(200);
});

test('links Work from the primary navigation and marks it current', async () => {
  const index = await html('/work');
  expect(index).toMatch(/<a[^>]+href="\/work"[^>]*aria-current="page"/);
  // And the link exists from elsewhere, without the current marker.
  const home = await html('/');
  expect(home).toMatch(/<a[^>]+href="\/work"/);
  expect(home).not.toMatch(/<a[^>]+href="\/work"[^>]*aria-current/);
});
