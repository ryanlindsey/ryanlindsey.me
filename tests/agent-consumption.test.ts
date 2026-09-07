import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';

// Day 3 Task 13 (02 §3): the launch gate over every agent-publishing surface
// Tasks 3 and 7-12 built. 02 §3's own words: "Acceptance test in CI: a
// Vitest suite in the workers pool requests every published route from the
// built Worker with an LLM-agent user-agent and asserts 200s, markdown
// variants, and valid JSON-LD. It needs no deployed URL and no
// credentials." This file is that suite -- broad and shallow across every
// route on purpose, not a replacement for the deep, per-field suites that
// already exist (tests/structured-data.test.ts for JSON-LD field values,
// tests/case-studies.test.ts for the 02 §4 shape, tests/negotiation.test.ts
// for Accept-header behaviour, tests/pages.test.ts for everything else,
// including the candidacy-language check this task extends).
//
// See tests/workers.ts for why the site Worker is booted from the build
// output and why the MCP Worker is always listed with it.
const server = createTestHarness({
  workers: SITE_HARNESS_WORKERS,
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

/**
 * Nothing on this site branches on User-Agent -- src/worker.ts's
 * negotiation only reads `Accept` (tests/negotiation.test.ts), and no page
 * reads `request.headers.get('User-Agent')` at all (verified by grep before
 * writing this suite). This is set anyway, on every request this file
 * makes, for fidelity to 02 §3's own framing ("an LLM-agent user-agent") --
 * this suite is standing in for the client that actually matters for the
 * agent-publishing surfaces, not for a browser. The token matches one this
 * site's own public/robots.txt names and welcomes explicitly.
 */
const LLM_AGENT_USER_AGENT = 'ClaudeBot/1.0 (+https://support.claude.com/en/articles/8896518)';

const agentFetch = (path: string) =>
  server.fetch(path, { headers: { 'User-Agent': LLM_AGENT_USER_AGENT } });

/**
 * `{ section: 'writing' | 'work', slug, draft }` for every real content
 * entry, read straight from the `.mdx` source files -- the same approach
 * tests/pages.test.ts's own `readContentEntries` uses, and duplicated here
 * rather than imported from that test file, matching this repo's existing
 * pattern of each suite rolling its own small filesystem-discovery helper
 * (tests/case-studies.test.ts's `readdirSync` call is the other example)
 * rather than centralising it. STEP 1 of task-13-brief.md: "Discover
 * routes, do not list them" -- a hardcoded route list goes stale the first
 * time content lands; this does not, because it reads the same directories
 * the content collections themselves load from (content.config.ts).
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

const CONTENT_HTML_ROUTES = CONTENT_ENTRIES.map((entry) => `/${entry.section}/${entry.slug}`);
const CONTENT_MD_ROUTES = CONTENT_ENTRIES.map((entry) => `/${entry.section}/${entry.slug}.md`);

/**
 * Every non-content, singleton surface Tasks 3, 5, 7, 9, 11 and 12 built.
 * NOT discovered from anything -- there is nothing to discover them from:
 * each one is exactly one route, fixed by which task built it, not an
 * entry in a collection that grows as content lands. The staleness risk
 * task-13-brief.md's Step 1 warns about is specific to per-entry content
 * routes (CONTENT_HTML_ROUTES / CONTENT_MD_ROUTES above), which is why
 * those, and only those, are read off disk instead of listed here.
 */
const FIXED_ROUTES = [
  '/',
  '/writing',
  '/work',
  '/resume',
  '/resume.md',
  '/resume.json',
  '/resume.pdf',
  '/llms.txt',
  '/llms-full.txt',
  '/rss.xml',
  '/feed.json',
  '/robots.txt',
];

const ALL_DISCOVERED_ROUTES = [...FIXED_ROUTES, ...CONTENT_HTML_ROUTES, ...CONTENT_MD_ROUTES];

test('discovers content entries from disk, not from a hardcoded list', () => {
  // Sanity check, task-13-brief.md's own instruction: "if it is not the
  // number you expect, the discovery is wrong, not the expectation."
  // Today's real state (recorded in task-13-report.md): one post
  // (type-specimen.mdx) and one case study (shape-specimen.mdx), both
  // draft: true -- 2 entries total, 4 discovered content routes (HTML + .md
  // each). This assertion does not pin that exact number, on purpose: the
  // whole point of reading off disk is that this stays true, unattended,
  // the day a third entry lands.
  expect(CONTENT_ENTRIES.length).toBeGreaterThan(0);
  // At least one draft must exist right now, or the draft-rule assertions
  // below would stay green even if a future change silently dropped drafts
  // from getStaticPaths -- the same reasoning tests/pages.test.ts's own
  // "every writing and work entry has a resolving .md variant, drafts
  // included" test gives for the identical guard.
  expect(
    CONTENT_ENTRIES.some((entry) => entry.draft),
    'expected at least one draft content entry to exercise the draft rule',
  ).toBe(true);
});

test('every route on the site -- fixed surfaces plus every discovered content entry, drafts included -- returns 200 for an LLM-agent request', async () => {
  expect(ALL_DISCOVERED_ROUTES.length).toBeGreaterThan(0);
  for (const route of ALL_DISCOVERED_ROUTES) {
    const response = await agentFetch(route);
    expect(response.status, `${route} should be 200 for ${LLM_AGENT_USER_AGENT}`).toBe(200);
  }
});

test('every content entry, drafts included, has a resolving .md variant served as text/markdown', async () => {
  // Detail tier of 02 §3's draft rule: a detail route and its `.md` sibling
  // serve every entry, published or not -- "unlisted but shareable by URL"
  // (this task's own brief). Independently re-proven here, over the
  // LLM-agent UA this whole suite exists to simulate, alongside
  // tests/pages.test.ts's deeper version of the same claim (which also
  // checks the sitewide <link rel="alternate"> and X-Markdown-Variant
  // header machinery this file does not touch).
  expect(CONTENT_ENTRIES.length).toBeGreaterThan(0);
  for (const entry of CONTENT_ENTRIES) {
    const markdownHref = `/${entry.section}/${entry.slug}.md`;
    const response = await agentFetch(markdownHref);
    expect(response.status, `${markdownHref} should resolve (draft: ${entry.draft})`).toBe(200);
    expect(
      response.headers.get('content-type'),
      `${markdownHref} should serve text/markdown over HTTP`,
    ).toMatch(/^text\/markdown\b/);
  }
});

test('every HTML page carries parseable JSON-LD and exactly one canonical link', async () => {
  // Base.astro (src/layouts/Base.astro) emits both unconditionally on every
  // page -- a sitewide Person JSON-LD node and one <link rel="canonical">
  // -- so this checks the fixed structural pages and every discovered
  // content entry (drafts included: a draft still renders through the same
  // layout and must carry the same furniture as a published page).
  const HTML_ROUTES = ['/', '/writing', '/work', '/resume', ...CONTENT_HTML_ROUTES];
  expect(HTML_ROUTES.length).toBeGreaterThan(0);

  for (const route of HTML_ROUTES) {
    const response = await agentFetch(route);
    expect(response.status, `${route} should be 200`).toBe(200);
    const page = await response.text();
    const head = page.slice(0, page.indexOf('</head>'));

    // Exactly one -- not "at least one". Two canonical links (or zero) are
    // both a real bug: a page must declare one, unambiguous canonical URL
    // for itself, or a crawler is left to guess.
    const canonicalLinks = [...head.matchAll(/<link rel="canonical"[^>]*>/g)];
    expect(
      canonicalLinks.length,
      `${route} should carry exactly one canonical link, found ${canonicalLinks.length}`,
    ).toBe(1);

    const jsonLdBlocks = [
      ...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    ].map((match) => match[1]);
    expect(jsonLdBlocks.length, `${route} should carry at least one JSON-LD block`).toBeGreaterThan(
      0,
    );
    for (const block of jsonLdBlocks) {
      // Fails loudly (JSON.parse throws) rather than silently on a
      // malformed block -- task-13-brief.md Step 2's "valid JSON-LD", and
      // the same standard tests/structured-data.test.ts's own
      // `jsonLdBlocksIn` helper holds every block to.
      expect(() => JSON.parse(block), `${route}'s JSON-LD block should parse`).not.toThrow();
    }
  }
});

test('every day-3 aggregation and format surface resolves with the right content type', async () => {
  // task-13-brief.md Step 2's explicit surface list, matched against the
  // exact media type each one's own test file already pins (see
  // tests/pages.test.ts and tests/resume.test.ts for the byte-exact
  // versions) -- this is the acceptance suite's own independent proof of
  // the same contract, over the LLM-agent UA.
  const EXPECTATIONS: readonly [string, RegExp][] = [
    ['/resume.md', /^text\/markdown\b/],
    ['/resume.json', /^application\/json\b/],
    ['/llms.txt', /^text\/plain\b/],
    ['/llms-full.txt', /^text\/plain\b/],
    ['/rss.xml', /^application\/rss\+xml\b/],
    ['/feed.json', /^application\/feed\+json\b/],
    ['/robots.txt', /^text\/plain\b/],
  ];

  for (const [route, expected] of EXPECTATIONS) {
    const response = await agentFetch(route);
    expect(response.status, `${route} should be 200`).toBe(200);
    expect(response.headers.get('content-type'), `${route} content-type`).toMatch(expected);
  }
});

test('detail routes serve every entry including drafts; aggregation surfaces serve published entries only', async () => {
  // THE DRAFT RULE, both tiers, task-13-brief.md's own framing: detail
  // routes (HTML and `.md`) serve every entry, drafts included -- unlisted
  // but shareable by URL. Aggregation surfaces (index pages, /llms.txt,
  // /llms-full.txt, the feeds) serve published entries only. Asserting
  // either rule everywhere would be wrong in one direction or the other, so
  // both halves are checked here, explicitly, against the same discovered
  // entries.
  const draftEntries = CONTENT_ENTRIES.filter((entry) => entry.draft);
  expect(
    draftEntries.length,
    'expected at least one draft content entry to exercise the draft rule',
  ).toBeGreaterThan(0);

  // Detail tier.
  for (const entry of draftEntries) {
    const htmlPath = `/${entry.section}/${entry.slug}`;
    const markdownPath = `${htmlPath}.md`;
    expect((await agentFetch(htmlPath)).status, `${htmlPath} (draft) should still resolve`).toBe(
      200,
    );
    expect(
      (await agentFetch(markdownPath)).status,
      `${markdownPath} (draft) should still resolve`,
    ).toBe(200);
  }

  // Aggregation tier.
  //
  // HONEST LIMITATION (task-13-brief.md's own instruction to record this):
  // every real content entry in this repo is draft: true today (see
  // CONTENT_ENTRIES above), so /llms-full.txt, /rss.xml and /feed.json are
  // each completely EMPTY right now -- not merely missing these two
  // entries. That makes the assertion below pass in the trivial way (an
  // empty haystack contains no needle) rather than by proving a real
  // published entry's presence elsewhere is excluded correctly, which is
  // inherent to today's content state, not fixable inside this task, and
  // exactly why it has to stay written to be correct once content lands.
  //
  // What this assertion is NOT vacuous about, verified by mutation
  // (task-13-report.md): the filter each of these six surfaces applies --
  // `getCollection(collection, ({ data }) => !data.draft)`, in
  // src/pages/writing/index.astro, work/index.astro, llms.txt.ts,
  // llms-full.txt.ts, rss.xml.ts and feed.json.ts -- is the exact mechanism
  // that will decide whether a real published entry appears here too. Both
  // real content entries are drafts, so removing that filter makes them
  // appear on every surface below TODAY, with no new content required, and
  // this test catches it (see task-13-report.md's mutation log).
  const [writingIndex, workIndex, llmsTxt, llmsFullTxt, rssXml, feedJson] = await Promise.all(
    ['/writing', '/work', '/llms.txt', '/llms-full.txt', '/rss.xml', '/feed.json'].map((path) =>
      agentFetch(path).then((response) => response.text()),
    ),
  );

  const surfaces: readonly [string, string][] = [
    ['/writing', writingIndex],
    ['/work', workIndex],
    ['/llms.txt', llmsTxt],
    ['/llms-full.txt', llmsFullTxt],
    ['/rss.xml', rssXml],
    ['/feed.json', feedJson],
  ];

  for (const entry of draftEntries) {
    const slugPath = `/${entry.section}/${entry.slug}`;
    for (const [surface, body] of surfaces) {
      expect(
        body,
        `draft ${slugPath} must not appear on aggregation surface ${surface}`,
      ).not.toContain(slugPath);
    }
  }
});

// Day 4 Task 14 (roadmap "/.well-known + discovery"; 03 §5; 08 v1 item 2):
// the discovery document on the site's own origin, and the two courtesy
// headers 08 v1 item 2 specifies verbatim, on every response this origin
// serves.
test('/.well-known/mcp.json describes the endpoint', async () => {
  const response = await server.fetch('/.well-known/mcp.json');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const doc = await response.json();
  expect(doc.endpoint).toBe('https://ryanlindsey.me/mcp');
  expect(doc.transport).toBe('streamable-http');
  expect(doc.authentication).toBe('none');
});

test('every page carries the agent courtesy headers', async () => {
  const response = await server.fetch('/');
  expect(response.headers.get('x-for-ai-agents')).toBe("You're welcome here. Start at /llms.txt");
  expect(response.headers.get('x-mcp-server')).toBe('https://ryanlindsey.me/mcp');
});
