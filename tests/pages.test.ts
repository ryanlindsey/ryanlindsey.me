import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { formatDateRange } from '../src/lib/resume';

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

const resumeYamlPath = new URL('../src/content/resume/ryan-lindsey.yaml', import.meta.url);

/**
 * Whether a top-level résumé YAML array (`education`, `skills`, ...) is
 * empty, read from the real file rather than hand-typed -- so callers stay
 * true after the content track fills one in. Handles both the inline
 * `key: []` form the file uses today and a future block-style `key:\n  -
 * ...` list.
 */
const yamlArrayIsEmpty = (source: string, key: string): boolean => {
  const match = source.match(new RegExp(`\\n${key}:([^\\n]*)\\n`));
  if (!match) throw new Error(`no top-level '${key}:' key found in the résumé YAML`);
  const inline = match[1].trim();
  if (inline === '[]') return true;
  if (inline !== '') return false; // some other inline scalar/array: treat as populated
  const afterKey = source.slice(match.index! + match[0].length);
  const nextContentLine = afterKey.split('\n').find((line) => line.trim() !== '');
  return !(nextContentLine && /^ {2}- /.test(nextContentLine));
};

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
  expect(head).not.toMatch(/<script[^>]+\bsrc=/);
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
  // Identity and position, not just "some <a> precedes <main>" -- the header
  // wordmark is also an <a> that precedes <main>, so that weaker check would
  // stay green even if the skip link moved inside <main>. Existence is
  // asserted separately from position: indexOf returns -1 on a miss, and
  // -1 < headerIndex is true, so a position-only check would stay green even
  // if the skip link were removed entirely.
  const skipLink = body.indexOf('href="#main"');
  expect(skipLink).toBeGreaterThan(-1);
  expect(skipLink).toBeLessThan(body.indexOf('<header'));
  expect(body).toContain('id="main"');
});

test('renders header and footer landmarks', async () => {
  const page = await html('/');
  expect(page).toContain('<header');
  expect(page).toContain('<footer');
  expect(page).toMatch(/<nav[^>]*aria-label="Primary"/);
  // The print CSS hides site chrome by these attributes (tests/print.test.ts
  // checks the CSS side); assert they actually land on the rendered markup.
  expect(page).toContain('data-site-header');
  expect(page).toContain('data-site-footer');
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
  // Word-boundary, inflection-aware patterns: naive substrings ("hire", bare
  // "candidate") both miss real leaks ("candidates", "recruitment") and catch
  // false positives ("Yorkshire", "Cheshire", "Hampshire" all contain "hire").
  // "looking for" is dropped -- too generic ("looking for the source?") and a
  // check that cries wolf gets weakened by whoever trips it next. "open to
  // work" is added -- it's LinkedIn's own badge text and the single most
  // canonical public candidacy signal.
  const BANNED = [
    /\bhir(e|es|ed|ing)\b/i,
    /\bcandidates?\b/i,
    /\brecruit(er|ers|ing|ment)?\b/i,
    /\bjob[-\s]?search(es|ing)?\b/i,
    /\bactively looking\b/i,
    /\bopen to (work|opportunities|offers)\b/i,
  ];
  for (const route of [
    '/',
    '/writing',
    '/writing/type-specimen',
    '/work',
    '/work/shape-specimen',
    '/resume',
  ]) {
    const page = await html(route);
    for (const pattern of BANNED) {
      expect(page, `${route} must not match ${pattern}`).not.toMatch(pattern);
    }
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

test('serves a resume page with a section structure', async () => {
  const page = await html('/resume');
  expect(page).toContain('<h1');
  expect(page).toContain('data-testid="resume"');
  // Day 3 replaces day 2's placeholder SECTIONS (Experience / Selected work /
  // Education) with the shape the résumé data model actually has: Experience,
  // Education and Skills (task-2-brief.md Step 1). "Selected work" was never
  // a field on the résumé -- it was the day-2 skeleton's own invention.
  //
  // Experience always has data (the résumé always has a work history), so
  // its heading always renders. Education and Skills follow the "no empty
  // scaffolding on any surface" rule (fix round 1): a section -- heading
  // included -- is omitted entirely while its array is empty, and comes
  // back automatically once the content track populates it. Read from the
  // real YAML rather than hardcoded, so this assertion keeps telling the
  // truth after that happens instead of silently asserting today's shape
  // forever.
  expect(page).toContain('Experience');
  const yaml = readFileSync(resumeYamlPath, 'utf8');
  for (const [key, heading] of [
    ['education', 'Education'],
    ['skills', 'Skills'],
  ] as const) {
    if (yamlArrayIsEmpty(yaml, key)) {
      expect(page, `${heading} should not render while ${key} is empty`).not.toContain(heading);
    } else {
      expect(page, `${heading} should render now that ${key} has data`).toContain(heading);
    }
  }
});

test('renders every company name and date range from the real résumé data', async () => {
  // tests/resume.test.ts's resumeFixture hand-duplicates the YAML for its
  // pure-function unit tests and can silently drift from the real file --
  // see progress.md's Task 1 entry. This test closes that gap at the HTTP
  // level: it reads the *actual* content-collection YAML directly (not a
  // second hand-typed fixture) and asserts every company name and every
  // date range it lists actually renders on /resume. formatDateRange is the
  // same pure function the page itself calls, so the expected string can
  // never drift from what the page produces from the same inputs.
  //
  // This also exercises getResume()'s exactly-one-entry guard (untested
  // since Task 1): /resume is a static, prerendered page, so if that guard
  // ever threw, `npm test`'s `astro build` step -- which runs before this
  // file even starts -- would fail outright, before any test could run.
  const yaml = readFileSync(resumeYamlPath, 'utf8');
  const workBlock = yaml.slice(yaml.indexOf('\nwork:'), yaml.indexOf('\neducation:'));
  const entries = workBlock
    .split(/\n {2}- name: /)
    .slice(1)
    .map((chunk) => {
      const name = chunk.slice(0, chunk.indexOf('\n'));
      const startDate = chunk.match(/startDate: (\d{4}-\d{2})/)?.[1];
      const endDate = chunk.match(/endDate: (\d{4}-\d{2})/)?.[1];
      if (!startDate) throw new Error(`no startDate found in the work entry for ${name}`);
      return { name, startDate, endDate };
    });
  expect(entries.length).toBeGreaterThan(0);

  // The page HTML-escapes text nodes (Y&R Brands / Wunderman renders as
  // "Y&amp;R..."), so the raw YAML string must be escaped the same way
  // before comparison -- not decoded, since decoding the whole page risks
  // masking a real escaping bug elsewhere.
  const htmlEscape = (value: string) => value.replaceAll('&', '&amp;');

  const page = await html('/resume');
  for (const name of new Set(entries.map((entry) => entry.name))) {
    expect(page, `${name} should appear on /resume`).toContain(htmlEscape(name));
  }
  for (const entry of entries) {
    const range = formatDateRange(entry.startDate, entry.endDate);
    expect(page, `${range} (${entry.name}) should appear on /resume`).toContain(htmlEscape(range));
  }
});

test('does not link resume formats that do not exist yet', async () => {
  // Day 3 creates /resume.md, /resume.json and /resume.pdf. Linking them from
  // the skeleton would ship three 404s for a week.
  const page = await html('/resume');
  for (const dead of ['/resume.md', '/resume.json', '/resume.pdf']) {
    expect(page, `${dead} does not exist until day 3`).not.toContain(`href="${dead}"`);
  }
});
