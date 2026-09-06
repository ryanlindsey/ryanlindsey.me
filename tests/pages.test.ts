import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import type { CollectionEntry } from 'astro:content';
import { SITE_HARNESS_WORKERS } from './workers';
import { formatDateRange } from '../src/lib/resume';
import { buildLlmsTxt, buildLlmsFullTxt, type LlmsLink } from '../src/lib/llms-index';
import { buildRssFeed, buildJsonFeed, type JsonFeed } from '../src/lib/feeds';

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
    // Day 3 Task 9: the single highest-risk leak surface on this site is
    // /llms-full.txt (task-9-brief.md's own words) -- it concatenates every
    // published document into one response, so anything that leaks
    // anywhere leaks there. /llms.txt is listed alongside it for the same
    // reason every other aggregation surface above is.
    '/llms.txt',
    '/llms-full.txt',
    // Day 3 Task 11: /rss.xml and /feed.json are aggregation surfaces too --
    // once the content track publishes something, its full content (not
    // just a description) lands in both. Listed here for the same reason
    // /llms-full.txt is: today's build makes this vacuously true (both are
    // empty), but the check stays true the moment content ships.
    '/rss.xml',
    '/feed.json',
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
    //
    // NOTE (fix round 1): this assertion is a statement of the *contract*,
    // not a guard against public/_headers losing its `/writing/*.md` and
    // `/work/*.md` rules -- a reviewer deleted those rules, rebuilt, and this
    // still passed, because Cloudflare's default asset-MIME lookup already
    // maps `.md` to exactly `text/markdown; charset=utf-8` (the same fact
    // this file's own `/resume.md` rule's comment documents). Those two rules
    // are defensive -- they stop the served type from silently drifting if
    // that default table ever changes -- not currently load-bearing. The
    // rule that IS load-bearing today is `/resume.json`'s: `.json` has no
    // default charset, which is why tests/resume.test.ts's
    // "/resume.json parses..." test asserts `application/json; charset=utf-8`
    // exactly and fails the moment that rule is removed.
    expect(
      response.headers.get('content-type'),
      `${markdownHref} should serve text/markdown over HTTP, not text/plain`,
    ).toMatch(/^text\/markdown\b/);
  }
});

test('every writing and work HTML page links its .md variant, and both link tags resolve', async () => {
  // Base.astro's `markdownHref` prop (threaded through Shell.astro and
  // ArticleLayout.astro) adds `rel="alternate"`. Asserting only that the
  // tag exists would let it rot into a lie if the route were ever renamed
  // or removed -- so its href is also fetched and required to resolve.
  //
  // Fix round 1 (task-9-report.md): `rel="describedby"` does NOT point at
  // `markdownHref` -- that was Task 7's mistake. Per llms.txt v2 (research
  // appendix B1.2/B2.2), `describedby` points at the llms.txt file that
  // COVERS the page, not at the page's own markdown twin (that's what
  // `alternate` is for). This site has one, root-level, unscoped
  // `/llms.txt` (Task 9), so every page's `describedby` points at that same
  // URL, with no `type` attribute -- matching the spec's own header-form
  // example verbatim (`</docs/llms.txt>; rel="describedby"`, no `type`).
  for (const entry of CONTENT_ENTRIES) {
    const markdownHref = `/${entry.section}/${entry.slug}.md`;
    const htmlPath = `/${entry.section}/${entry.slug}`;
    // Fetched directly (not through the html() helper) so the Response
    // object -- and its headers -- stay in scope below.
    const htmlResponse = await server.fetch(htmlPath);
    expect(htmlResponse.status, `${htmlPath} should be 200`).toBe(200);
    const page = await htmlResponse.text();
    const head = page.slice(0, page.indexOf('</head>'));

    expect(head, `${htmlPath} should carry rel="alternate" pointing at ${markdownHref}`).toContain(
      `<link rel="alternate" type="text/markdown" href="${markdownHref}">`,
    );
    expect(head, `${htmlPath} should carry rel="describedby" pointing at /llms.txt`).toContain(
      '<link rel="describedby" href="/llms.txt">',
    );

    // 02 §3's `X-Markdown-Variant` response header (fix round 1: previously
    // unasserted anywhere). This is the header form of the same claim the
    // <link> tags make in the body, so it is checked for the exact value
    // (not just presence) -- a typo in public/_headers's `:splat` pattern, or
    // the rule matching the wrong entry, would otherwise ship silently.
    expect(
      htmlResponse.headers.get('x-markdown-variant'),
      `${htmlPath} should carry X-Markdown-Variant: ${markdownHref}`,
    ).toBe(markdownHref);

    const markdownResponse = await server.fetch(markdownHref);
    expect(
      markdownResponse.status,
      `${htmlPath}'s markdown link (${markdownHref}) should actually resolve`,
    ).toBe(200);
    // The .md file does not need to advertise its own variant. This also
    // guards the OTHER direction of the public/_headers rule design: the
    // `/writing/*/ ` (X-Markdown-Variant) and `/writing/*.md` (Content-Type)
    // rules are written to never both match the same request, because
    // Cloudflare joins repeated header names across matching rules with a
    // comma rather than letting the more specific rule win -- if the two
    // rules ever overlapped, this assertion would catch the header leaking
    // onto the .md response (usually with a corrupted, comma-joined or
    // double-.md value).
    expect(
      markdownResponse.headers.get('x-markdown-variant'),
      `${markdownHref} itself should not carry X-Markdown-Variant`,
    ).toBeNull();
  }
});

test('index pages carry no X-Markdown-Variant header', async () => {
  // The aggregation surfaces (02 §3's other tier) have no markdown variant of
  // their own -- this is the negative space the two rules above must not
  // spill into. `/writing`/`/work` redirect to their trailing-slash form the
  // same way a detail page does (verified over HTTP, task-7-report.md), so
  // both forms are checked.
  for (const path of ['/writing', '/writing/', '/work', '/work/']) {
    const response = await server.fetch(path);
    expect(response.status, `${path} should be 200`).toBe(200);
    expect(
      response.headers.get('x-markdown-variant'),
      `${path} should not advertise a markdown variant`,
    ).toBeNull();
  }
});

// Day 3 Task 9 (02 §3 / research appendix B1): `/llms.txt` and
// `/llms-full.txt`. Both real .mdx files are `draft: true` right now (see
// CONTENT_ENTRIES above), so today's actual build output has nothing to put
// in the Writing/Case studies sections of `/llms.txt`, and nothing at all
// in `/llms-full.txt`. task-9-brief.md is explicit that a test asserting
// only that emptiness would be exactly the trap this codebase has already
// shipped six times -- a test that passes because there is nothing to test
// (a deleted `.sort()`, a `stripXKeys` test with nothing to strip, Task 5's
// stale-serve test, Task 6's stripping branch, Task 7's Content-Type
// assertion, Task 8's unreachable negotiation code). So every "today's real
// state is empty" assertion below is paired with a fixture-based assertion,
// against the exported generator functions directly (src/lib/llms-index.ts),
// proving the generator actually produces a populated, correctly-shaped
// result and not just nothing.

test("/llms.txt omits the Writing and Case studies sections while nothing is published (today's real state)", async () => {
  const page = await html('/llms.txt');
  expect(page).toContain('# Ryan Lindsey');
  expect(page).toMatch(/^> \S/m);
  expect(page).not.toContain('## Writing');
  expect(page).not.toContain('## Case studies');
  // The two sections that never depend on published content still render --
  // their absence would mean the whole generator broke, not that the
  // omission rule is working.
  expect(page).toContain('## Resume');
  expect(page).toContain('## MCP');
});

test('/llms.txt links the résumé in all four formats and the MCP endpoint, and serves text/plain', async () => {
  const response = await server.fetch('/llms.txt');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/plain\b/);
  const page = await response.text();
  for (const format of ['/resume.md', '/resume.json', '/resume.pdf', '/resume']) {
    expect(page, `/llms.txt should link ${format}`).toContain(`(https://ryanlindsey.me${format})`);
  }
  // Fix round 1 (task-9-report.md): the endpoint is `/mcp` on that domain,
  // not the bare origin -- the bare origin 404s.
  expect(page, '/llms.txt should link the MCP endpoint').toContain(
    '(https://mcp.ryanlindsey.me/mcp)',
  );
});

test('buildLlmsTxt omits a heading entirely when its link list is empty', () => {
  // The pure-function version of the "today's real state" assertion above --
  // proves the omission rule itself, independent of what is actually
  // published right now.
  const text = buildLlmsTxt({
    summary: 'A test summary.',
    resume: [],
    mcp: [],
    posts: [],
    caseStudies: [],
  });
  expect(text).toBe('# Ryan Lindsey\n\n> A test summary.\n');
  expect(text).not.toContain('##');
});

test('buildLlmsTxt lists a published entry with its .md URL and one-line description (proves the generator works, not just that it currently produces nothing)', () => {
  const fixturePost: LlmsLink = {
    title: 'Fixture Post',
    url: 'https://ryanlindsey.me/writing/fixture-post.md',
    description: 'A fixture post used only to prove the generator works.',
  };
  const text = buildLlmsTxt({
    summary: 'A test summary.',
    resume: [
      { title: 'Resume (Markdown)', url: 'https://ryanlindsey.me/resume.md', description: 'x' },
    ],
    mcp: [{ title: 'MCP server', url: 'https://mcp.ryanlindsey.me', description: 'x' }],
    posts: [fixturePost],
    caseStudies: [],
  });
  expect(text).toContain('## Writing');
  expect(text).toContain(
    '- [Fixture Post](https://ryanlindsey.me/writing/fixture-post.md): A fixture post used only to prove the generator works.',
  );
  // Case studies is still empty in this fixture -- its heading must not
  // appear just because Writing's did.
  expect(text).not.toContain('## Case studies');
});

test("/llms-full.txt is empty while nothing is published (today's real state)", async () => {
  const response = await server.fetch('/llms-full.txt');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/plain\b/);
  const body = await response.text();
  expect(body).toBe('');
});

/**
 * A minimal published `CollectionEntry<'posts'>` fixture, shaped exactly
 * like tests/markdown-export.test.ts's own `post` fixture -- this repo's
 * established pattern for exercising toMarkdown()-adjacent code without a
 * real (draft) content file standing in the way.
 */
const publishedPostFixture = (): CollectionEntry<'posts'> =>
  ({
    id: 'fixture-post',
    collection: 'posts',
    body: 'Fixture body text.',
    data: {
      title: 'Fixture Post',
      description: 'A fixture post used only to prove /llms-full.txt concatenates.',
      publishedAt: new Date('2026-09-01T00:00:00Z'),
      pillar: 'agentic-engineering',
      draft: false,
    },
  }) as unknown as CollectionEntry<'posts'>;

test('buildLlmsFullTxt concatenates a published fixture entry, preceded by its canonical URL (proves the generator works, not just that it currently produces nothing)', () => {
  const text = buildLlmsFullTxt([publishedPostFixture()]);
  expect(text.startsWith('https://ryanlindsey.me/writing/fixture-post/\n\n')).toBe(true);
  expect(text).toContain('title: "Fixture Post"');
  expect(text).toContain('Fixture body text.');
});

test('footer links /llms.txt and the MCP endpoint, and never links /llms-full.txt', async () => {
  const page = await html('/');
  const footer = page.slice(page.indexOf('<footer'));
  expect(footer, 'footer should link /llms.txt').toContain('href="/llms.txt"');
  // Fix round 1 (task-9-report.md): the endpoint is `/mcp` on that domain,
  // not the bare origin -- the bare origin 404s.
  expect(footer, 'footer should link the MCP endpoint').toContain(
    'href="https://mcp.ryanlindsey.me/mcp"',
  );
  // /llms-full.txt is the bulk-ingestion corpus; /llms.txt points at it, so
  // the footer must not link it a second time (task-9-brief.md Step 3).
  expect(page, 'no page should link /llms-full.txt from its footer').not.toContain(
    '/llms-full.txt',
  );
});

// Day 3 Task 12 (02 §3 / research appendix B5): public/robots.txt is a
// hand-authored static file, not a prerendered endpoint, so these tests
// read the file over HTTP the same way every other route in this file is
// checked, rather than reading the source from disk.

test('robots.txt emits and allows every named crawler group, not just the wildcard', async () => {
  const response = await server.fetch('/robots.txt');
  expect(response.status).toBe(200);
  const body = await response.text();

  // Group the file the way RFC 9309 groups it: one or more consecutive
  // `User-agent:` lines share the directives that follow, up to the next
  // `User-agent:` line or end of file. Comments and blank lines are
  // stripped first -- they carry no grouping meaning of their own.
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  const groups: { agents: string[]; directives: string[] }[] = [];
  for (const line of lines) {
    const agentMatch = line.match(/^User-agent:\s*(.+)$/i);
    if (agentMatch) {
      const current = groups[groups.length - 1];
      // Still collecting agent tokens for the same group (no directive seen
      // yet since the last User-agent line) vs. starting a new group.
      if (current && current.directives.length === 0) {
        current.agents.push(agentMatch[1]);
      } else {
        groups.push({ agents: [agentMatch[1]], directives: [] });
      }
    } else if (groups.length > 0) {
      groups[groups.length - 1].directives.push(line);
    }
  }

  const wildcard = groups.find((group) => group.agents.includes('*'));
  expect(wildcard, 'a `*` group must exist').toBeDefined();
  expect(wildcard!.directives).toContain('Allow: /');

  // This is the RFC 9309 §2.2.1 point of the whole task: a named group does
  // not inherit `*`'s Allow, so each one must carry its own or that agent
  // is not actually welcomed by this file.
  const namedGroups = groups.filter((group) => !group.agents.includes('*'));
  expect(namedGroups.length).toBeGreaterThan(0);
  for (const group of namedGroups) {
    expect(group.directives, `${group.agents.join(', ')} should carry its own Allow: /`).toContain(
      'Allow: /',
    );
  }
});

test('robots.txt carries the owner-decided Content-Signal reservation, points at /llms.txt and the MCP endpoint, and ships no Sitemap line', async () => {
  const body = await (await server.fetch('/robots.txt')).text();
  // Owner's decision, 2026-09-06: search/ai-input readable and citable now,
  // ai-train reserved -- see the file's own comment for why these are not
  // the same lever.
  expect(body).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=no, use=reference');
  expect(body).toContain('/llms.txt');
  // Fix round 1 (task-9-report.md, applies here too): the endpoint is `/mcp`
  // on that domain, not the bare origin -- the bare origin 404s.
  expect(body).toContain('https://mcp.ryanlindsey.me/mcp');
  // No sitemap exists yet (`@astrojs/sitemap` is not installed, and the site
  // is noindex sitewide) -- day 7 adds both together.
  expect(body).not.toMatch(/^Sitemap:/m);
});

test('robots.txt documents the group-inheritance trap, the enforceability caveat, and the noindex/permissive-crawl reasoning in the file itself, not only in the plan', async () => {
  // A robots.txt whose warnings live in a planning doc nobody reads has not
  // done its job (task-12-brief.md's own words) -- so these assert against
  // the shipped file's actual text, not against this repo's docs.
  const body = await (await server.fetch('/robots.txt')).text();
  // Comments in this file wrap across multiple `#`-prefixed lines for
  // readability, the way prose does everywhere else in this repo. Join them
  // back into flowing text before matching a phrase that spans a line break
  // -- the same way a human reader (or the person adding a Disallow this
  // note is aimed at) would read them.
  const prose = body.replace(/\n#\s*/g, ' ');

  // 1. RFC 9309 §2.2.1: a named group does not inherit from `*`, so a future
  // Disallow added under `*` would silently exempt every named agent below.
  expect(prose).toContain('RFC 9309');
  expect(prose).toMatch(/does NOT inherit/);
  expect(prose).toMatch(/reasonably assumes that covers every crawler, it will not/);

  // 2. Enforceability: the Allow entries for user-triggered fetchers are
  // written for legibility, not because robots.txt can compel them.
  expect(prose).toMatch(/not because (it is|they are) enforceable/i);

  // 3. The noindex interaction: permissive robots.txt + sitewide noindex is
  // deliberate, and Disallow would be the wrong fix (it would stop a
  // crawler from ever fetching the page far enough to see the noindex tag).
  expect(prose).toContain('noindex');
  expect(prose).toMatch(
    /stops a crawler from fetching a page at all, which stops it from ever seeing/,
  );
});

// Day 3 Task 11 (02 §3): /rss.xml (RSS 2.0, via @astrojs/rss) and
// /feed.json (JSON Feed 1.1, hand-built -- @astrojs/rss is RSS-only).
// task-11-brief.md's own warning: both real .mdx files are still
// draft: true, so today's actual build output is a channel/document with
// ZERO items, and it is explicit that a test asserting only that emptiness
// would be exactly the trap this codebase has already shipped eight times
// (most recently a breadcrumb test that hardcoded the same literal as the
// bug it was meant to catch). So every "today's real state is empty"
// assertion below is paired with a fixture-based assertion against the
// exported generator functions (src/lib/feeds.ts), proving each generator
// actually produces a populated result with the entry's FULL content --
// not its one-line description -- and not just nothing.

test("/rss.xml is a well-formed, empty RSS 2.0 channel while nothing is published (today's real state)", async () => {
  const response = await server.fetch('/rss.xml');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/rss\+xml\b/);
  const xml = await response.text();
  // Well-formed: a real XML declaration, an open channel with the site's own
  // title/link, and a properly closed document -- not just "the body is
  // non-empty" (which a truncated or malformed response would also satisfy).
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(xml).toContain('<rss version="2.0"');
  expect(xml).toContain('<title>Ryan Lindsey</title>');
  expect(xml).toContain('<link>https://ryanlindsey.me/</link>');
  expect(xml.endsWith('</channel></rss>')).toBe(true);
  // Zero items, not a malformed or missing channel: no <item> element at all.
  expect(xml).not.toContain('<item>');
});

test('buildRssFeed emits a published fixture entry with its full content, not just its description (proves the generator works, not just that it currently produces nothing)', async () => {
  const xml = await buildRssFeed([publishedPostFixture()], {
    title: 'Ryan Lindsey',
    description: 'A test summary.',
    site: 'https://ryanlindsey.me',
  });
  expect(xml).toContain('<title>Fixture Post</title>');
  expect(xml).toContain('<link>https://ryanlindsey.me/writing/fixture-post/</link>');
  // The one-line excerpt is still present in <description>...
  expect(xml).toContain(
    '<description>A fixture post used only to prove /llms-full.txt concatenates.</description>',
  );
  // ...but the FULL document -- frontmatter and body -- lives separately in
  // <content:encoded>, which is what 02 §3's "full-content, not summaries"
  // rule is actually asking for.
  expect(xml).toContain('<content:encoded>');
  expect(xml).toContain('title: &quot;Fixture Post&quot;');
  expect(xml).toContain('Fixture body text.');
});

// Task 11 fix round 1: a deliberate future gate, not a check on today's
// code. src/lib/feeds.ts's rssItemFor puts raw toMarkdown() output in
// <content:encoded>, which conventionally carries HTML -- a real feed
// reader would render literal "##"/"**"/fenced code rather than formatted
// prose. That is harmless today only because /rss.xml has zero items (both
// real content entries are drafts); this test passes for exactly that
// reason and is meant to start FAILING the moment it stops being true,
// mirroring tests/resume.test.ts's test.fails completeness gate but in the
// opposite direction -- green until content ships, then red -- so the
// choice src/lib/feeds.ts's comment names (render MDX to real HTML for
// <content:encoded>, or keep markdown and say so honestly in the feed's
// own <description>) cannot be silently forgotten once it actually
// matters.
test('TRIPWIRE: a published RSS item must not ship raw markdown in <content:encoded> (forces a real decision the moment this goes red -- see src/lib/feeds.ts)', async () => {
  const xml = await (await server.fetch('/rss.xml')).text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  // No loop body runs while items is empty -- that IS this test passing
  // today, not a weaker check standing in for a real one.
  for (const [, itemXml] of items) {
    const contentMatch = itemXml.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/);
    expect(contentMatch, 'a published item should still carry <content:encoded>').not.toBeNull();
    // Undo the entities fast-xml-parser's XMLBuilder actually emits for
    // this content (verified against the populated-fixture test above) so
    // these patterns match the real markdown text, not its escaped form.
    const decoded = contentMatch![1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
    expect(
      decoded,
      '<content:encoded> looks like an unrendered markdown heading -- see src/lib/feeds.ts',
    ).not.toMatch(/^#{1,6} /m);
    expect(
      decoded,
      '<content:encoded> looks like an unrendered markdown link -- see src/lib/feeds.ts',
    ).not.toMatch(/\]\(/);
    expect(
      decoded,
      '<content:encoded> looks like an unrendered fenced code block -- see src/lib/feeds.ts',
    ).not.toMatch(/^```/m);
  }
});

test("/feed.json is a well-formed, empty JSON Feed 1.1 document while nothing is published (today's real state)", async () => {
  const response = await server.fetch('/feed.json');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/feed\+json\b/);
  const feed = (await response.json()) as JsonFeed;
  expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
  expect(feed.title).toBe('Ryan Lindsey');
  expect(feed.home_page_url).toBe('https://ryanlindsey.me/');
  expect(feed.feed_url).toBe('https://ryanlindsey.me/feed.json');
  // A well-formed feed with zero items, not a malformed document: the
  // `items` key is present and is an empty array, not omitted or null.
  expect(Array.isArray(feed.items)).toBe(true);
  expect(feed.items).toHaveLength(0);
});

test('buildJsonFeed emits a published fixture entry with its full content, not just its description (proves the generator works, not just that it currently produces nothing)', () => {
  const feed = buildJsonFeed([publishedPostFixture()], {
    title: 'Ryan Lindsey',
    description: 'A test summary.',
    homePageUrl: 'https://ryanlindsey.me/',
    feedUrl: 'https://ryanlindsey.me/feed.json',
  });
  expect(feed.items).toHaveLength(1);
  const [item] = feed.items;
  expect(item.id).toBe('https://ryanlindsey.me/writing/fixture-post/');
  expect(item.url).toBe('https://ryanlindsey.me/writing/fixture-post/');
  expect(item.title).toBe('Fixture Post');
  expect(item.summary).toBe('A fixture post used only to prove /llms-full.txt concatenates.');
  // The FULL document -- frontmatter and body -- lives in content_text, and
  // it must actually differ from the one-line summary, not just duplicate it.
  expect(item.content_text).toContain('title: "Fixture Post"');
  expect(item.content_text).toContain('Fixture body text.');
  expect(item.content_text).not.toBe(item.summary);
});

test('serves RSS and JSON Feed autodiscovery link tags sitewide, and both feeds resolve', async () => {
  const page = await html('/');
  const head = page.slice(0, page.indexOf('</head>'));
  expect(head).toContain(
    '<link rel="alternate" type="application/rss+xml" title="Ryan Lindsey" href="/rss.xml">',
  );
  expect(head).toContain(
    '<link rel="alternate" type="application/feed+json" title="Ryan Lindsey" href="/feed.json">',
  );
  // A page and its advertised feed should agree on where the feed lives --
  // same reasoning as the .md rel="alternate" test above.
  for (const feedPath of ['/rss.xml', '/feed.json']) {
    expect((await server.fetch(feedPath)).status, `${feedPath} should resolve`).toBe(200);
  }
});
