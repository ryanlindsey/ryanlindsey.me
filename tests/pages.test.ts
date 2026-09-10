import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import type { CollectionEntry } from 'astro:content';
import { SITE_HARNESS_WORKERS } from './workers';
import { BANNED_PATTERNS } from './candidacy-patterns';
import { formatDateRange } from '../src/lib/resume';
import { buildLlmsTxt, buildLlmsFullTxt, type LlmsLink } from '../src/lib/llms-index';
import { buildRssFeed, buildJsonFeed, RSS_MARKDOWN_NOTICE, type JsonFeed } from '../src/lib/feeds';
// The RSS tripwire's arming assertion runs the patterns against `toMarkdown()`
// output, which is what `rssItemFor` used to ship and what a regression would
// ship again -- see the tripwire's own comment.
import { toMarkdown } from '../src/lib/markdown-export';

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
  // BANNED_PATTERNS lives in ./candidacy-patterns.ts (Day 4 Task 15), not here,
  // so the MCP surface check in tests/mcp-tools.test.ts can share this exact
  // list rather than hand-typing a second one that could silently drift from
  // it -- see that module's own comment for why it is a separate file and not
  // an export straight off this one.
  for (const route of [
    '/',
    '/writing',
    '/work',
    '/resume',
    // Day 3 Task 13: every day-3 format/aggregation surface Tasks 3, 9, 11
    // and 12 added, extending this check past the six routes it originally
    // covered (task-13-brief.md Step 3). /resume.md and /resume.json are
    // the other two résumé formats alongside the HTML page above.
    '/resume.md',
    '/resume.json',
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
    // Day 3 Task 12: robots.txt is a public, hand-authored file that
    // welcomes named crawlers by name -- it must carry no candidacy
    // language either.
    '/robots.txt',
    // Day 3 Task 13: every discovered content entry's HTML page AND its
    // `.md` sibling (task-13-brief.md's "the .md variants"), read off
    // CONTENT_ENTRIES above rather than hardcoded as the two specimen
    // routes this list used to name directly -- a route added later is
    // covered automatically, the same reasoning every other CONTENT_ENTRIES
    // loop in this file already gives. Drafts are included on purpose: a
    // draft is reachable by URL (the detail tier of the draft rule) and
    // must carry no candidacy language either, exactly like a published
    // page.
    ...CONTENT_ENTRIES.flatMap((entry) => [
      `/${entry.section}/${entry.slug}`,
      `/${entry.section}/${entry.slug}.md`,
    ]),
  ]) {
    const page = await html(route);
    for (const pattern of BANNED_PATTERNS) {
      expect(page, `${route} must not match ${pattern}`).not.toMatch(pattern);
    }
  }

  // Day 5 Task 16: /fit itself (04 §2), asserted as its own case rather than
  // folded into the loop above -- the loop's `html()` helper requires 200,
  // and an ungranted /fit does not answer with one.
  //
  // src/pages/fit/index.astro's OWN answer to an ungranted caller is a bare,
  // empty 404, but that is not what reaches this fetch: src/worker.ts
  // replaces every /fit refusal with the SITE'S OWN 404 page
  // (src/pages/404.astro, ~5 KB, byte-identical to an unrouted path's --
  // tests/fit-pages.test.ts's "an un-granted /fit is indistinguishable from a
  // path that does not exist" is the test that measures that) before the
  // caller ever sees it. So the response is not bodyless, the body IS
  // scannable, and scanning it is strictly stronger than the status-only
  // check this used to be -- src/pages/404.astro renders nothing derived
  // from the request, so this stays true regardless of which dead path
  // produced it. The GRANTED renderings -- the ones that actually carry the
  // analyser's copy -- are scanned in tests/fit-pages.test.ts's own "the page
  // copy carries no search language" (the form) and "the permalink page copy
  // carries no search language" (a stored report).
  const fitRefusal = await server.fetch('/fit');
  expect(fitRefusal.status).toBe(404);
  const fitRefusalBody = await fitRefusal.text();
  for (const pattern of BANNED_PATTERNS) {
    expect(fitRefusalBody, `/fit's refusal body must not match ${pattern}`).not.toMatch(pattern);
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
    ['projects', 'Projects'],
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
  // Bounded by the NEXT top-level key rather than by `education:` by name.
  // This slice used to run work -> education and broke the day a `projects:`
  // section landed between the two: every project was parsed as a work entry
  // and threw on the missing startDate. Any future top-level section now ends
  // the block correctly without touching this test.
  const workStart = yaml.indexOf('\nwork:');
  const nextTopLevelKey = /\n[a-z][a-zA-Z]*:/g;
  nextTopLevelKey.lastIndex = workStart + 1;
  const workEnd = nextTopLevelKey.exec(yaml)?.index ?? yaml.length;
  const workBlock = yaml.slice(workStart, workEnd);
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

test('/resume advertises its own .md variant, in both the link tag and the header', async () => {
  // FIX ROUND 2: /resume was the one content page with a `.md` twin, a
  // `run_worker_first` entry and Accept-negotiation (src/worker.ts) that
  // advertised none of it -- src/pages/resume.astro passed no `markdownHref`,
  // so no <link rel="alternate"> was emitted, and public/_headers had no
  // X-Markdown-Variant rule for it. Every draft blog post got all three; the
  // résumé, the page an agent is most likely to fetch, got none. Asserted the
  // same way the /writing and /work pages are above -- tag, header, and the
  // href actually resolving -- because it is the same claim.
  const response = await server.fetch('/resume');
  expect(response.status, '/resume should be 200').toBe(200);
  const page = await response.text();
  const head = page.slice(0, page.indexOf('</head>'));

  expect(head, '/resume should carry rel="alternate" pointing at /resume.md').toContain(
    '<link rel="alternate" type="text/markdown" href="/resume.md">',
  );
  expect(
    response.headers.get('x-markdown-variant'),
    '/resume should carry X-Markdown-Variant: /resume.md',
  ).toBe('/resume.md');

  const markdownResponse = await server.fetch('/resume.md');
  expect(markdownResponse.status, "/resume's markdown link should actually resolve").toBe(200);
  // The same exclusivity guard the /writing and /work test makes: the
  // `/resume/` (X-Markdown-Variant) and `/resume.md` (Content-Type) rules in
  // public/_headers are written never to match the same request, because
  // Cloudflare comma-joins repeated header names across matching rules rather
  // than letting the more specific one win.
  expect(
    markdownResponse.headers.get('x-markdown-variant'),
    '/resume.md itself should not carry X-Markdown-Variant',
  ).toBeNull();
});

test('every page carries rel="describedby" -> /llms.txt, including the ones with no .md twin', async () => {
  // FIX ROUND 2: `describedby` used to sit INSIDE Base.astro's `markdownHref
  // &&` block, which made "is this page described by /llms.txt?" accidentally
  // conditional on "does this page have a markdown twin?" -- so the home page
  // and both index pages, the three pages with no twin, advertised no llms.txt
  // at all. Base.astro's own comment states the principle it was violating:
  // this site has one root-level, unscoped /llms.txt, so EVERY page is covered
  // by it, exactly like the two sitewide feed links directly above it.
  //
  // The three paths below are chosen for exactly that reason: they are the
  // pages with no markdown variant, i.e. the ones the old placement dropped
  // the tag from. /resume and the detail pages are covered by the tests above.
  for (const path of ['/', '/writing', '/work']) {
    const page = await html(path);
    const head = page.slice(0, page.indexOf('</head>'));
    expect(head, `${path} should carry rel="describedby" pointing at /llms.txt`).toContain(
      '<link rel="describedby" href="/llms.txt">',
    );
    // ...and must NOT have gained a markdown alternate along the way: the two
    // tags are independent facts, and hoisting one must not hoist the other.
    expect(head, `${path} has no .md twin and must not claim one`).not.toContain(
      'type="text/markdown"',
    );
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

test('/llms.txt carries a Case studies section listing every published case study, and still omits Writing while no post is published', async () => {
  const page = await html('/llms.txt');
  expect(page).toContain('# Ryan Lindsey');
  expect(page).toMatch(/^> \S/m);

  // The published half. Derived from CONTENT_ENTRIES rather than hardcoded,
  // so a third case study is covered the day it lands -- the same reasoning
  // that file-level comment gives for reading entries off disk at all.
  const publishedWork = CONTENT_ENTRIES.filter((e) => e.section === 'work' && !e.draft);
  expect(publishedWork.length, 'expected at least one published case study').toBeGreaterThan(0);
  expect(page).toContain('## Case studies');
  for (const entry of publishedWork) {
    expect(page, `/llms.txt should link /work/${entry.slug}.md`).toContain(
      `(https://ryanlindsey.me/work/${entry.slug}.md)`,
    );
  }
  for (const entry of CONTENT_ENTRIES.filter((e) => e.section === 'work' && e.draft)) {
    expect(page, `/llms.txt must not link the draft /work/${entry.slug}`).not.toContain(
      `/work/${entry.slug}.md`,
    );
  }

  // The omission half, still live: every post is a draft, so `buildSection`'s
  // no-empty-scaffolding rule must still drop the Writing heading entirely.
  // This is what keeps the rule under test now that the section above it is
  // populated -- had both gone published at once, nothing here would still be
  // checking that an empty section is omitted rather than rendered bare.
  expect(
    CONTENT_ENTRIES.some((e) => e.section === 'writing' && !e.draft),
    'expected every post to still be a draft; if one shipped, this test needs the ' +
      'omission assertion moved to whichever section is still empty',
  ).toBe(false);
  expect(page).not.toContain('## Writing');

  // The three sections that never depend on published content still render --
  // their absence would mean the whole generator broke, not that the
  // omission rule is working.
  expect(page).toContain('## Resume');
  expect(page).toContain('## MCP');
  // Day 6: the site's own interactive surfaces. `/fit` is NOT here and must not
  // be -- it is unlisted by requirement (09 §1), pinned separately below.
  expect(page).toContain('## Site');
  expect(page).toContain('https://ryanlindsey.me/chat');
  expect(page).toContain('## Full content');
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
  // Fix round 2: /llms-full.txt had zero inbound links from anywhere on the
  // site, while this file's own footer test, src/pages/llms-full.txt.ts and
  // src/components/SiteFooter.astro each justified their shape by asserting
  // that /llms.txt linked it. This is the assertion that keeps that true.
  expect(page, '/llms.txt should link its bulk-ingest sibling').toContain(
    '(https://ryanlindsey.me/llms-full.txt)',
  );
});

test('/llms.txt describes the MCP server current tool map, not the stale one-tool description', async () => {
  // Task 12 (03 §1): tools/list grew to eight tools across Tasks 6-11, and
  // this file's own MCP description still said "One tool today: get_contact"
  // -- false since Task 6. The MCP Worker's registrations are not reachable
  // from Astro at build time (astro:content and the Worker's own module
  // graph are two separate builds -- see src/pages/llms.txt.ts's module
  // doc), so MCP_LINKS' description is written literally rather than
  // generated.
  //
  // NARROW guard, deliberately: this only proves the specific regression
  // above is fixed (the stale line is gone, `search_writing` is named) --
  // it says nothing about a NINTH tool added later with no matching update
  // here, and would stay green if that happened. The guard that actually
  // covers every tool is tests/mcp-tools.test.ts's "/llms.txt names every
  // registered tool": this harness (SITE_HARNESS_WORKERS) boots the MCP Worker
  // too, so that assertion COULD live here, but mcp-tools.test.ts already
  // exports an `rpc` helper for talking to the MCP Worker by name and already
  // asserts (in its own `beforeAll`) that this harness's MCP Worker reads the
  // SAME build this site serves -- reusing that rather than re-deriving the
  // same JSON-RPC/SSE plumbing a second time here.
  const page = await html('/llms.txt');
  expect(page).not.toContain('One tool today');
  expect(page).toContain('search_writing');
});

test('buildLlmsTxt omits a heading entirely when its link list is empty', () => {
  // The pure-function version of the "today's real state" assertion above --
  // proves the omission rule itself, independent of what is actually
  // published right now.
  const text = buildLlmsTxt({
    summary: 'A test summary.',
    resume: [],
    mcp: [],
    site: [],
    posts: [],
    caseStudies: [],
    full: [],
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
    // `/mcp`, not the bare origin: the custom domain is only the host and the
    // bare origin 404s (task-9-report.md's fix round 1, and the value both the
    // real /llms.txt and the footer assert above). A fixture is a worked
    // example a reader copies, so shipping the known-wrong URL in one -- in the
    // same file that asserts the right one twice -- is worth the two words.
    mcp: [{ title: 'MCP server', url: 'https://mcp.ryanlindsey.me/mcp', description: 'x' }],
    site: [{ title: 'Ask my agent', url: 'https://ryanlindsey.me/chat', description: 'x' }],
    posts: [fixturePost],
    caseStudies: [],
    full: [
      {
        title: 'All content (llms-full.txt)',
        url: 'https://ryanlindsey.me/llms-full.txt',
        description: 'x',
      },
    ],
  });
  expect(text).toContain('## Writing');
  // The bulk-ingest sibling comes last, after the curated lists.
  expect(text.indexOf('## Full content')).toBeGreaterThan(text.indexOf('## Writing'));
  expect(text).toContain(
    '- [Fixture Post](https://ryanlindsey.me/writing/fixture-post.md): A fixture post used only to prove the generator works.',
  );
  // Case studies is still empty in this fixture -- its heading must not
  // appear just because Writing's did.
  expect(text).not.toContain('## Case studies');
});

test('/llms-full.txt concatenates every published document, each preceded by its canonical URL, and carries no draft', async () => {
  const response = await server.fetch('/llms-full.txt');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/plain\b/);
  const body = await response.text();

  const published = CONTENT_ENTRIES.filter((entry) => !entry.draft);
  const drafts = CONTENT_ENTRIES.filter((entry) => entry.draft);
  expect(published.length, 'expected at least one published entry').toBeGreaterThan(0);
  expect(drafts.length, 'expected at least one draft entry').toBeGreaterThan(0);

  for (const entry of published) {
    expect(body, `/llms-full.txt should carry ${entry.section}/${entry.slug}`).toContain(
      `https://ryanlindsey.me/${entry.section}/${entry.slug}/\n\n`,
    );
  }
  // This is the site's highest-risk leak surface (the route-scan comment near
  // the top of this file says so in task-9-brief.md's own words), and the
  // draft filter is the only thing between an unfinished document and one
  // response containing everything. So the exclusion is asserted here too,
  // not just on the smaller index.
  for (const entry of drafts) {
    expect(body, `/llms-full.txt must not carry the draft ${entry.slug}`).not.toContain(
      `/${entry.section}/${entry.slug}/`,
    );
  }
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

// Day 4 Task 13 (03 §1): `https://ryanlindsey.me/mcp` is the PRIMARY MCP
// endpoint, `mcp.ryanlindsey.me` the vanity alias -- so this origin must
// serve the protocol rather than 404. `server.fetch()` in this file always
// addresses the site Worker (SITE_HARNESS_WORKERS lists it first, making it
// the harness's primary), so these two exercise the forward over the `MCP`
// service binding end to end, not the MCP Worker directly the way
// tests/mcp-tools.test.ts and tests/mcp.smoke.test.ts do.

test('/mcp on the site origin completes the MCP handshake', async () => {
  const response = await server.fetch('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'site', version: '0' },
      },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('ryanlindsey-me');
  // CORS parity between the two origins is the point of Task 2's opened
  // policy (workers/mcp/src/index.ts's HANDLER_OPTIONS), and every response
  // the MCP Worker returns -- this one included -- is wrapped in `withCors`
  // unconditionally from that config, regardless of the request's own Origin
  // (node_modules/agents' handler-stateless.ts). So these are assertable
  // proof that the forward carries CORS behavior across the service-binding
  // hop intact, not just that *some* response came back: a browser client at
  // https://ryanlindsey.me/mcp must see the same CORS posture a client at
  // mcp.ryanlindsey.me/mcp does.
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('access-control-allow-headers')).toBe(
    'content-type, accept, mcp-session-id, mcp-protocol-version, authorization',
  );
});

test('/mcp is not swallowed by the SPA 404 page', async () => {
  const response = await server.fetch('/mcp');
  expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
});

test('/mcp on the site origin answers a CORS preflight, Origin and requested headers included', async () => {
  // The transport's OPTIONS branch (node_modules/agents' handler-stateless.ts)
  // answers before any JSON-RPC handling runs, so this exercises a different
  // code path than the POST handshake above -- and it is exactly the request
  // a real browser MCP client sends before its actual call, which is why
  // Task 2 (03 §1) and this task's own constraints both single preflights out
  // by name. Reaching this response at all already proves the OPTIONS method
  // and the Origin/Access-Control-Request-* headers survived the forward: the
  // route-matching check ahead of this branch would 404 first otherwise.
  const response = await server.fetch('/mcp', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://claude.ai',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,mcp-protocol-version',
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  expect(response.headers.get('access-control-allow-headers')).toBe(
    'content-type, accept, mcp-session-id, mcp-protocol-version, authorization',
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

test('/rss.xml is a well-formed RSS 2.0 channel carrying one item per published entry and none per draft', async () => {
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

  // Exact count, not "at least one": an item appearing for a draft is the
  // failure this is really watching for, and a subset check would miss it.
  const published = CONTENT_ENTRIES.filter((entry) => !entry.draft);
  expect(published.length, 'expected at least one published entry').toBeGreaterThan(0);
  expect([...xml.matchAll(/<item>/g)]).toHaveLength(published.length);
  for (const entry of published) {
    expect(xml, `/rss.xml should link ${entry.section}/${entry.slug}`).toContain(
      `<link>https://ryanlindsey.me/${entry.section}/${entry.slug}/</link>`,
    );
  }

  // src/lib/feeds.ts keeps Markdown in <content:encoded> and discloses it
  // here rather than rendering MDX to HTML. The disclosure is part of the
  // feed's contract with a subscriber, so it is asserted, not assumed.
  expect(xml).toContain(RSS_MARKDOWN_NOTICE);
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
  // ...but the FULL document, not just that excerpt, lives separately in
  // <content:encoded>, which is what 02 §3's "full-content, not summaries"
  // rule is actually asking for.
  expect(xml).toContain('<content:encoded>');
  expect(xml).toContain('Fixture body text.');
  // FIX ROUND 2: this test used to also assert
  // `toContain('title: &quot;Fixture Post&quot;')` -- i.e. it pinned the
  // literal YAML frontmatter block `toMarkdown()` puts in front of the body
  // as DESIRED output. It is not: it is the known defect src/lib/feeds.ts
  // documents (raw markdown in a field feed readers render as HTML), and
  // certifying it here quietly contradicted the tripwire test below, whose
  // whole job is to force a decision about it. What that frontmatter block
  // means for the feed is asserted where it belongs instead -- see the
  // "armed" assertion in the tripwire test, which requires these very
  // patterns to fire on this very fixture.
});

// Task 11's deliberate future gate, now fired and re-armed. It was written to
// pass while /rss.xml was empty and to start FAILING the moment a published
// entry actually shipped markdown into <content:encoded>, so that the choice
// src/lib/feeds.ts deferred -- render MDX to real HTML, or keep markdown and
// say so honestly in the feed's own <description> -- had to be made for real
// rather than silently shipped either way. Publishing the first two case
// studies fired it, and the second option was taken.
//
// A fired tripwire is not a spent one. What changed is what it guards. The
// broad "no markdown at all" list below could not survive the decision -- the
// feed now ships markdown ON PURPOSE and says so -- so the forbidden set
// narrows to the one thing that is still a defect rather than a disclosure:
//
//   - a YAML frontmatter fence, which is metadata the item already carries in
//     its own <title>/<link>/<description>/<pubDate> elements, duplicated into
//     the body as text. It is the specific thing rssItemFor stopped doing by
//     calling stripNonPortableMdx instead of toMarkdown, and this is the
//     assertion that stops it coming back.
//
// Everything else -- headings, bold, fences, list items, blockquotes and
// links -- degrades visibly but LOSSLESSLY, which is the line between the two
// sets. `[text](url)` is worth naming because it looks like the exception and
// is not: unrendered, the URL is still right there in the text for a reader to
// read or copy. Nothing is withheld, only unstyled, and that is exactly what
// RSS_MARKDOWN_NOTICE tells subscribers to expect.
//
// Those patterns stay in the list below rather than being deleted, because the
// second test in this pair asserts they DO appear -- which is what keeps the
// notice honest if the feed ever quietly starts emitting HTML instead.
const RSS_MARKDOWN_PATTERNS: { name: string; pattern: RegExp; forbidden: boolean }[] = [
  { name: 'a YAML frontmatter fence', pattern: /^---[ \t]*$/m, forbidden: true },
  { name: 'an unrendered markdown link', pattern: /\]\(/, forbidden: false },
  { name: 'an unrendered markdown heading', pattern: /^#{1,6} /m, forbidden: false },
  { name: 'an unrendered fenced code block', pattern: /^```/m, forbidden: false },
  { name: 'an unrendered list item', pattern: /^[-*] /m, forbidden: false },
  { name: 'an unrendered blockquote', pattern: /^> /m, forbidden: false },
  { name: 'unrendered bold', pattern: /\*\*[^*\n]+\*\*/, forbidden: false },
];

/** Undo the entities fast-xml-parser's XMLBuilder emits, then name what matched. */
const decodeEncoded = (encodedContent: string): string =>
  encodedContent
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');

const matchingPatterns = (encodedContent: string, forbiddenOnly: boolean): string[] => {
  const decoded = decodeEncoded(encodedContent);
  return RSS_MARKDOWN_PATTERNS.filter(
    ({ pattern, forbidden }) => (forbidden || !forbiddenOnly) && pattern.test(decoded),
  ).map(({ name }) => name);
};

const encodedContentsOf = (xml: string): string[] =>
  [...xml.matchAll(/<content:encoded>([\s\S]*?)<\/content:encoded>/g)].map((match) => match[1]);

test('TRIPWIRE: a published RSS item must not ship a YAML frontmatter fence in <content:encoded> (see src/lib/feeds.ts)', async () => {
  // ARMED. Before asserting anything about the real feed, prove the patterns
  // can match at all -- against toMarkdown() output, which is what rssItemFor
  // used to ship and what a regression would ship again. Without this the
  // assertion below could pass because the patterns are broken rather than
  // because the feed is clean, which is the exact trap this file has been
  // caught by before.
  const regressionShape = toMarkdown(publishedPostFixture());
  expect(
    matchingPatterns(regressionShape, true),
    'these patterns must fire on toMarkdown() output -- a tripwire that cannot match ' +
      'the regression it watches for is not a tripwire',
  ).toContain('a YAML frontmatter fence');

  const xml = await (await server.fetch('/rss.xml')).text();
  const contents = encodedContentsOf(xml);
  // Every published item must HAVE the element, and there must be items: an
  // empty feed would otherwise satisfy the loop below by running zero times.
  expect(contents).toHaveLength(CONTENT_ENTRIES.filter((entry) => !entry.draft).length);
  expect(contents.length).toBeGreaterThan(0);

  for (const content of contents) {
    expect(
      matchingPatterns(content, true),
      '<content:encoded> is carrying something the feed does not disclose and cannot ' +
        'render -- see src/lib/feeds.ts and RSS_MARKDOWN_NOTICE',
    ).toEqual([]);
  }
});

test('the disclosed markdown really is present, so RSS_MARKDOWN_NOTICE is an honest statement rather than a stale one', async () => {
  // The other side of the decision. The notice tells subscribers the content
  // is Markdown; if a later change quietly started rendering HTML, the notice
  // would become a lie and nothing above would catch it, because "no markdown"
  // is what the forbidden list wants. This test fails in that direction.
  const xml = await (await server.fetch('/rss.xml')).text();
  const contents = encodedContentsOf(xml);
  expect(contents.length).toBeGreaterThan(0);
  const disclosed = contents.flatMap((content) => matchingPatterns(content, false));
  expect(
    disclosed,
    'RSS_MARKDOWN_NOTICE claims items carry Markdown source; nothing markdown-shaped ' +
      'was found, so either the notice is now wrong or the feed changed format',
  ).toContain('an unrendered markdown heading');
});

test('/feed.json is a well-formed JSON Feed 1.1 document carrying one item per published entry and none per draft', async () => {
  const response = await server.fetch('/feed.json');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^application\/feed\+json\b/);
  const feed = (await response.json()) as JsonFeed;
  expect(feed.version).toBe('https://jsonfeed.org/version/1.1');
  expect(feed.title).toBe('Ryan Lindsey');
  expect(feed.home_page_url).toBe('https://ryanlindsey.me/');
  expect(feed.feed_url).toBe('https://ryanlindsey.me/feed.json');
  expect(Array.isArray(feed.items)).toBe(true);

  const published = CONTENT_ENTRIES.filter((entry) => !entry.draft);
  expect(published.length, 'expected at least one published entry').toBeGreaterThan(0);
  expect(feed.items).toHaveLength(published.length);
  const urls = feed.items.map((item) => item.url);
  for (const entry of published) {
    expect(urls).toContain(`https://ryanlindsey.me/${entry.section}/${entry.slug}/`);
  }

  // Unlike RSS, `content_text` IS the correct JSON Feed field for markdown
  // (src/lib/feeds.ts's note), so the full document -- frontmatter block
  // included -- belongs here and must differ from the one-line summary.
  for (const item of feed.items) {
    expect(item.content_text).toContain('title:');
    expect(item.content_text).not.toBe(item.summary);
  }
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
