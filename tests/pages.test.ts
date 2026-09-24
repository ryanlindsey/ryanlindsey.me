import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import type { CollectionEntry } from 'astro:content';
import { SITE_HARNESS_WORKERS, seedResumePdf } from './workers';
import { BANNED_PATTERNS } from './candidacy-patterns';
import { elementWith } from './markup';
import { GATED_TOOL_NAMES } from '../workers/mcp/src/gated';
import { PILLAR_LABELS } from '../src/lib/pillars';
import {
  formatDateRange,
  groupWorkByCompany,
  type Resume,
  type ResumeWorkEntry,
} from '../src/lib/resume';
import { buildLlmsTxt, buildLlmsFullTxt, type LlmsLink } from '../src/lib/llms-index';
import { buildRssFeed, buildJsonFeed, RSS_MARKDOWN_NOTICE, type JsonFeed } from '../src/lib/feeds';
import { GLOBAL_LIMITS, LIMITS } from '../src/lib/mcp/limits';
import { formatWindow, PUBLISHED_AS, RETENTION } from '../src/lib/retention';
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
  // /resume.pdf reads R2 and no longer renders on a miss (#186), so a route
  // this suite expects to answer 200 needs its object put there first.
  await seedResumePdf(await server.getWorker<Env>().getEnv());
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
 *
 * `pillar` is read the same way and is `undefined` for a case study, which has
 * no such key -- 02 §2's pillars are a posts-only taxonomy. Added by the 2026-09
 * redesign's writing-index issue (#105) so the filtered-index test can assert
 * which posts a pillar view EXCLUDES without naming a slug: a test that hard-codes
 * "agent-native-site must not appear here" starts lying the day that post is
 * retired or repillared, and the exclusion is the half of that test that can
 * actually fail.
 *
 * `figures` is whether the entry declares a `figures:` block (case studies
 * only, the work-index issue #106). Presence, not contents: the parsing of the
 * block belongs to the schema and tests/case-study-figures.test.ts, and all
 * this file needs to know is which rows are supposed to render one. Read the
 * same frontmatter-only way and for the same reason as the two above -- today
 * no PUBLISHED case study declares a set, so the test that consumes this turns
 * live on its own the day one does.
 */
function readContentEntries(
  section: 'writing' | 'work',
  dir: URL,
): {
  section: 'writing' | 'work';
  slug: string;
  draft: boolean;
  pillar?: string;
  figures: boolean;
}[] {
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
        pillar: /\npillar:\s*(\S+)/.exec(frontmatter)?.[1],
        figures: /\nfigures:\s*$/m.test(frontmatter),
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

/**
 * Every `work` entry in the real résumé YAML, as the fields the page-level
 * assertions below read back off `/resume`. Deliberately the real file rather
 * than a second hand-typed fixture -- tests/resume.test.ts's `resumeFixture`
 * is that copy and can silently drift from the source (see progress.md's Task
 * 1 entry); reading the YAML here is what closes the gap at the HTTP level.
 *
 * Bounded by the NEXT top-level key rather than by `education:` by name. This
 * slice used to run work -> education and broke the day a `projects:` section
 * landed between the two: every project was parsed as a work entry and threw
 * on the missing startDate. Any future top-level section now ends the block
 * correctly without touching this helper.
 *
 * `highlights` is not parsed and is always `[]`. Nothing these tests call
 * reads it -- groupWorkByCompany groups on `name` and spans on the dates --
 * and parsing ~25 paragraphs of block-scalar prose out of YAML by regex to
 * populate a field no assertion touches would be a drift trap for nothing.
 */
const workEntriesFromYaml = (): ResumeWorkEntry[] => {
  const yaml = readFileSync(resumeYamlPath, 'utf8');
  const workStart = yaml.indexOf('\nwork:');
  const nextTopLevelKey = /\n[a-z][a-zA-Z]*:/g;
  nextTopLevelKey.lastIndex = workStart + 1;
  const workEnd = nextTopLevelKey.exec(yaml)?.index ?? yaml.length;
  return yaml
    .slice(workStart, workEnd)
    .split(/\n {2}- name: /)
    .slice(1)
    .map((chunk) => {
      const name = chunk.slice(0, chunk.indexOf('\n'));
      const position = chunk.match(/\n {4}position: (.+)/)?.[1];
      const startDate = chunk.match(/startDate: (\d{4}-\d{2})/)?.[1];
      const endDate = chunk.match(/endDate: (\d{4}-\d{2})/)?.[1];
      if (!startDate) throw new Error(`no startDate found in the work entry for ${name}`);
      if (!position) throw new Error(`no position found in the work entry for ${name}`);
      return { name, position, startDate, endDate, highlights: [] };
    });
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
  // 2026-09 redesign (issue #99): /ops and /ai-policy left the primary nav
  // for the footer's SYSTEM column. The guard against silently deleting
  // either link moved with them -- it used to read "in SiteHeader's own
  // links array" -- but the assertions stay here unchanged, because both
  // links still have to appear SOMEWHERE on the page.
  expect(page).toContain('href="/ops"');
  expect(page).toContain('href="/ai-policy"');
});

test('the primary nav is the four reading destinations, in design order', async () => {
  const page = await html('/');
  const nav = /<nav[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/.exec(page);
  expect(nav, 'no primary nav on the page').not.toBeNull();
  const hrefs = [...nav![1].matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  // Order is asserted, not membership. The design puts Ask my agent last and
  // the redesign's whole IA change is which four of six links are here.
  expect(hrefs).toEqual(['/writing', '/work', '/resume', '/chat']);
});

test('Ops and AI Policy left the primary nav for the footer', async () => {
  const page = await html('/');
  const nav = /<nav[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/.exec(page)![1];
  expect(nav).not.toContain('/ops');
  expect(nav).not.toContain('/ai-policy');
  // Still on the page, because demoted is not deleted. The footer issue
  // asserts which column they land in; this only asserts they survived.
  expect(page).toContain('href="/ops"');
  expect(page).toContain('href="/ai-policy"');
});

test('the active nav item is marked on the page it names, and only there', async () => {
  const writing = await html('/writing');
  expect(writing).toMatch(/<a[^>]*href="\/writing"[^>]*aria-current="page"/);
  expect(writing).not.toMatch(/<a[^>]*href="\/work"[^>]*aria-current="page"/);
});

/**
 * The header's search form (issue #149).
 *
 * THIS REPLACES A TEST THAT ASSERTED THE OPPOSITE, and the one it replaces is
 * worth knowing about. Until this issue the header rendered a non-interactive
 * `<span>`, `aria-hidden`, and the test here was called "the search affordance
 * is a label, not a control": it asserted the element carried `aria-hidden`,
 * held no `<input>` and no `<button>`, and that the page bound nothing to the
 * ⌘K the chip advertises. All of that was correct while `/search` did not
 * exist. It is exactly wrong now, so it is rewritten rather than left standing
 * beside its contradiction.
 *
 * Its scoping lesson survives the rewrite and is why `elementWith` is used
 * below rather than a window of characters after the ⌘K glyph. That first
 * version measured 400 characters past the chip and ran into the theme toggle
 * beside it -- a real `<button>` -- so it was measuring the control NEXT TO
 * the placeholder rather than the placeholder. `elementWith` counts tag depth
 * and strips comments (./markup.ts), which is the only scoping on this page
 * that cannot drift into a neighbour or into prose about itself.
 */
const headerSearchForm = (page: string) => elementWith(page, 'form', 'data-header-search');

test('the header search is a real GET form pointed at /search', async () => {
  const form = headerSearchForm(await html('/'));
  // The whole point of a results page over an overlay: Enter submits, the
  // browser navigates, and it works with scripting off.
  expect(form).toContain('action="/search"');
  expect(form).toContain('method="get"');
  expect(form).toContain('name="q"');
});

test('the header search is in the accessibility tree, with a name on the form and the input', async () => {
  const page = await html('/');
  const form = headerSearchForm(page);
  // `aria-hidden` was right when this was a label for a thing that did not
  // exist. It is a control now, so hiding it would take the site's search away
  // from exactly the visitors who most need to be told it is there.
  //
  // SCOPED TO THE FORM TAG AND THE INPUT rather than to the whole element: the
  // ⌘K chip inside still carries `aria-hidden`, and should, because it is
  // decoration. The shortcut it draws reaches a screen reader as
  // `aria-keyshortcuts` on the field instead of as the characters "⌘K".
  expect(/<form[^>]*>/.exec(form)![0]).not.toContain('aria-hidden');
  expect(/<input[^>]*>/.exec(form)![0]).not.toContain('aria-hidden');
  // A search landmark needs its own name, because /search renders a second one
  // (that page's own form) and two unnamed ones are indistinguishable.
  expect(form).toMatch(/<form[^>]*role="search"/);
  expect(form).toMatch(/<form[^>]*aria-label="/);
  // The input's name comes from a real <label>, not from the placeholder: a
  // placeholder disappears the moment anybody types and is not reliably
  // announced. src/pages/search.astro's own field states the same rule.
  const inputId = /<input[^>]*id="([^"]+)"/.exec(form);
  expect(inputId, 'the header search input has no id to label').not.toBeNull();
  expect(form).toContain(`for="${inputId![1]}"`);
});

test('the ⌘K chip stops lying: the shortcut module ships with the page', async () => {
  const page = await html('/');
  // The chip is kept because it already existed and now describes something
  // real. What made it a lie was that nothing anywhere bound the shortcut --
  // the test this replaces asserted that absence deliberately.
  expect(page).toContain('⌘K');
  /*
   * THE EXACT INVERSE OF THE ASSERTION THIS REPLACES, which read
   * `expect(page).not.toContain('metaKey')` under the comment "and nothing
   * binds the shortcut the chip advertises". That was the honest way to state
   * a placeholder: the chip named a key combination and no code anywhere read
   * one. Flipping the same string is the cheapest possible proof that it does
   * now.
   *
   * IT WORKS ONLY BECAUSE ASTRO INLINES THIS BUNDLE. Checked against
   * dist/client/index.html rather than assumed: the page carries three
   * `<script type="module">` elements and none of them has a `src`, so
   * src/lib/search-shortcut.ts is a string in the response. If the bundle ever
   * grows past whatever threshold sends it to a file, this assertion goes
   * quietly false-negative -- so it is paired with the field itself, which
   * cannot be inlined away, and the behaviour lives in
   * tests/search-shortcut.test.ts against a DOM.
   */
  expect(page).toContain('metaKey');
  expect(page).toContain('data-header-search');
});

test('the header search prefills on /search and stays empty everywhere else', async () => {
  // Refining a search should not mean retyping it. The prefill is read from
  // the URL rather than threaded down as a prop, so it is the same string the
  // results page put in its own heading.
  const results = headerSearchForm(await html('/search?q=armature'));
  expect(results).toMatch(/<input[^>]*value="armature"/);

  const home = headerSearchForm(await html('/'));
  expect(home).not.toMatch(/<input[^>]*value="[^"]/);
});

test('the header is sticky on articles and not anywhere else', async () => {
  // Long-form is where a sticky header earns its 68px; an index page scrolls
  // it away. Asserted on the element rather than in CSS, because the prop is
  // what decides and a CSS test would pass with the prop never threaded.
  const article = await html('/writing/agent-native-site');
  expect(article).toMatch(/<header[^>]*data-site-header[^>]*class="[^"]*sticky/);
  const home = await html('/');
  expect(home).not.toMatch(/<header[^>]*data-site-header[^>]*class="[^"]*sticky/);
});

test('the built CSS actually declares the header background and its sticky offset', () => {
  // Regression guard (final whole-branch review, task-2 fix wave). The
  // header's background utility used to sit directly against this class
  // template literal's `${` interpolation boundary in SiteHeader.astro, so
  // Tailwind's class scanner never extracted it as a candidate -- the class
  // string still rendered in every page's HTML (the test above stayed
  // green), while the background rule never made it into the built
  // stylesheet: the header shipped fully transparent, and on
  // /writing/<slug> and /work/<slug>, where the prose column sits under it
  // once the header sticks, article text scrolled visibly through the nav
  // and the search chip. No test in this repo can see whether a class
  // compiled, only whether the string is present, so this one reads the
  // actual built CSS out of `dist/client` and checks the declarations the
  // header depends on are really there -- background, sticky position, and
  // the offset that pins it -- so a future edit that reintroduces the same
  // adjacency mistake on the offset utility (silently turning `position:
  // sticky` into a header that never sticks, since the offset would fall
  // back to `auto`) is caught too. This bug shipped once; this is what stops
  // it shipping again silently.
  //
  // The background and offset utility names below are built from string
  // parts rather than typed as whole words, and referenced by variable
  // rather than retyped, on purpose. Tailwind v4's automatic content
  // detection scans every text file in the repo, this one included, for
  // anything that looks like a utility candidate, with no regard for
  // whether it sits inside a real `class` attribute or a code comment.
  // Spelling the background utility out as a bare word in an earlier draft
  // of this comment was, on its own, enough to make it compile -- verified
  // empirically, by reinstating the broken class string in SiteHeader.astro
  // with that literal-text draft still in place and watching the assertion
  // pass anyway. A guard that passes on the broken input is worse than no
  // guard.
  const bgUtility = ['bg', 'bg'].join('-');
  const offsetUtility = ['top', '0'].join('-');

  const cssDir = new URL('../dist/client/_astro/', import.meta.url);
  const css = readdirSync(cssDir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(new URL(name, cssDir), 'utf8'))
    .join('\n');

  expect(
    css.includes(`.${bgUtility}{background-color:var(--rl-bg)}`),
    `no .${bgUtility} rule in the built CSS`,
  ).toBe(true);
  expect(css.includes('.sticky{position:sticky}'), 'no .sticky rule in the built CSS').toBe(true);
  expect(
    css.includes(`.${offsetUtility}{top:0}`),
    `no .${offsetUtility} rule in the built CSS`,
  ).toBe(true);
});

/**
 * The rendered site footer, with HTML comments stripped out.
 *
 * The stripping is the point, not tidiness. Written the way issue #100
 * specified it -- against `footer![0]` directly -- the five-column test below
 * PASSED on the pre-redesign one-line footer, and was watched doing it: that
 * component's own comment described itself as "not the five-column SITE /
 * SYSTEM / FOR AGENTS / ELSEWHERE footer the redesign eventually wants", so
 * all four headings the test searched for were already in the markup, as
 * prose about their own absence. A test that cannot fail on the code it is
 * meant to reject is not a test.
 *
 * That is the third time this repo has been bitten by the same class of bug:
 * `toContain('noindex')` matching the word inside a Base.astro comment, and
 * the ⌘K search-placeholder test measuring a 400-character window that ran
 * past the placeholder into the theme toggle beside it. Both are written up
 * where they were found. The shared lesson is that a comment is markup too,
 * and an assertion scoped to "somewhere in this string" will eventually find
 * its answer in one.
 *
 * The strip runs to a FIXED POINT rather than once, and the difference is
 * not theoretical. CodeQL caught the single-pass version
 * (js/incomplete-multi-character-sanitization) and it was right, for a
 * sharper reason than the rule's own "HTML element injection" framing
 * suggests: removing a comment can splice the text on either side of it into
 * a NEW comment, so one pass can leave comment content standing. Measured,
 * not reasoned about:
 *
 *   '<!' + '<!--x-->' + '-- SECRET -->'
 *     one pass   -> '<!-- SECRET -->'   SECRET survives, inside a comment
 *     fixed point -> ''
 *
 * That is this helper's own failure mode, not a generic security one. Its
 * entire job is to stop an assertion reading text that only exists inside a
 * comment, and a single pass cannot promise that.
 *
 * Nothing here sanitizes untrusted input: it reads one element out of this
 * repo's own build output, in a test, and renders nothing. So the rule's
 * high severity does not transfer, which is the call Ryan made on the review
 * thread. The loop is in because it makes the helper correct, not because a
 * scanner asked.
 *
 * One hole a loop cannot close, recorded so the next reader does not have to
 * find it again: a literal `<!--` inside an ATTRIBUTE VALUE would start a
 * match and eat real markup forward to the next `-->`, which could delete
 * the very links an assertion looks for and turn a `not.toContain` green for
 * the wrong reason. Astro does not emit that, and this helper only ever
 * receives `html()` output. If it is ever pointed at a fixture or anything a
 * person can influence, regex is the wrong tool and this paragraph is the
 * reason to reach for a parser instead of widening the pattern.
 */
const withoutHtmlComments = (markup: string) => {
  let previous: string;
  let current = markup;
  do {
    previous = current;
    current = current.replace(/<!--[\s\S]*?-->/g, '');
  } while (current !== previous);
  return current;
};

const footerMarkup = async (path = '/') => {
  const footer = /<footer[^>]*data-site-footer[\s\S]*?<\/footer>/.exec(await html(path));
  expect(footer, 'no site footer on the page').not.toBeNull();
  return withoutHtmlComments(footer![0]);
};

test('stripping comments leaves no comment text behind, even when removal splices a new one', () => {
  // The regression CodeQL found. Removing the inner comment closes `<!` and
  // `-- SECRET -->` into a fresh comment, so a single pass hands back text
  // that is still inside one -- exactly what every footer assertion below
  // relies on this helper to have removed.
  expect(withoutHtmlComments('<!' + '<!--x-->' + '-- SECRET -->')).not.toContain('SECRET');
  // A fixed point, so re-running it changes nothing.
  const stripped = withoutHtmlComments('<!--a--><!--b-->');
  expect(withoutHtmlComments(stripped)).toBe(stripped);
  // And ordinary markup is left alone, comment removed, links intact.
  expect(withoutHtmlComments('<!-- note --><a href="/ops">Ops</a>')).toBe('<a href="/ops">Ops</a>');
});

test('the footer is the five-column colophon, and the demoted nav items live in it', async () => {
  const markup = await footerMarkup();

  for (const heading of ['SITE', 'SYSTEM', 'FOR AGENTS', 'ELSEWHERE']) {
    expect(markup).toContain(heading);
  }

  // The demotion, asserted where it landed. The header issue asserts they
  // left the nav; without this, deleting them entirely would pass both.
  expect(markup).toContain('href="/ops"');
  expect(markup).toContain('href="/ai-policy"');

  // The promotion's other half: /chat is nav-only now. Repeating it here
  // would undo the change that moved it.
  expect(markup).not.toContain('href="/chat"');
});

test('the footer portrait ships sized, and unnamed on purpose', async () => {
  // Three separate decisions, and each one is the sort that gets tidied away
  // by someone who cannot see why it was made.
  //
  // `alt=""` is the one most likely to be "fixed". An empty alt on a portrait
  // looks like an oversight, and a linter will say so, but the name is the
  // very next element in this cell -- filling it in makes a screen reader
  // announce "Ryan Lindsey" twice in a row for an image carrying nothing the
  // text beside it does not. This asserts the empty attribute IS PRESENT,
  // which is also what distinguishes the decision from a missing one.
  //
  // The dimensions are asserted because a portrait without them reserves no
  // box, and the four link columns below it reflow when the bytes land.
  const markup = await footerMarkup();
  const img = /<img[^>]*ryan-lindsey[^>]*>/.exec(markup);
  expect(img, 'no portrait in the site footer').not.toBeNull();
  expect(img![0], 'the portrait was given a redundant alt').toContain('alt=""');
  expect(img![0]).toMatch(/\bwidth="\d+"/);
  expect(img![0]).toMatch(/\bheight="\d+"/);
  // The circle, which is the only rounded corner on a site whose rule is
  // square -- so it reads as a deletion candidate to anyone enforcing that
  // rule, and this is where the exception is written down.
  expect(img![0]).toContain('rounded-full');
  // `object-cover`, so a replacement photo that is not square is centre-cropped
  // rather than squashed. Today's file is 1:1 and would pass without it.
  expect(img![0]).toContain('object-cover');
});

test('the portrait is one asset the whole site shares', async () => {
  // The home page bio block renders the same file at a smaller size. Two
  // files would mean a photo swap that updates one surface and silently
  // leaves the other showing the old face.
  const home = await html('/');
  const sources = [...home.matchAll(/<img[^>]*src="([^"]*ryan-lindsey[^"]*)"/g)].map((m) => m[1]);
  expect(sources.length, 'expected the portrait in both the bio block and the footer').toBe(2);
  expect(new Set(sources).size, 'the two portraits are different files').toBe(1);
});

test('the footer column headings are not page headings', async () => {
  // Not in the issue's test list. Added after tests/case-studies.test.ts was
  // read, rather than after it went red: `sectionHeadings()` there scans the
  // WHOLE page for <h2> and asserts EQUALITY against the fixed 02 §4
  // case-study shape, so a single <h2> in shared chrome would fail every
  // /work/<slug> at once, with the failure naming the case study rather than
  // the footer that caused it. The columns are labelled <p> elements over
  // <nav aria-label>, which names each landmark for a screen reader without
  // putting site chrome into any page's document outline.
  const markup = await footerMarkup();
  expect(markup).not.toMatch(/<h[1-6]\b/);
  for (const label of ['Site', 'System', 'For agents', 'Elsewhere']) {
    expect(markup, `no footer landmark named ${label}`).toContain(`aria-label="${label}"`);
  }
});

test('every external footer link opens safely', async () => {
  const markup = await footerMarkup();
  const external = [...markup.matchAll(/<a[^>]*href="(https?:[^"]+)"[^>]*>/g)];
  expect(external.length, 'no external links found in the footer').toBeGreaterThan(3);
  for (const [tag, href] of external) {
    expect(tag, `${href} is missing rel="noopener"`).toContain('rel="noopener"');
    expect(tag, `${href} is missing target="_blank"`).toContain('target="_blank"');
  }
});

test('the footer never shortens the Pixelsonly Racing brand name', async () => {
  const markup = await footerMarkup();
  expect(markup).toContain('Pixelsonly Racing');
  // The label, not the hostname -- `pixelsonly.racing` is a literal
  // identifier and is exempt from the brand-name rule the label is not.
  expect(markup).not.toMatch(/>\s*Pixelsonly\s*</);
});

test('the footer links the profile URLs the résumé record carries, not the prototype copies', async () => {
  // Not in the issue's test list, and the reason it exists is a conflict the
  // issue could not have seen. Issue #100 gives the ELSEWHERE URLs "from the
  // prototype" and spells LinkedIn `/in/ryanlindsey`; the résumé record --
  // the only other place this site states it, and the source every rendered
  // résumé format reads -- spells it `/in/ryanclindsey`, with a matching
  // `username: ryanclindsey` beside it. A design mock mistyping a vanity slug
  // is likelier than the record being wrong in a field that ships in four
  // formats, so the record wins.
  //
  // Reading them rather than retyping them is also the rule the issue itself
  // states one paragraph earlier, about the email: read it from the résumé
  // record rather than typing it, the same way every other format on this
  // site does. Applying that to the two profiles beside it is what makes the
  // conflict impossible to reintroduce, which a corrected literal would not.
  const markup = await footerMarkup();
  const yaml = readFileSync(resumeYamlPath, 'utf8');
  for (const network of ['GitHub', 'LinkedIn']) {
    const url = new RegExp(`network:\\s*${network}\\b[\\s\\S]*?url:\\s*(\\S+)`).exec(yaml)?.[1];
    expect(url, `no ${network} profile in the résumé record`).toBeTruthy();
    expect(markup, `the footer should link the record's ${network} URL`).toContain(`href="${url}"`);
  }
});

test('the footer mails the address the résumé record carries, not a typed copy', async () => {
  const markup = await footerMarkup();
  const yaml = readFileSync(resumeYamlPath, 'utf8');
  const email = /^\s*email:\s*(\S+)\s*$/m.exec(yaml)?.[1];
  expect(email, 'no email in the résumé record').toBeTruthy();
  expect(markup).toContain(`mailto:${email}`);
});

test('the home page is the editorial lead story, and is still indexable', async () => {
  const page = await html('/');
  // The holding page is gone (2026-09 redesign, issue #103). What replaced it
  // is asserted below; the robots half of this test is unchanged and its trap
  // still applies.
  //
  // Was `toContain('noindex')` before launch flipped Base.astro's default.
  // Asserted as the WHOLE attribute value rather than `toContain('index')`,
  // which "noindex" also satisfies -- and that is not hypothetical here: this
  // test went on passing after the default flipped, because an HTML comment in
  // Base.astro happened to contain the word "noindex" and `toContain` found
  // it. A substring check on this particular string is a trap.
  expect(page).not.toContain('data-testid="holding-page"');
  expect(page).toContain('<title>Ryan Lindsey</title>');
  expect(page).toMatch(/<meta name="robots" content="index, follow"\s*\/?>/);
  expect(page).not.toContain('noindex');
});

test('the Now strip leads the page and is a band, not a card', async () => {
  const page = await html('/');
  expect(page).toContain('data-now-strip');
  expect(page).toMatch(/data-now-strip[\s\S]{0,600}NOW/);
});

test('the lead story is the most recent published post, linked whole', async () => {
  const page = await html('/');
  const posts = CONTENT_ENTRIES.filter((entry) => entry.section === 'writing' && !entry.draft);
  expect(posts.length, 'no published posts to lead with').toBeGreaterThan(0);
  const lead = /data-lead-story[\s\S]*?<\/(a|article|section)>/.exec(page);
  expect(lead, 'no lead story on the home page').not.toBeNull();
  // Not underlined: the design's rule for a whole-card wrapper link.
  //
  // `data-lead-story` is the FIRST attribute on that anchor in
  // src/pages/index.astro, and has to be: this match starts at the attribute
  // and ends at the first closing tag after it, so a `class` emitted ahead of
  // it would put `no-underline` outside the window and pass a page that had
  // dropped it.
  expect(lead![0]).toContain('no-underline');
});

test('the home page never names an employer', async () => {
  // 00 §5, the rule `src/content.config.ts` records beside `resumeSchema`:
  // the résumé names the employer in `work`, positioning surfaces do not.
  // The prototype's bio copy broke this and the fix was to read the résumé
  // record instead of typing a line -- so this asserts the outcome rather
  // than the mechanism, and would catch someone pasting the copy back.
  //
  // SCOPED TO THE `work:` BLOCK, and it has to be. Issue #103 prescribed
  // `/^\s{2}- name:/gm` over the whole file, which also matches `projects`
  // and `skills` -- both sit at the same indentation. MEASURED (2026-09-13,
  // before this page existed, against the /writing page then shipping): the
  // unscoped form pulled thirteen names, five of them not employers, and
  // failed on three of those. "Pixelsonly Racing" is a project, and #100
  // requires the footer to name it in full. "Engineering leadership" is a
  // skill, and the footer tagline's first two words. "Agentic engineering"
  // is a skill AND `PILLAR_LABELS['agentic-engineering']`, which this page's
  // own lead kicker renders -- so the unscoped test forbade the design it was
  // written for. The issue body carries the correction and why.
  //
  // The needle is checked escaped as well as raw. `Y&R Brands / Wunderman`
  // would reach the page as `Y&amp;R Brands / Wunderman`, so a raw-only
  // `toContain` could never fail for that employer, and a negative assertion
  // that cannot fail is not a check.
  const page = await html('/');
  const yaml = readFileSync(resumeYamlPath, 'utf8');
  const workBlock = /^work:\n([\s\S]*?)(?=^\S)/m.exec(yaml);
  expect(workBlock, 'no work: block found in the résumé YAML').not.toBeNull();
  const employers = [...workBlock![1].matchAll(/^\s{2}- name:\s*(.+)$/gm)].map((m) => m[1].trim());
  expect(employers.length, 'no work entries found to check against').toBeGreaterThan(0);
  for (const employer of employers) {
    if (employer === 'Freelance') continue;
    for (const needle of [employer, employer.replaceAll('&', '&amp;')]) {
      expect(page, `${employer} is named on a positioning surface`).not.toContain(needle);
    }
  }
});

test('the bio block is built from the résumé record, not typed into the page', async () => {
  const page = await html('/');
  const yaml = readFileSync(resumeYamlPath, 'utf8');
  const label = /^\s{2}label:\s*(.+)$/m.exec(yaml)![1].trim();
  // Scoped to the bio block's own element, not the whole page. MEASURED
  // (2026-09-13) against the holding page this issue replaced: a bare
  // `expect(page).toContain(label)` ALREADY PASSED there, because Base.astro
  // emits the same string as the JSON-LD Person's `jobTitle` on every page.
  // An assertion satisfied by markup that has nothing to do with the block it
  // names could never fail for the thing its title claims -- the same trap
  // the search-placeholder test above records having fallen into once.
  const bio = /data-bio[\s\S]*?<\/div>/.exec(page);
  expect(bio, 'no bio block on the home page').not.toBeNull();
  expect(bio![0]).toContain(label);
});

test('more writing is a hairline grid of the next three posts', async () => {
  const page = await html('/');
  const section = /data-more-writing[\s\S]*?<\/section>/.exec(page);
  expect(section, 'no more-writing section').not.toBeNull();
  expect(section![0]).toContain('hairline-grid');
  const published = CONTENT_ENTRIES.filter((entry) => entry.section === 'writing' && !entry.draft);
  const cells = [...section![0].matchAll(/href="\/writing\//g)].length;
  // Follows the count rather than rendering an empty cell, and never repeats
  // the lead story.
  expect(cells).toBe(Math.min(3, Math.max(0, published.length - 1)));
});

test('no draft reaches the home page', async () => {
  const page = await html('/');
  for (const entry of CONTENT_ENTRIES.filter((e) => e.section === 'writing' && e.draft)) {
    expect(page, `draft ${entry.slug} is on the home page`).not.toContain(`/writing/${entry.slug}`);
  }
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
    // Issue #181: the print sheet is a fourth résumé surface, public HTML and
    // served over the same origin, so it belongs in this sweep with the other
    // three. It is `noindex` and unlisted, which is not the same as unreachable
    // -- 09 §2 is about what a surface says, not about who is expected to find
    // it. The static scan in tests/tier-invisibility.test.ts already reads all
    // of src/, so this closes a runtime gap rather than an absolute one.
    '/resume.print/',
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
    // Day 6 Task 13: `/ops` and `/ai-policy` are the two governance surfaces
    // this task put in the nav and the agent index, which is what earns them
    // a place in this sweep. `/chat` is added to the sweep for the same
    // reason -- it was reachable and unswept before this task -- but its own
    // role here stops there: it stays out of the primary nav by design (it
    // lives in the footer instead), and its `SITE_LINKS` entry in
    // llms.txt.ts already existed before this diff.
    '/chat',
    '/ops',
    '/ai-policy',
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

// Day 6 Task 13's central claim, pinned directly rather than left to the two
// scans above to imply between them: none of the four surfaces below --
// /chat, /ops and /ai-policy, the three pages day 6's build track shipped,
// plus /llms.txt, the pre-existing index (Day 3) this task just extended
// with two of them -- carries a gated tool's name (which would name a
// capability that only a granted caller may use) or a private-tier/candidacy
// pattern. GATED_TOOL_NAMES comes from workers/mcp/src/gated.ts -- a plain
// vitest process, same as tests/mcp-gated.test.ts:11 -- rather than from a
// second, hand-typed list that could drift from the real tool map. Fetched as
// { path, response, text } rather than bare text -- deviations from the
// plan's body, both earning their keep: the path label says WHICH surface
// failed, and the status check is what stops a 404 from passing both scans
// vacuously against an empty body.
test('no public surface added today names a gated tool, an audience, or a private-tier row', async () => {
  const surfaces = await Promise.all(
    ['/chat', '/ops', '/ai-policy', '/llms.txt'].map(async (path) => {
      const response = await server.fetch(path);
      return { path, response, text: await response.text() };
    }),
  );
  for (const { path, response, text } of surfaces) {
    // Without this, a route that 404s would pass the two scans below
    // vacuously -- an empty/error body names nothing either.
    expect(response.status, `${path} should be 200`).toBe(200);
    for (const name of GATED_TOOL_NAMES) {
      expect(text, `${path} must not name the gated tool ${name}`).not.toContain(name);
    }
    for (const pattern of BANNED_PATTERNS) {
      expect(text, `${path} must not match ${pattern}`).not.toMatch(pattern);
    }
  }
});

/**
 * /ai-policy, rebuilt at a document width by the 2026-09 redesign (design 1m,
 * issue #110): a 240px rail beside a column capped at 1180px, with the rate
 * limits and the retention windows rendered as bordered tables built from the
 * constants that enforce them.
 *
 * THERE IS NO BANNED-PATTERN CASE BELOW, and that is deliberate rather than an
 * omission. `/ai-policy` is already swept twice in this file -- once by the
 * whole-surface sweep above and once by the gated-tool test immediately before
 * this block -- and `tests/governance.test.ts` sweeps the markdown source as
 * well. A fourth copy would assert what three assertions already cover, and the
 * failure it would report is one they report first.
 *
 * THE UPDATED DATE IS READ FROM THE FILE, not through `getCollection`. The
 * issue sketched `await import('astro:content')` here; that module resolves
 * only inside Astro's own module graph, and this is a plain vitest process, so
 * the import throws before any assertion runs. This file already reads the
 * résumé YAML off disk for the same reason, and the collection schema
 * (src/content.config.ts) is what validates the shape on every build.
 */
const policyUpdated = (() => {
  const source = readFileSync(new URL('../governance/ai-policy.md', import.meta.url), 'utf8');
  const updated = /^updated:\s*'?(\d{4}-\d{2}-\d{2})'?\s*$/m.exec(source)?.[1];
  expect(updated, 'no updated date in the policy frontmatter').toBeTruthy();
  return updated!;
})();

/**
 * One row of a policy table, scoped by its label.
 *
 * The same shape as tests/ops-page.test.ts's `row`, and for the same reason its
 * own comment gives: a bare `toContain('30 days')` passes on any occurrence
 * anywhere on the page, so a table could break entirely while the assertion
 * stayed green. Each value is checked against the row it is a value FOR.
 */
function policyRow(page: string, label: string): string {
  const at = page.indexOf(label);
  expect(at, `no policy row contains ${label}`).toBeGreaterThan(-1);
  return page.slice(page.lastIndexOf('<div', at), page.indexOf('</div>', at));
}

test('the policy reads at a document width, narrower than every other page', async () => {
  const page = await html('/ai-policy');
  const grid = /<div[^>]*data-policy-grid[^>]*>/.exec(page);
  expect(grid, 'no policy grid on the page').not.toBeNull();
  expect(grid![0]).toContain('max-w-[1180px]');
  // The contrast, from this same page rather than from another one: the header
  // and footer above and below this grid are still capped at 1440px. That is
  // what makes 1180 a decision about the document instead of a change to the
  // site's geometry, and it is the half a single-cap assertion cannot see.
  expect(grid![0]).not.toContain('1440');
  expect(page, 'the chrome should still sit at the site cap').toContain('max-w-[1440px]');
});

test('the rail carries the updated date from the validated record', async () => {
  const page = await html('/ai-policy');
  const rail = /<aside[^>]*data-policy-rail[\s\S]*?<\/aside>/.exec(page);
  expect(rail, 'no policy rail on the page').not.toBeNull();
  // In the rail, not merely somewhere on the page: the date is the rail's
  // second line in design 1m, and the page it replaced printed it under the H1.
  expect(rail![0]).toContain(policyUpdated);
  expect(rail![0]).toContain(`datetime="${policyUpdated}"`);
});

test('the rail is the same sticky contents pattern the article uses', async () => {
  const page = await html('/ai-policy');
  const rail = /<aside[^>]*data-policy-rail[\s\S]*?<\/aside>/.exec(page)![0];
  // `data-toc-link` is TableOfContents.astro's own contract, and its script
  // carries two fixes that a hand-built second rail would arrive without (a
  // symmetric root margin flickers between headings; a page scrolled to the
  // bottom never lights its last section). Asserting the attribute is what
  // says this page reused that component rather than redrawing it.
  expect(rail).toMatch(/data-toc-link="[^"]+"/);
  expect(rail).toContain('lg:sticky');
  // The two tables and the register are reachable from the rail, which is the
  // only navigation this page has now that the kicker is gone.
  for (const slug of ['rate-limits', 'retention', 'risk-register']) {
    expect(rail, `${slug} is not in the rail`).toContain(`data-toc-link="${slug}"`);
    expect(page, `${slug} has no heading to land on`).toContain(`id="${slug}"`);
  }
});

test('the rate limits and retention are tables, not paragraphs', async () => {
  const page = await html('/ai-policy');
  const tables = [...page.matchAll(/data-policy-table/g)];
  expect(tables.length, 'expected a rate-limit table and a retention table').toBe(2);
  // The hairline idiom from the primitives issue (#98), not a fourth hand-drawn
  // set of divider rules -- the handoff names 1m as one of the four screens
  // carrying it.
  expect(page).toMatch(/data-policy-table[^>]*class="[^"]*hairline-grid/);
});

test('the rate limits on the page are the ones the limiter enforces', async () => {
  const page = await html('/ai-policy');
  // Derived from LIMITS rather than typed here, so a changed bucket fails this
  // test instead of quietly leaving the page publishing the old figure.
  expect(policyRow(page, 'Reading a published document over MCP')).toContain(
    `${LIMITS.cheap.limit} / min`,
  );
  expect(policyRow(page, 'Semantic search over the published work')).toContain(
    `${LIMITS.inference.limit} / min`,
  );
  expect(policyRow(page, 'A chat message')).toContain(`${LIMITS.conversation.limit} / 5 min`);
  expect(policyRow(page, 'Chat, across everyone, before the breaker')).toContain(
    `${GLOBAL_LIMITS.chat.limit} / day`,
  );
});

test('the rate-limit table publishes no token-scoped bucket', async () => {
  const page = await html('/ai-policy');
  // The same restraint src/pages/ops.astro states in its own `LIMIT_ROWS`
  // comment, applied on the page most likely to be read by somebody probing
  // for that surface: `expensive` belongs to a token-scoped route, and its cap
  // would say both that the route exists and roughly what a call there costs.
  // A choice about which rows to render, never a second copy of the constant.
  //
  // THE WHOLE PHRASE, not the `6 / ` prefix the first draft of this used. That
  // prefix is a substring of `60 / min`, the bucket in the row directly above
  // it, so the assertion would have gone red on a change to `cheap` that had
  // nothing to do with what it is guarding.
  const table = /data-policy-table[\s\S]*?<\/section>/.exec(page)![0];
  const expensive = `${LIMITS.expensive.limit} / ${LIMITS.expensive.periodSeconds / 60} min`;
  expect(table, `the token-scoped cap (${expensive}) is published`).not.toContain(expensive);
  // And the table is exactly the four public rows, so a fifth arriving without
  // this decision being revisited fails here rather than shipping.
  expect([...table.matchAll(/data-numeric/g)]).toHaveLength(4);
});

test('every retention window on the page is the one the cron enforces', async () => {
  // The assertion tests/ops-page.test.ts makes about /ops, applied here because
  // this page is where the claim is made in public. src/lib/retention.ts is
  // table-driven precisely so the policy and the cron cannot drift, and its own
  // header says /ai-policy links the reader to the statement. Rendering the
  // table from RETENTION is that sentence's other half.
  const page = await html('/ai-policy');
  for (const { table, days } of RETENTION) {
    expect(policyRow(page, PUBLISHED_AS[table]), `${table}'s window`).toContain(formatWindow(days));
  }
});

// Day 6 Task 2 (06 §3): `run_worker_first` gained the agent-signal routes and
// LOST the two `!.../*.md` negative patterns, so that every request this site
// counts as an agent signal actually reaches src/worker.ts and can be recorded.
//
// WHAT THESE TWO TESTS PROVE, and it is less than the routing change claims.
// They prove the change did not break serving: the `.md` variant still comes
// back as markdown, and `/llms.txt` still comes back byte-for-byte from assets.
// That is the regression worth pinning, because routing a path through the
// Worker is exactly how one would accidentally start answering it with HTML.
//
// THEY DO NOT PROVE THE REQUEST REACHED THE WORKER. An earlier draft of this
// task said `Vary: Accept` would be the proof, since only src/worker.ts sets
// it; MEASURED, and it is absent on both paths (`vary=null`). It has to be:
// `markdownAssetPathFor` rejects an already-suffixed path on sight, so
// `markdownPath` is null and `withVaryAccept` never runs. The Worker's only
// observable effect on these paths is the Analytics Engine row, which no test
// in this repo can read. Live verification is Task 13's job.
test('the markdown variants now reach the Worker, which is what makes them countable', async () => {
  const response = await server.fetch('/writing/type-specimen.md');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/markdown');
});

test('/llms.txt reaches the Worker and is still served byte-for-byte from assets', async () => {
  const response = await server.fetch('/llms.txt');
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('# Ryan Lindsey');
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

/**
 * The writing index, rebuilt by the 2026-09 redesign (design 1h, issue #105).
 *
 * Two regexes below scope an assertion to one element by matching from a data
 * attribute to the next closing tag, the idiom this file already uses for
 * `data-bio` and `data-more-writing`. Both are LAZY, so they stop at the FIRST
 * closing tag of that kind -- which is a constraint on the markup, not just on
 * the test, and src/components/WritingIndex.astro carries the matching note.
 */
test('the writing index is a split masthead over filter chips over rows', async () => {
  const page = await html('/writing');
  expect(page).toContain('data-index-masthead');
  expect(page).toContain('data-filter-row');
  expect(page).toContain('data-post-row');
});

test('every pillar chip carries a real count of published posts', async () => {
  const page = await html('/writing');
  const row = /data-filter-row[\s\S]*?<\/(nav|div)>/.exec(page)![0];
  const published = CONTENT_ENTRIES.filter((e) => e.section === 'writing' && !e.draft);
  // The "all" chip. Asserted against the count read from the content tree,
  // so it stays true as posts are added rather than freezing today's number.
  expect(row).toContain(`${published.length}`);
  for (const label of Object.values(PILLAR_LABELS)) {
    expect(row, `${label} has no chip`).toContain(label);
  }
});

test('a filter chip is a link to a real address, not a client-side toggle', async () => {
  // This site's posture is that a URL is an address: a filtered view has to
  // be linkable. A <button> here means the filtered state cannot be shared.
  const row = /data-filter-row[\s\S]*?<\/(nav|div)>/.exec(await html('/writing'))![0];
  expect(row).not.toContain('<button');
  expect(row).toMatch(/<a[^>]*href="\/writing\//);
});

test('a filtered index serves only its own pillar, and still 200s', async () => {
  const page = await html('/writing/pillar/agentic-engineering');
  const rows = [...page.matchAll(/data-post-row/g)].length;
  expect(rows).toBeGreaterThan(0);
  expect(page).toContain('data-filter-row');

  // The half that can actually fail. "Serves only its own pillar" is a claim
  // about what is ABSENT, and a row count alone is satisfied by a filtered
  // route that quietly renders every post -- which is the most likely way to
  // build this wrong, since the unfiltered index is where the markup comes
  // from. Both sides are read off disk so neither freezes today's corpus.
  const posts = CONTENT_ENTRIES.filter((e) => e.section === 'writing' && !e.draft);
  const mine = posts.filter((e) => e.pillar === 'agentic-engineering');
  const theirs = posts.filter((e) => e.pillar !== 'agentic-engineering');
  expect(mine.length, 'no published agentic-engineering post to filter for').toBeGreaterThan(0);
  expect(theirs.length, 'no post from another pillar, so exclusion is untested').toBeGreaterThan(0);
  expect(rows).toBe(mine.length);
  for (const entry of mine) {
    expect(page, `the pillar view should list ${entry.slug}`).toContain(`/writing/${entry.slug}`);
  }
  for (const entry of theirs) {
    expect(page, `${entry.slug} is not in this pillar`).not.toContain(`/writing/${entry.slug}`);
  }
});

test('a pillar with no published posts keeps its chip, its route and an honest empty state', async () => {
  // `org-scaling` was the empty pillar from launch until 2026-09-23, when it
  // left the taxonomy. No pillar is empty today, so this loop runs over
  // nothing until one is: a pillar whose only post is a draft, or whose last
  // post is retired. The design (1h) shows only pillars with posts. The chips are generated from PILLAR_LABELS rather than
  // from the corpus, so an empty pillar still gets a chip -- which makes its
  // route a real address that has to answer rather than 404. It answers with
  // the empty state, because a chip that links nowhere is worse than a chip
  // reading zero. Read off disk so this stops applying the day the pillar
  // fills, rather than pinning one pillar empty forever.
  const empty = Object.keys(PILLAR_LABELS).filter(
    (pillar) =>
      !CONTENT_ENTRIES.some((e) => e.section === 'writing' && !e.draft && e.pillar === pillar),
  );
  for (const pillar of empty) {
    const page = await html(`/writing/pillar/${pillar}`);
    expect(page, `${pillar} should render the empty state`).toContain(
      'data-testid="writing-empty"',
    );
    expect([...page.matchAll(/data-post-row/g)].length, `${pillar} should have no rows`).toBe(0);
  }
});

test('the feeds are offered from the index', async () => {
  const page = await html('/writing');
  for (const href of ['/rss.xml', '/feed.json', '/llms.txt']) {
    expect(page).toContain(`href="${href}"`);
  }
});

test('a post row is one wrapper link, undecorated', async () => {
  const row = /data-post-row[\s\S]*?<\/a>/.exec(await html('/writing'))![0];
  expect(row).toContain('no-underline');
  // One link per row: a nested anchor inside a wrapper anchor is invalid
  // markup and the design puts the whole row inside the link. This counts to
  // exactly 1 rather than "not 2" because `data-post-row` sits on the row
  // WRAPPER, not on the anchor -- putting it on the anchor would leave the
  // opening `<a ` outside the slice and count 0, which is the arrangement
  // this assertion is pinning down.
  expect([...row.matchAll(/<a\s/g)].length).toBe(1);
});

/**
 * The work index, rebuilt by the 2026-09 redesign (design 1i, issue #106).
 *
 * Same lazy-regex scoping contract as the writing index above, and the same
 * constraint it puts on the markup: `data-case-row` sits on the row WRAPPER so
 * the slice from it to the first `</a>` contains the opening `<a ` tag.
 */
test('the work index is a masthead over one full-width row per case study', async () => {
  const page = await html('/work');
  expect(page).toContain('data-index-masthead');
  const published = CONTENT_ENTRIES.filter((e) => e.section === 'work' && !e.draft);
  expect(published.length, 'no published case study to render a row for').toBeGreaterThan(0);
  expect([...page.matchAll(/data-case-row/g)].length).toBe(published.length);
});

test('a case row is one wrapper link, undecorated', async () => {
  const row = /data-case-row[\s\S]*?<\/a>/.exec(await html('/work'))![0];
  expect(row).toContain('no-underline');
  // Exactly 1, for the reason the matching writing-index assertion records.
  expect([...row.matchAll(/<a\s/g)].length).toBe(1);
});

test('a case study renders a figure block exactly when it declares one', async () => {
  // BOTH DIRECTIONS, READ OFF DISK, because which one is live is a property
  // of the corpus rather than of this file, and it has already flipped once.
  // When #106 landed, no published case study declared `figures` and only the
  // absence arm could fail; both declare one now, so the presence arm is the
  // live half and the absence arm waits for the next case study that ships
  // without figures. Neither arm is deleted when it goes quiet -- that is the
  // whole reason this is written as a loop over what is on disk rather than
  // as two assertions naming slugs.
  //
  // WHAT THIS DELIBERATELY NO LONGER DOES is require the corpus to contain a
  // case study of each kind. It did at first, which turned "give both case
  // studies their figures" into two failing tests -- a content decision
  // blocked by a test asserting the shape of the content. The guard was the
  // wrong instrument: keeping an arm honest is worth a failure, but dictating
  // what the corpus may hold is not. The absence arm's real coverage is
  // `figureCellsFor(undefined)` in tests/case-study-figures.test.ts, which no
  // content change can make vacuous.
  const page = await html('/work');
  const published = CONTENT_ENTRIES.filter((e) => e.section === 'work' && !e.draft);
  expect(published.length, 'no published case study to check either arm against').toBeGreaterThan(
    0,
  );

  for (const entry of published) {
    const row = new RegExp(`data-case-row[^>]*data-slug="${entry.slug}"[\\s\\S]*?</a>`).exec(page);
    expect(row, `no row for ${entry.slug}`).not.toBeNull();
    if (entry.figures) {
      expect(row![0], `${entry.slug} declares figures and should render them`).toContain(
        'data-case-figures',
      );
    } else {
      // Never an empty cell: a row with no figures renders no block at all,
      // and the track it would have occupied stays plain whitespace.
      expect(row![0], `${entry.slug} declares no figures and should render no block`).not.toContain(
        'data-case-figures',
      );
    }
  }
});

test('the figure rail and the figure block are one decision, never one without the other', async () => {
  // THE FAILURE MODE ISSUE #106 NAMES BY NAME -- a row that "reads as a
  // layout that lost half its content" -- pinned at the thing that would
  // actually cause it. The row keeps its two-column track list whether or not
  // there are figures, because that is what holds the headline to its
  // designed measure (src/pages/work/index.astro records what looking at both
  // versions at 1440px settled). An empty TRACK is a right margin. An empty
  // BORDERED, PADDED track is a hole, and the rule plus the 36px are what
  // would turn one into the other.
  //
  // READ OFF THE SOURCE RATHER THAN THE RENDERED PAGE, and that is the whole
  // point of this test rather than a shortcut. Two page-level versions were
  // written first and both were measured to be toothless: "a row without
  // figures carries no rail" stopped asserting anything the day both
  // published case studies declared a set, and replacing it with a
  // co-occurrence check over the rendered rows did no better -- with every
  // row carrying figures, rail-present and block-present are both true, so
  // hoisting the border onto the anchor kept the test green. Verified by
  // making exactly that edit and watching it pass.
  //
  // The contract is therefore about where the declaration LIVES: the rail
  // belongs inside the figure block's own conditional, so it cannot outlive
  // the block. Same approach and same reason as tests/type-scale.test.ts and
  // tests/primitives.test.ts, which read global.css because no rendered
  // consumer could tell them what they needed to know.
  const source = readFileSync(new URL('../src/pages/work/index.astro', import.meta.url), 'utf8');
  const guard = source.indexOf('cells.length > 0');
  const block = source.indexOf('data-case-figures');
  expect(guard, 'no figure-block conditional in the work index').toBeGreaterThan(-1);
  expect(block, 'no figure block in the work index').toBeGreaterThan(guard);

  const rails = [...source.matchAll(/\bborder-l\b/g)].map((match) => match.index!);
  expect(rails.length, 'the rail is declared in exactly one place').toBe(1);
  expect(rails[0], 'the rail must sit inside the figure block conditional').toBeGreaterThan(guard);
  expect(rails[0], 'the rail must be declared with the block, not around it').toBeLessThan(block);
});

test('no case row renders an empty element where a figure or a line should be', async () => {
  // The rule /ops already lives by (OpsMetric.astro: "absent is a state, not
  // a zero") and the one the :::figures directive states: a value that could
  // not be read says so. An empty <p> is the shape that rule fails as.
  const page = await html('/work');
  for (const row of page.matchAll(/data-case-row[\s\S]*?<\/a>/g)) {
    expect(row[0]).not.toMatch(/>\s*<\/p>/);
  }
});

test('a filtered index is kept out of the sitemap and says so to a crawler', async () => {
  // The decision recorded in src/lib/unindexed-routes.mjs, asserted on both
  // halves. A filtered view is a thin duplicate of /writing -- the same rows,
  // a subset -- so the sitemap carries one of the four and the other three
  // say `noindex, follow`: do not index this, do follow it to the posts.
  // Both halves, because either alone fails open. A sitemap omission does not
  // stop a crawler that found the chip, and a noindex page still listed in the
  // sitemap is a contradiction Search Console reports as one.
  const indexXml = await (await server.fetch('/sitemap-index.xml')).text();
  const child = indexXml.match(/<loc>([^<]+)<\/loc>/)![1];
  const xml = await (await server.fetch(new URL(child).pathname)).text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);

  expect(locs, 'the unfiltered index is the one that belongs in the sitemap').toContain(
    '/writing/',
  );
  for (const pillar of Object.keys(PILLAR_LABELS)) {
    expect(locs, `the sitemap must not carry the ${pillar} filter`).not.toContain(
      `/writing/pillar/${pillar}/`,
    );
    const page = await html(`/writing/pillar/${pillar}`);
    expect(page).toMatch(/<meta name="robots" content="noindex, follow"\s*\/?>/);
  }
});

// The `data-testid="writing-empty"` assertion this test used to carry is gone
// with `terminal-setup.mdx` shipping (`draft: false`): the index is no longer
// empty, so that element's branch in src/pages/writing/index.astro is now
// unreachable in real state. Losing it is an improvement rather than a gap --
// an index asserted to be EMPTY cannot distinguish "drafts are excluded" from
// "nothing is rendered at all", which is precisely the passes-against-nothing
// trap this file's /llms.txt comment catalogues. Both halves are now real:
// a published post that must appear, and a draft that must not.
test('keeps drafts out of the writing index but reachable by URL', async () => {
  const index = await html('/writing');
  const posts = CONTENT_ENTRIES.filter((entry) => entry.section === 'writing');
  const published = posts.filter((entry) => !entry.draft);
  const drafts = posts.filter((entry) => entry.draft);
  expect(published.length, 'expected at least one published post').toBeGreaterThan(0);
  expect(drafts.length, 'expected at least one draft post').toBeGreaterThan(0);

  for (const entry of published) {
    expect(index, `/writing should list ${entry.slug}`).toContain(`/writing/${entry.slug}`);
  }
  for (const entry of drafts) {
    expect(index, `/writing must not list the draft ${entry.slug}`).not.toContain(
      `/writing/${entry.slug}`,
    );
    // Excluded from the index, still served at its own URL -- the second half
    // of this test's name, and what makes a draft shareable before it ships.
    expect((await server.fetch(`/writing/${entry.slug}`)).status).toBe(200);
  }
});

/**
 * The regression this whole launch change is most likely to cause, asserted on
 * both collections rather than on the one that happened to prompt it.
 *
 * Before launch the sitewide default was `noindex`, so a draft was covered by
 * accident: it had a real route, but so did everything else, and nothing was
 * indexable. Flipping the default to `index, follow` inverted that -- a draft
 * is now indexable UNLESS its route says otherwise. Both `[...slug].astro`
 * routes pass `noindex, nofollow` for a draft, and this is what holds them to
 * it, entry by entry off disk so a new draft is covered the day it lands.
 */
test('serves drafts noindex and published pages indexable, in both collections', async () => {
  for (const entry of CONTENT_ENTRIES) {
    const page = await html(`/${entry.section}/${entry.slug}`);
    const robots = page.match(/<meta name="robots" content="([^"]*)"/)?.[1];
    expect(robots, `/${entry.section}/${entry.slug} should carry a robots directive`).toBeDefined();
    if (entry.draft) {
      expect(robots, `the draft ${entry.slug} must not be indexable`).toBe('noindex, nofollow');
    } else {
      expect(robots, `the published ${entry.slug} should be indexable`).toBe('index, follow');
    }
  }
  // Both branches have to be exercised for the assertion above to mean
  // anything -- a corpus that was all-published or all-draft would let a
  // one-armed implementation through.
  expect(
    CONTENT_ENTRIES.some((e) => e.draft),
    'expected at least one draft',
  ).toBe(true);
  expect(
    CONTENT_ENTRIES.some((e) => !e.draft),
    'expected at least one published entry',
  ).toBe(true);
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

/*
 * The 2026-09 redesign's article (design 1g, issue #104). ARTICLE is a real
 * published post rather than the draft specimen the TOC and reading-time
 * tests above use, so every assertion below describes a page a reader can
 * actually reach.
 */
const ARTICLE = '/writing/agent-native-site';

test('the article is a three-column spine with both rails', async () => {
  const page = await html(ARTICLE);
  expect(page).toContain('data-article-toc');
  expect(page).toContain('data-article-meta-rail');
  expect(page).toContain('data-reading-progress');
});

test('the contents rail keeps the observer contract the restyle did not touch', async () => {
  // TableOfContents.astro's script keys off these attributes, and its two
  // comments each record a bug it was written against: a symmetric root
  // margin flickers between headings, and a page scrolled to the bottom
  // never lights its last section. A restyle that renamed either attribute
  // would silently disable both fixes.
  const page = await html(ARTICLE);
  expect(page).toMatch(/data-toc-link="[^"]+"/);
  expect(page).toContain('aria-label="Table of contents"');
});

test('the meta rail offers the .md variant this page already advertises', async () => {
  // One URL, not two. tests elsewhere in this file assert the <link> tag and
  // the X-Markdown-Variant header agree; a third hand-built copy in the rail
  // is exactly the drift they exist to catch.
  const page = await html(ARTICLE);
  const advertised = /<link rel="alternate" type="text\/markdown" href="([^"]+)"/.exec(page);
  expect(advertised, 'no markdown variant advertised').not.toBeNull();
  const rail = /data-article-meta-rail[\s\S]*?<\/aside>/.exec(page)![0];
  expect(rail).toContain(`href="${advertised![1]}"`);
});

test('copy and share degrade to real links without JavaScript', async () => {
  // Rendered markup is the no-JS state by definition. Two dead buttons is
  // the failure this catches.
  const rail = /data-article-meta-rail[\s\S]*?<\/aside>/.exec(await html(ARTICLE))![0];
  const copy = /<[^>]*data-copy-markdown[^>]*>/.exec(rail);
  expect(copy, 'no copy-as-markdown control').not.toBeNull();
  expect(copy![0].startsWith('<a ')).toBe(true);
  expect(copy![0]).toMatch(/href="[^"]+"/);
});

test('asking the agent about this page seeds nothing from the request', async () => {
  const rail = /data-article-meta-rail[\s\S]*?<\/aside>/.exec(await html(ARTICLE))![0];
  expect(rail).toContain('href="/chat"');
  // A query string here would put page-derived content into a URL, which is
  // the kind of thing /fit's whole design exists to avoid doing by accident.
  expect(rail).not.toMatch(/href="\/chat\?/);
});

test('related posts are published, are not this article, and are a hairline grid', async () => {
  const page = await html(ARTICLE);
  const related = /data-related-posts[\s\S]*?<\/section>/.exec(page);
  expect(related, 'no related posts section').not.toBeNull();
  expect(related![0]).toContain('hairline-grid');
  expect(related![0]).not.toContain(ARTICLE);
  for (const entry of CONTENT_ENTRIES.filter((e) => e.draft)) {
    expect(related![0]).not.toContain(`/${entry.section}/${entry.slug}`);
  }
});

test('the reading progress fill is driven by scroll, not by a transition', async () => {
  // The design budgets three motion moments and this is one of them, as a
  // continuous readout. A CSS transition on the fill makes it lag the scroll
  // and reads as broken rather than as eased.
  const page = await html(ARTICLE);
  const bar = /data-reading-progress[\s\S]{0,400}/.exec(page)![0];
  expect(bar).not.toMatch(/transition/);
});

test('the case study template still renders, unchanged by this issue', async () => {
  // ArticleLayout serves both collections and its header records that typing
  // it to one is what blocked /work. The inverted masthead is a later issue;
  // this asserts /work did not break on the way there.
  const page = await html('/work/silent-failure');
  expect(page).toContain('data-article-toc');
});

test('omits series navigation for a one-post series', async () => {
  // type-specimen is the only post in its series, so the nav must not render.
  // A "Part 1 of 1" block is noise, and this is the cheap guard against it.
  const page = await html('/writing/type-specimen');
  expect(page).not.toContain('data-series-nav');
});

// The 404 (design 3a, issue #112). `html()` is not used below: it asserts a
// 200, and this page's whole job is to answer 404. The invisibility half of
// this page -- that its body is the same bytes whatever path produced it --
// lives in tests/fit-pages.test.ts, beside the `/fit` refusal that depends on
// it. What is asserted here is the half that is allowed to have content.
test('the 404 offers recent writing, which is the same on every path', async () => {
  const page = await (await server.fetch('/no-such-page')).text();
  expect(page).toContain('MOST RECENT WRITING');
  const published = CONTENT_ENTRIES.filter((e) => e.section === 'writing' && !e.draft);
  const rows = [...page.matchAll(/data-recent-row/g)].length;
  // Derived from the content collection rather than from the request, which
  // is what makes it safe to render here at all. Follows the count rather
  // than rendering an empty row, the same rule the home page's more-writing
  // grid follows.
  expect(rows).toBe(Math.min(3, published.length));
  for (const entry of CONTENT_ENTRIES.filter((e) => e.draft)) {
    expect(page).not.toContain(`/${entry.section}/${entry.slug}`);
  }
});

test('the 404 fills the requested box as text, never as HTML', async () => {
  // location.pathname is attacker-controlled in the sense that anyone can
  // craft a URL, and this is the one page every unrouted request lands on.
  // `textContent` is the whole defense; `innerHTML` here would be a reflected
  // XSS on the site's widest surface. Asserted against the shipped script
  // rather than the source file, because it is the shipped one that runs.
  //
  // `elementWith` rather than a regex over <script> tags. Two hand-written
  // versions of that regex drew a high-severity js/bad-tag-filter alert in a
  // row -- the first missed `<SCRIPT>`, the second missed `</script >`, which
  // is legal HTML -- and CodeQL is right about the general case even though
  // this one parses the site's own build output and renders nothing from it.
  // The shared helper already counts tags properly and exists because this
  // repo has been bitten by hand-rolled markup windows twice; see its header.
  const page = await (await server.fetch('/no-such-page')).text();
  const fill = elementWith(page, 'script', 'data-requested-fill');
  expect(fill).toContain('textContent');
  expect(fill).not.toContain('innerHTML');
});

test('the 404 mails the address the résumé record carries, not a typed copy', async () => {
  // Same rule the footer follows, applied to the one mail link on this page:
  // the résumé record is the source of truth for the address, and reading it
  // is what stops a second copy drifting from it.
  //
  // Scoped to <main>, because the footer carries its own mailto: on every
  // page of the site -- including this one. Unscoped, this passed against the
  // page that had no mail link of its own at all, which is the shape of
  // assertion that proves nothing.
  const page = await (await server.fetch('/no-such-page')).text();
  const main = /<main\b[^>]*>[\s\S]*?<\/main>/.exec(page);
  expect(main, 'no main landmark on the 404').not.toBeNull();
  const email = /^\s*email:\s*(\S+)\s*$/m.exec(readFileSync(resumeYamlPath, 'utf8'))?.[1];
  expect(email, 'no email in the résumé record').toBeTruthy();
  expect(main![0]).toContain(`mailto:${email}`);
});

test('the 404 stays prerendered', async () => {
  // An on-demand 404 would answer from a different code path than the asset
  // server's, which is what serves it today -- and src/worker.ts's flattening
  // of every /fit refusal to this page depends on that. What it would actually
  // leak is the canonical tag, which Base.astro renders from Astro.url.pathname;
  // src/pages/404.astro's header carries the measurement.
  //
  // Matched against the frontmatter script with its comments stripped, not
  // against the file. Both cruder forms of this test failed on the same file
  // for the same reason: the page's header explains what the opt-out would
  // cost and quotes the declaration to do it, so a scan of the raw source
  // cannot tell the explanation from the thing explained, and punishes the
  // file for documenting the rule this test exists to enforce. That is the
  // trap tests/print.test.ts and tests/type-scale.test.ts both record having
  // hit; this is their fix applied a third time.
  const source = readFileSync(new URL('../src/pages/404.astro', import.meta.url), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source);
  expect(frontmatter, 'no frontmatter fence in 404.astro').not.toBeNull();
  const code = frontmatter![1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  expect(code).not.toMatch(/export\s+const\s+prerender\s*=\s*false/);
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
  const entries = workEntriesFromYaml();
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

test('the resume masthead closes with the same hairline as the chrome above it', async () => {
  const page = await html('/resume');
  expect(page).toContain('data-resume-masthead');
  // INVERTED 2026-09-13. The comment this test used to carry was the argument
  // for the opposite rule, and it is worth keeping the sentence that was
  // wrong: "--rl-ink is what distinguishes this rule from the dozens of
  // --rl-rule hairlines on the page, and it is the half of the design this
  // page still keeps."
  //
  // What that missed is which hairlines this one is actually read against. It
  // is not competing with the dozens below it; it is seen next to the two
  // directly above it, and both of those are --rl-rule -- SiteHeader.astro's
  // own bottom border and ArticleLayout's `article` masthead shell. Ink made
  // this the only closing rule on the site drawn in a different colour from
  // its neighbours, which is what "too dark in both themes" was describing.
  //
  // The weight assertion survives unchanged. 1px was the half of the earlier
  // review that was right, and a revert to design 1k's 2px is still the
  // regression worth guarding.
  expect(page).toMatch(/data-resume-masthead[^>]*class="[^"]*\bborder-b\b[^"]*border-rule/);
  expect(page).not.toMatch(/data-resume-masthead[^>]*class="[^"]*border-b-2/);
  expect(page).not.toMatch(/data-resume-masthead[^>]*class="[^"]*border-ink/);
});

test('the resume links the place it says Ryan is based', async () => {
  const page = await html('/resume');
  const masthead = /<section data-resume-masthead[\s\S]*?<\/section>/.exec(page);
  expect(masthead, 'no résumé masthead on the page').not.toBeNull();

  const line = /<p[^>]*data-based-in[\s\S]*?<\/p>/.exec(masthead![0]);
  expect(line, 'no data-based-in line in the résumé masthead').not.toBeNull();
  expect(line![0]).toContain('href="https://en.wikipedia.org/wiki/Laguna_Niguel,_California"');
  // The site's convention for an external href, and the footer has its own
  // test for the same pair. A link that leaves the résumé for a geography
  // detour is the case target="_blank" is actually for.
  expect(line![0]).toContain('target="_blank"');
  expect(line![0]).toContain('rel="noopener"');

  // THE DRIFT GUARD, and the only assertion here that is not redundant today.
  // The city is in the résumé record and the Wikipedia URL is a constant in
  // the page, so they are two sources for one fact. If Ryan moves, the record
  // is what gets edited and this fails, rather than the page going on linking
  // a town he no longer lives in. Derived from the record rather than from the
  // page's own constant, so it is a real cross-check and not a mirror.
  const city = /^\s*city:\s*(.+)$/m.exec(readFileSync(resumeYamlPath, 'utf8'))?.[1]?.trim();
  expect(city, 'no city in the résumé record').toBeTruthy();
  expect(line![0]).toContain(`/wiki/${city!.replaceAll(' ', '_')},`);
});

test('the resume sheet carries contact details the screen page does not', async () => {
  // 02 §1 wants the résumé ATS-safe, and an ATS-safe résumé with no way to
  // reach anyone is a contradiction. This block was added when /resume.pdf was
  // headless Chrome printing /resume, which made the page itself the only place
  // it could live. #181 gave the sheet its own route and #186 deleted the
  // renderer that printed this one, so the published PDF no longer comes from
  // here. The block stays hidden on screen because a browser print of /resume
  // should still carry the details.
  //
  // Print-only was the ruling on 2026-09-13 rather than showing it on both:
  // design 1k's masthead stays as drawn, and the phone number stays off an
  // indexed HTML page. It is already public in /resume.json, so this is about
  // where a crawler trips over it, not about whether it is a secret.
  const page = await html('/resume');
  const masthead = /<section data-resume-masthead[\s\S]*?<\/section>/.exec(page);
  expect(masthead, 'no résumé masthead on the page').not.toBeNull();

  // Read from the record, not typed -- the rule the footer and 404 mail links
  // already follow. A typed copy is a second source that drifts silently, and
  // this address ships in four formats.
  const yaml = readFileSync(resumeYamlPath, 'utf8');
  const email = /^\s*email:\s*(\S+)\s*$/m.exec(yaml)?.[1];
  const phone = /^\s*phone:\s*(.+)$/m.exec(yaml)?.[1]?.trim();
  expect(email, 'no email in the résumé record').toBeTruthy();
  expect(phone, 'no phone in the résumé record').toBeTruthy();

  const block = /<div[^>]*data-resume-contact[\s\S]*?<\/div>/.exec(masthead![0]);
  expect(block, 'no contact block in the résumé masthead').not.toBeNull();
  // Hidden on screen, shown on paper. Asserted as both halves, because
  // `hidden` alone would ship a block that never prints and `print:block`
  // alone would put the phone number on the screen page.
  expect(block![0]).toMatch(/class="[^"]*\bhidden\b[^"]*\bprint:block\b/);
  expect(block![0]).toContain(`mailto:${email}`);
  expect(block![0]).toContain(phone!);
  // Hand-derived E.164, not recomputed from the record by the same expression
  // the page uses -- a mirror assertion here would pass whatever the page
  // emitted, including `tel:(714) 330-6251`, which is not a dialable href.
  expect(block![0]).toContain('href="tel:+17143306251"');
});

test('the section rail carries every rendered section and spies on it', async () => {
  const page = await html('/resume');
  const rail = /data-resume-rail[\s\S]*?<\/nav>/.exec(page);
  expect(rail, 'no sticky rail').not.toBeNull();
  // Read from the YAML rather than hardcoded, for the same reason the section
  // headings are: Projects, Education and Skills each vanish while their array
  // is empty, and a rail item pointing at a section that is not on the page is
  // a broken link rather than a missing one.
  const yaml = readFileSync(resumeYamlPath, 'utf8');
  const sections = ['experience', 'projects', 'education', 'skills'].filter(
    (id) => id === 'experience' || !yamlArrayIsEmpty(yaml, id),
  );
  expect(sections.length, 'no résumé sections render at all').toBeGreaterThan(1);
  for (const id of sections) {
    expect(rail![0], `the rail does not link #${id}`).toContain(`#${id}`);
    expect(page, `no section with id ${id}`).toContain(`id="${id}"`);
  }
  // The same contract the article rail uses. A second observer built by hand
  // would not carry the two fixes TableOfContents.astro's comments record.
  expect(rail![0]).toMatch(/data-toc-link="/);
});

test('the section rail is one a reader can still see at the foot of the page', async () => {
  // `sticky` on the aside is not enough on its own, and the way it fails is
  // silent: a grid item stretches to its row, so the aside was as tall as the
  // whole résumé and had nowhere to move inside its own box. MEASURED at
  // 1280x900 before the fix -- scrolled to the bottom of /resume, the rail's
  // top sat 4621px above the viewport. After it, 96px at every scroll
  // position, which is also where `scroll-padding-top: 6rem` lands a heading
  // when a rail item is clicked. ArticleLayout.astro carries `lg:items-start`
  // for exactly this reason and had no guard either.
  const page = await html('/resume');
  const grid = /<div[^>]*data-resume-body[^>]*>/.exec(page);
  expect(grid, 'no résumé body grid').not.toBeNull();
  expect(grid![0], 'the body grid would stretch the rail to full height').toContain('items-start');
  const rail = /<aside[^>]*data-resume-rail[^>]*>/.exec(page);
  expect(rail, 'no résumé rail').not.toBeNull();
  expect(rail![0]).toContain('sticky');
});

test('every employer block shows the full tenure, not just one role', async () => {
  // The span across the group, which for a company where several titles were
  // held is a number no single role carries: four consecutive Weedmaps rows
  // are one tenure starting in 2016, and the newest role alone starts in 2021.
  const page = await html('/resume');
  const groups = groupWorkByCompany(workEntriesFromYaml());
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    const tenure = formatDateRange(group.startDate, group.endDate);
    // Scoped to the employer's own block, not to the page: for a company with
    // a single role that range also appears in the roles column, so a
    // page-wide `toContain` would pass with no tenure rendered at all.
    const block = new RegExp(
      `data-employer data-company="${group.name.replaceAll('&', '&amp;')}"[\\s\\S]*?</li>`,
    ).exec(page);
    expect(block, `no employer block for ${group.name}`).not.toBeNull();
    expect(block![0], `${group.name} does not show its full tenure`).toContain(tenure);
  }
});

test('the four format buttons all resolve', async () => {
  const page = await html('/resume');
  const grid = /data-format-bar[\s\S]*?<\/div>/.exec(page);
  expect(grid, 'no format grid on the résumé').not.toBeNull();
  for (const href of ['/resume.md', '/resume.json', '/resume.pdf', '/chat']) {
    expect(grid![0], `${href} is missing from the format grid`).toContain(`href="${href}"`);
    const response = await server.fetch(href);
    expect(response.status, `${href} should resolve`).toBe(200);
  }
});

test('the gap notice stays out of a production render', async () => {
  // Its own comment: a production page announcing what content it is missing
  // is a worse artifact than one that is simply shorter.
  expect(await html('/resume')).not.toContain('data-gap-notice');
});

test('every date the résumé renders is inside a tabular element', async () => {
  // global.css gives `time` and `[data-numeric]` tabular figures, so a date
  // that renders outside both sets its digits on proportional widths and
  // columns of ranges stop lining up. Asserted as "every range the data
  // produces is inside one of those elements" rather than by counting them: a
  // count is just as happy with the wrong five elements marked.
  const page = await html('/resume');
  const tabular = [...page.matchAll(/<[a-z]+[^>]*data-numeric[^>]*>([^<]*)</g)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  expect(tabular.length, 'nothing on the résumé is marked tabular').toBeGreaterThan(0);

  const entries = workEntriesFromYaml();
  const ranges = new Set([
    ...entries.map((entry) => formatDateRange(entry.startDate, entry.endDate)),
    ...groupWorkByCompany(entries).map((group) => formatDateRange(group.startDate, group.endDate)),
  ]);
  for (const range of ranges) {
    expect(tabular, `${range} renders without tabular figures`).toContain(range);
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

test('a role summary reaches /resume and /resume.md', async () => {
  const record = parse(readFileSync(resumeYamlPath, 'utf8')) as Resume;
  const summary = record.work.find((entry) => entry.summary)?.summary;
  expect(summary, 'no work entry declares a summary').toBeTruthy();
  expect(await html('/resume')).toContain(summary);
  expect(await html('/resume.md')).toContain(summary);
});

test('every x_artifacts slug renders as a link on /resume and /resume.md', async () => {
  const record = parse(readFileSync(resumeYamlPath, 'utf8')) as Resume;
  const slugs = [...record.work, ...(record.projects ?? [])].flatMap((e) => e.x_artifacts ?? []);
  expect(slugs.length, 'the record declares no artifact slugs').toBeGreaterThan(0);
  const page = await html('/resume');
  const markdown = await html('/resume.md');
  for (const slug of slugs) {
    expect(page, `/resume does not link ${slug}`).toContain(`/work/${slug}`);
    expect(markdown, `/resume.md does not link ${slug}`).toContain(`/work/${slug}`);
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

test('every page carries rel="describedby" -> /llms.txt, including the aggregation pages with no .md twin', async () => {
  // FIX ROUND 2: `describedby` used to sit INSIDE Base.astro's `markdownHref
  // &&` block, which made "is this page described by /llms.txt?" accidentally
  // conditional on "does this page have a markdown twin?" -- so the home page
  // and both index pages, the three pages with no twin AT THE TIME, advertised
  // no llms.txt at all. Base.astro's own comment states the principle it was
  // violating: this site has one root-level, unscoped /llms.txt, so EVERY page
  // is covered by it, exactly like the two sitewide feed links directly above
  // it. That principle is what this loop still checks, for all three paths.
  //
  // Issue #171 (epic #165) is why "AT THE TIME" above is no longer true for
  // `/`: the home page gained its own markdown twin (src/pages/index.md.ts),
  // so it is no longer one of "the ones with no .md twin" this test's name
  // used to describe. Splitting the assertion below in two, rather than just
  // dropping `/` from the loop, is what keeps this test proving the same
  // thing FIX ROUND 2 fixed -- describedby is independent of markdownHref --
  // instead of silently losing coverage of `/` for that half of the claim.
  for (const path of ['/', '/writing', '/work']) {
    const page = await html(path);
    const head = page.slice(0, page.indexOf('</head>'));
    expect(head, `${path} should carry rel="describedby" pointing at /llms.txt`).toContain(
      '<link rel="describedby" href="/llms.txt">',
    );
  }
  // The aggregation surfaces (`/writing`, `/work`) still have no markdown
  // variant of their own and must not have gained one along the way: the two
  // tags are independent facts, and hoisting one must not hoist the other.
  // `/` is deliberately excluded from this half now -- see above.
  for (const path of ['/writing', '/work']) {
    const page = await html(path);
    const head = page.slice(0, page.indexOf('</head>'));
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
// `/llms-full.txt`.
//
// This comment used to open by noting that every real .mdx file was
// `draft: true`, so the build had nothing to put in the Writing/Case studies
// sections and nothing at all in `/llms-full.txt`. That is no longer true --
// two case studies and, as of `terminal-setup.mdx`, one post are published --
// but the rule it existed to enforce is why these tests are shaped the way
// they are, so it stays: task-9-brief.md is explicit that a test asserting
// only that emptiness would be exactly the trap this codebase has already
// shipped six times -- a test that passes because there is nothing to test
// (a deleted `.sort()`, a `stripXKeys` test with nothing to strip, Task 5's
// stale-serve test, Task 6's stripping branch, Task 7's Content-Type
// assertion, Task 8's unreachable negotiation code).
//
// That pairing is what made publishing cheap. Every "today's real state is
// empty" assertion was paired with a fixture-based assertion against the
// exported generator functions directly (src/lib/llms-index.ts), proving the
// generator produces a populated, correctly-shaped result and not just
// nothing. So when the emptiness ended, the fixtures kept covering the rules
// (heading omission above all) and only the live half needed re-pointing at
// the published corpus -- which is what it now asserts.

test('/llms.txt lists every published case study and post, and links no draft', async () => {
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

  // The Writing half. This assertion used to run the other way -- every post
  // was a draft, so it asserted `buildSection`'s no-empty-scaffolding rule by
  // requiring the Writing heading to be ABSENT, and its failure message asked
  // for that omission check to be moved to whichever section was still empty
  // the day a post shipped. `terminal-setup.mdx` shipped and no section is
  // empty any more, so there is nowhere live to move it to.
  //
  // It does not need one. The omission rule never actually depended on this
  // live assertion: `buildLlmsTxt omits a heading entirely when its link list
  // is empty` proves it against a fully empty fixture, and the fixture test
  // after it asserts `## Case studies` stays absent while `## Writing` renders
  // -- the exact "one section populated, its neighbour omitted" case this used
  // to cover, and it holds regardless of what is published. So the live half
  // becomes what it can now genuinely check: the published post is listed.
  const publishedPosts = CONTENT_ENTRIES.filter((e) => e.section === 'writing' && !e.draft);
  expect(publishedPosts.length, 'expected at least one published post').toBeGreaterThan(0);
  expect(page).toContain('## Writing');
  for (const entry of publishedPosts) {
    expect(page, `/llms.txt should link /writing/${entry.slug}.md`).toContain(
      `(https://ryanlindsey.me/writing/${entry.slug}.md)`,
    );
  }
  for (const entry of CONTENT_ENTRIES.filter((e) => e.section === 'writing' && e.draft)) {
    expect(page, `/llms.txt must not link the draft /writing/${entry.slug}`).not.toContain(
      `/writing/${entry.slug}.md`,
    );
  }

  // The three sections that never depend on published content still render --
  // their absence would mean the whole generator broke, not that the
  // omission rule is working.
  expect(page).toContain('## Resume');
  expect(page).toContain('## MCP');
  // Day 6: the site's own interactive surfaces. `/fit` is NOT here and must not
  // be -- it is unlisted by requirement (09 §1), pinned separately below.
  expect(page).toContain('## Site');
  expect(page).toContain('https://ryanlindsey.me/chat');
  // Day 6 Task 13: /ops and /ai-policy joined /chat in SITE_LINKS -- pinned
  // here for the same reason /chat already was, so deleting either entry
  // fails this test rather than only the nav test below.
  expect(page).toContain('https://ryanlindsey.me/ops');
  expect(page).toContain('https://ryanlindsey.me/ai-policy');
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
  // RSS joined this column in the 2026-09 redesign (issue #100), which names
  // three FOR AGENTS links and picks RSS as the feed. /feed.json is the JSON
  // Feed twin and is deliberately not the one named -- src/lib/feeds.ts
  // builds both, and every page still advertises both in <link rel>.
  expect(footer, 'footer should link the RSS feed').toContain('href="/rss.xml"');
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
// the harness's primary), so the next two tests exercise the forward over
// the `MCP` service binding end to end, not the MCP Worker directly the way
// tests/mcp-tools.test.ts and tests/mcp.smoke.test.ts do. The server-card
// test that follows them is not a third: `/mcp/server-card` is never
// forwarded (src/pages/mcp/server-card.ts serves the site's own copy), so it
// exercises that on-demand route directly.

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

test('/mcp/server-card on the site origin is served, not swallowed by the SPA 404 page', async () => {
  // The first sub-path under /mcp anywhere: `/mcp` is an exact
  // `run_worker_first` entry, so `/mcp/server-card` needs its own line.
  // Measured 2026-09-21, before that line existed: this assertion failed
  // with "expected 404 to be 200", because the asset router served the
  // prerendered 404 and the on-demand route (src/pages/mcp/server-card.ts)
  // never ran. That is what this test guards against.
  const response = await server.fetch('/mcp/server-card');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/mcp-server-card+json');
  const card = (await response.json()) as { remotes: { url: string }[] };
  expect(card.remotes[0]?.url).toBe('https://ryanlindsey.me/mcp');
});

test('/mcp/server-card on the site origin answers a CORS preflight', async () => {
  // The two origins' 200s match because both call `serverCardResponse`
  // (src/lib/discovery/server-card-v1.ts), but that helper never decides
  // which methods a route answers -- method handling is per-route, in this
  // route's own `OPTIONS` export and in the MCP Worker's matching branch
  // (workers/mcp/src/index.ts). Before either existed, Astro's endpoint
  // runtime returned a bare 404 with no headers here for any method this
  // route exports no handler for, `OPTIONS` included, so a browser client
  // revalidating with `If-None-Match` -- not a CORS-safelisted request
  // header, so a preflight is mandatory -- would have preflighted
  // successfully against mcp.ryanlindsey.me (which answered every method)
  // and failed here, exactly the divergence running one helper on both
  // origins is meant to rule out. Follows the shape of the `/mcp` preflight
  // test above it.
  const response = await server.fetch('/mcp/server-card', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://claude.ai',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'if-none-match',
    },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('access-control-allow-methods')).toBe('GET');
  expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type, If-None-Match');
  expect(response.headers.get('access-control-expose-headers')).toBe('ETag');
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

test('robots.txt carries the owner-decided Content-Signal reservation, points at /llms.txt and the MCP endpoint, and ships a Sitemap line that resolves', async () => {
  const body = await (await server.fetch('/robots.txt')).text();
  // Owner's decision, 2026-09-06: search/ai-input readable and citable now,
  // ai-train reserved -- see the file's own comment for why these are not
  // the same lever.
  expect(body).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=no, use=reference');
  expect(body).toContain('/llms.txt');
  // Fix round 1 (task-9-report.md, applies here too): the endpoint is `/mcp`
  // on that domain, not the bare origin -- the bare origin 404s.
  expect(body).toContain('https://mcp.ryanlindsey.me/mcp');
  // This assertion used to be `not.toMatch(/^Sitemap:/m)`, on the grounds that
  // no sitemap existed and "a Sitemap line pointing at a 404 would be worse
  // than having none". Launch added both together, exactly as robots.txt's own
  // comment said it would, so the assertion inverts -- and then goes one step
  // further than the original, because a Sitemap line is only as good as what
  // it resolves to, and that is the failure the original was guarding against.
  const sitemapLine = body.match(/^Sitemap: (\S+)$/m);
  expect(sitemapLine, 'robots.txt should ship a Sitemap line').not.toBeNull();

  const sitemapUrl = new URL(sitemapLine![1]);
  expect(sitemapUrl.origin).toBe('https://ryanlindsey.me');
  const sitemap = await server.fetch(sitemapUrl.pathname);
  expect(sitemap.status, `${sitemapUrl.pathname} should not 404`).toBe(200);
  // An index file, not the URL list itself -- @astrojs/sitemap emits
  // `sitemap-index.xml` pointing at one or more `sitemap-N.xml`, and a
  // Sitemap line aimed at the wrong one of those still "resolves" while
  // advertising a fraction of the site.
  const indexXml = await sitemap.text();
  expect(indexXml).toContain('<sitemapindex');
  const children = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(children.length, 'the sitemap index should name at least one sitemap').toBeGreaterThan(0);
  for (const child of children) {
    expect((await server.fetch(new URL(child).pathname)).status, `${child} should not 404`).toBe(
      200,
    );
  }
});

/**
 * What the sitemap may and may not carry. Two separate guarantees, and the
 * second is the one with teeth.
 *
 * Publishing the first post (and with it launch flipping Base.astro's default
 * from `noindex` to `index, follow`) made every page indexable UNLESS it says
 * otherwise -- which inverted the risk on this file. Before, a mistake left a
 * published page invisible; now a mistake publishes an unpublished one. Drafts
 * are the exposure, because they have real routes on purpose, so they are
 * asserted against by name here rather than trusted to the filter.
 */
test('the sitemap lists every published page and no draft', async () => {
  const indexXml = await (await server.fetch('/sitemap-index.xml')).text();
  const child = indexXml.match(/<loc>([^<]+)<\/loc>/)![1];
  const xml = await (await server.fetch(new URL(child).pathname)).text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);

  for (const entry of CONTENT_ENTRIES.filter((e) => !e.draft)) {
    expect(locs, `the sitemap should list ${entry.section}/${entry.slug}`).toContain(
      `/${entry.section}/${entry.slug}/`,
    );
  }
  for (const entry of CONTENT_ENTRIES.filter((e) => e.draft)) {
    expect(locs, `the sitemap must not list the draft ${entry.slug}`).not.toContain(
      `/${entry.section}/${entry.slug}/`,
    );
  }
  // The section indexes and the résumé, so a filter that went too far shows up
  // here rather than as quiet invisibility.
  for (const path of ['/', '/writing/', '/work/', '/resume/']) {
    expect(locs, `the sitemap should list ${path}`).toContain(path);
  }
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
