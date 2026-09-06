import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { formatDateRange } from '../src/lib/resume';

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

const resumeYamlPath = new URL('../src/content/resume/ryan-lindsey.yaml', import.meta.url);

/**
 * `{ section: 'writing' | 'work', slug, draft }` for every real content
 * entry, read straight from the `.mdx` source files rather than through
 * `astro:content` -- this test file already reads the résumé YAML source
 * directly for the same reason (see the résumé tests below): the assertion
 * should stay true as the content track adds entries, without importing an
 * Astro-flavoured module into a plain Vitest run.
 *
 * `draft` mirrors content.config.ts's own default (`z.boolean().default(false)`)
 * when the frontmatter omits the key entirely, and only reads the key out of
 * the frontmatter block itself (the text before the closing `---`) so a
 * `draft:` appearing in prose in the body could never be mistaken for it.
 */
function readContentEntries(
  section: 'writing' | 'work',
  dir: URL,
): { section: 'writing' | 'work'; slug: string; draft: boolean }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.mdx'))
    .map((name) => {
      const source = readFileSync(new URL(name, dir), 'utf8');
      const frontmatterEnd = source.indexOf('\n---', 3);
      if (frontmatterEnd === -1) {
        throw new Error(`${name}: no closing frontmatter fence found`);
      }
      const frontmatter = source.slice(0, frontmatterEnd);
      return {
        section,
        slug: name.replace(/\.mdx$/, ''),
        draft: /\ndraft:\s*true\b/.test(frontmatter),
      };
    });
}

const CONTENT_ENTRIES = [
  ...readContentEntries('writing', new URL('../src/content/posts/', import.meta.url)),
  ...readContentEntries('work', new URL('../src/content/caseStudies/', import.meta.url)),
];

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

test('links every resume format, and every link resolves', async () => {
  // Day 2 wrote this assertion inverted -- "/resume links NONE of these" -- on
  // purpose, so the format bar could not be linked before the routes existed.
  // Task 3 created /resume.md and /resume.json, Task 5 created /resume.pdf, so
  // it flips here rather than being deleted.
  //
  // Both halves are kept because they are different claims. "The page links
  // three URLs" says nothing about whether they answer, and "three URLs answer"
  // says nothing about whether a reader can find them. A format bar the page
  // stopped rendering, and a link to a route that 404s, are both failures this
  // one test should catch.
  const page = await html('/resume');
  for (const format of ['/resume.md', '/resume.json', '/resume.pdf']) {
    expect(page, `/resume should link ${format}`).toContain(`href="${format}"`);
    const response = await server.fetch(format);
    expect(response.status, `${format} should resolve`).toBe(200);
  }
});

test('every writing and work entry has a resolving .md variant, drafts included', async () => {
  // Day 3 Task 7 (02 §3): `/writing/<slug>.md` and `/work/<slug>.md` mirror
  // their HTML sibling's getStaticPaths exactly -- src/pages/writing/[...slug].astro
  // and .../work/[...slug].astro both serve every entry, published or not
  // ("Drafts get a route but never an index entry, so work in progress is
  // shareable by URL without entering the site's navigation" -- that file's
  // own comment). A `.md` variant that hid a draft its HTML route serves
  // would break the format parity this plan exists to guarantee, so this
  // asserts on EVERY entry in CONTENT_ENTRIES, not just the published ones.
  expect(CONTENT_ENTRIES.length).toBeGreaterThan(0);
  // At least one specimen must currently be a draft, or this test would stay
  // green even if a future change silently dropped draft entries from
  // getStaticPaths -- the parity guarantee is only actually exercised while
  // that is true.
  expect(
    CONTENT_ENTRIES.some((entry) => entry.draft),
    'expected at least one draft content entry to exercise the drafts-get-a-.md-variant guarantee',
  ).toBe(true);

  for (const entry of CONTENT_ENTRIES) {
    const markdownHref = `/${entry.section}/${entry.slug}.md`;
    const response = await server.fetch(markdownHref);
    expect(response.status, `${markdownHref} should resolve (draft: ${entry.draft})`).toBe(200);
    // Verified over the real HTTP response, not the endpoint's source: Astro's
    // static build discards a prerendered endpoint's Response headers, so the
    // Content-Type actually served comes from public/_headers (or Cloudflare's
    // asset mime table), not from the `headers` object in [...slug].md.ts.
    expect(
      response.headers.get('content-type'),
      `${markdownHref} should serve text/markdown over HTTP, not text/plain`,
    ).toMatch(/^text\/markdown\b/);
  }
});

test('every writing and work HTML page links its .md variant, and both link tags resolve', async () => {
  // Base.astro's `markdownHref` prop (threaded through Shell.astro and
  // ArticleLayout.astro) adds both link relations. Asserting only that the
  // tags exist would let them rot into a lie if the route were ever renamed
  // or removed -- so each href is also fetched and required to resolve.
  for (const entry of CONTENT_ENTRIES) {
    const markdownHref = `/${entry.section}/${entry.slug}.md`;
    const htmlPath = `/${entry.section}/${entry.slug}`;
    const page = await html(htmlPath);
    const head = page.slice(0, page.indexOf('</head>'));

    expect(head, `${htmlPath} should carry rel="alternate" pointing at ${markdownHref}`).toContain(
      `<link rel="alternate" type="text/markdown" href="${markdownHref}">`,
    );
    expect(
      head,
      `${htmlPath} should carry rel="describedby" pointing at ${markdownHref}`,
    ).toContain(`<link rel="describedby" type="text/markdown" href="${markdownHref}">`);

    const markdownResponse = await server.fetch(markdownHref);
    expect(
      markdownResponse.status,
      `${htmlPath}'s markdown link (${markdownHref}) should actually resolve`,
    ).toBe(200);
  }
});
