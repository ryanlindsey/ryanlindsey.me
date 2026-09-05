import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';

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

test('sets the theme before first paint', async () => {
  const page = await html('/');
  // The script must be inline and in the head -- a deferred or bundled script
  // paints the wrong theme first, which is the whole failure being prevented.
  const head = page.slice(0, page.indexOf('</head>'));
  expect(head).toContain('rl-theme');
  expect(head).toContain('prefers-color-scheme');
  expect(head).toContain('data-theme');
  // A bundled module script would carry a src= instead of a body.
  expect(head).not.toMatch(/<script[^>]+src=[^>]*rl-theme/);
});

test('does not hardcode a theme on the html element', async () => {
  const page = await html('/');
  // The server must not guess; the script decides. A server-rendered value
  // would be wrong for half of all visitors on their first paint.
  expect(page).not.toMatch(/<html[^>]+data-theme=/);
});

test('exposes an accessible theme toggle', async () => {
  const page = await html('/');
  expect(page).toContain('data-theme-toggle');
  expect(page).toMatch(/aria-label="[^"]*[Tt]heme[^"]*"/);
});

test('provides a skip link as the first focusable element', async () => {
  const page = await html('/');
  const body = page.slice(page.indexOf('<body'));
  const firstAnchor = body.indexOf('<a ');
  const mainStart = body.indexOf('<main');
  expect(firstAnchor).toBeGreaterThan(-1);
  expect(firstAnchor).toBeLessThan(mainStart);
  expect(body).toContain('href="#main"');
  expect(body).toContain('id="main"');
});

test('renders header and footer landmarks', async () => {
  const page = await html('/');
  expect(page).toContain('<header');
  expect(page).toContain('<footer');
  expect(page).toMatch(/<nav[^>]*aria-label="Primary"/);
});

test('keeps the holding page marker and stays unindexed', async () => {
  const page = await html('/');
  expect(page).toContain('data-testid="holding-page"');
  expect(page).toContain('<title>Ryan Lindsey</title>');
  expect(page).toContain('name="robots"');
  expect(page).toContain('noindex');
});

test('carries no candidacy language on any public surface', async () => {
  // 09 §2 is a hard rule and the cheapest place to enforce it is every render.
  const page = (await html('/')).toLowerCase();
  for (const banned of ['hire', 'candidate', 'job search', 'recruiter', 'looking for']) {
    expect(page, `public surface must not contain "${banned}"`).not.toContain(banned);
  }
});

test('renders an MDX article with Expressive Code frames', async () => {
  const page = await html('/writing/type-specimen');
  expect(page).toContain('class="expressive-code');
  expect(page).toContain('frame has-title');
  expect(page).toContain('frame is-terminal');
  expect(page).toContain('data-language="js"');
  // The copy button is what `data-code` belongs to; two code blocks minimum.
  expect((page.match(/data-code=/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test('gives headings stable ids and empty anchors', async () => {
  const page = await html('/writing/type-specimen');
  expect(page).toContain('id="code-frames"');
  expect(page).toMatch(/<a class="heading-anchor" href="#code-frames"[^>]*><\/a>/);
});

test('keeps drafts out of the writing index but reachable by URL', async () => {
  const index = await html('/writing');
  expect(index).not.toContain('/writing/type-specimen');
  expect(index).toContain('data-testid="writing-empty"');
  expect((await server.fetch('/writing/type-specimen')).status).toBe(200);
});

test('renders a table of contents matching the article headings', async () => {
  const page = await html('/writing/type-specimen');
  expect(page).toMatch(/<nav[^>]*aria-label="Table of contents"/);
  // Every TOC target must resolve to a real element id on the same page.
  const targets = [...page.matchAll(/data-toc-link="([^"]+)"/g)].map((m) => m[1]);
  expect(targets.length).toBeGreaterThanOrEqual(4);
  for (const slug of targets) {
    expect(page, `TOC points at #${slug} but no element has that id`).toContain(`id="${slug}"`);
  }
});

test('keeps TOC labels free of the anchor glyph', async () => {
  // Regression guard: if the heading anchor ever gains text content, Astro
  // folds it into `headings[].text` and every TOC label picks up a stray "#".
  const page = await html('/writing/type-specimen');
  const labels = [...page.matchAll(/data-toc-link="[^"]+"[^>]*>\s*([^<]+?)\s*</g)].map((m) => m[1]);
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) expect(label).not.toContain('#');
});

test('shows reading time on an article', async () => {
  const page = await html('/writing/type-specimen');
  expect(page).toContain('data-testid="reading-time"');
  expect(page).toMatch(/\d+ min read/);
});

test('omits series navigation for a one-post series', async () => {
  // type-specimen is the only post in its series, so the nav must not render.
  // A "Part 1 of 1" block is noise, and this is the cheap guard against it.
  const page = await html('/writing/type-specimen');
  expect(page).not.toContain('data-series-nav');
});
