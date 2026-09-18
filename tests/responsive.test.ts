import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { elementWith } from './markup';

/*
 * The responsive decisions, asserted as the markup that carries them.
 *
 * WHAT THIS SUITE CAN AND CANNOT DO, because the distinction decided the
 * approach and the pull request should not have to re-argue it. `jsdom` does no
 * layout, so nothing in a plain Vitest run can measure a collapse; the honest
 * alternatives were asserting the classes or standing up a browser in CI.
 * Playwright measures the real thing and costs a dependency, a CI step and a
 * browser download on a repo whose CI deliberately holds no credentials and
 * whose every harness suite already boots real Workers in workerd. That was
 * judged too much permanent weight for the amount of layout this site has.
 *
 * So: these tests catch a decision being deleted. They do not catch a viewport
 * at which something still overflows. The 390/768/1024/1280/1440 audit is run
 * by hand, and issue #113's decision comment records what it measured.
 */
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

const ARTICLE = '/writing/agent-native-site';

const sourceOf = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ 1. TOC */

test('the article contents rail is a disclosure, and it ships open', async () => {
  // Measured at 390px before this issue: the rail is 330px of links between
  // the masthead and the first paragraph, on an article with eight top-level
  // headings and no children. A longer one is worse.
  //
  // `open` IS IN THE SHIPPED MARKUP and a script removes it below `lg`. Written
  // that way round so a reader with no JavaScript gets exactly the pre-#113
  // behaviour at every width -- the rail expanded -- rather than a desktop rail
  // that is silently a collapsed disclosure. Progressive enhancement only ever
  // takes the rail away on the viewport where it was costing a screen.
  const rail = elementWith(await html(ARTICLE), 'aside', 'data-article-toc');
  expect(rail).toContain('<details');
  expect(rail).toMatch(/<details[^>]*\sopen[\s>]/);
  expect(rail).toContain('<summary');
});

test('the desktop rail is never a disclosure control', async () => {
  // The summary is the only new chrome, and it must not reach the viewport the
  // handoff actually designed. `lg:hidden` rather than a second component.
  const rail = elementWith(await html(ARTICLE), 'aside', 'data-article-toc');
  const summary = /<summary[^>]*>/.exec(rail);
  expect(summary, 'no summary in the article rail').not.toBeNull();
  expect(summary![0]).toContain('lg:hidden');
});

test('the policy rail collapses too, because it is built from headings', async () => {
  // Same rule as the article: a rail built from a document's own headings is
  // unbounded. /ai-policy renders twelve items today.
  const rail = elementWith(await html('/ai-policy'), 'aside', 'data-policy-rail');
  expect(rail).toContain('<details');
});

test('the resume rail stays a plain list', async () => {
  // THE DELIBERATE ASYMMETRY, and the rule behind it: the disclosure is for a
  // rail built from a document's own headings, not for one built from a fixed
  // list of four. Experience / Projects / Education / Skills costs about 150px
  // stacked, and a disclosure that hides four lines is more chrome than it
  // saves. Which is why the collapse is a prop each call site answers rather
  // than a breakpoint baked into TableOfContents.astro.
  const rail = elementWith(await html('/resume'), 'aside', 'data-resume-rail');
  expect(rail).not.toContain('<details');
});

test('the script that collapses the rail is valid JavaScript', async () => {
  // THIS TEST EXISTS BECAUSE THE FIRST VERSION OF THAT SCRIPT WAS NOT.
  // It was written as `<script is:inline>{`...`}</script>`, and Astro treats a
  // <script> element's children as RAW TEXT rather than as an expression, so
  // the backticks and braces were emitted literally: the page shipped a script
  // ending `})();`}` which throws SyntaxError before its first statement. Every
  // markup assertion above still passed, because the disclosure and the summary
  // were both exactly right -- the rail simply never closed, and only looking
  // at the rendered page at 390px showed it.
  //
  // AND A PARSE CHECK ALONE DOES NOT CATCH IT, which was this test's first
  // wrong guess and is worth keeping. `{`...`}` is perfectly valid JavaScript:
  // a block statement containing one template-literal expression statement. It
  // parses, runs, evaluates a string and throws nothing away except the entire
  // point. `new Function()` returned happily on the broken version.
  //
  // The backtick is what actually distinguishes them, because the real script
  // contains none. Both assertions stay: the parse check guards the next way
  // this could break, and the backtick check guards the way it did.
  const page = await html(ARTICLE);
  const inline = [...page.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((body) => body.includes('data-toc-disclosure'));
  expect(inline, 'no inline rail-sync script on the article').toHaveLength(1);
  expect(() => new Function(inline[0])).not.toThrow();
  expect(inline[0], 'the script shipped as a template literal, not as code').not.toContain('`');
  // It reaches the statement that does the work rather than merely mentioning
  // it: the broken version contained this string too.
  expect(inline[0]).toMatch(/^\s*\(\(\)\s*=>/);
});

test('the collapse grew no second observer', () => {
  // Issue #113 states the constraint outright: whatever the mobile TOC becomes,
  // it reuses this observer rather than growing a second one. The script here
  // carries two fixes its own comments record -- a symmetric root margin
  // flickers between two headings, and a page scrolled to the very bottom never
  // lights its last section -- and a second copy would arrive without either.
  const source = sourceOf('src/components/TableOfContents.astro');
  expect([...source.matchAll(/new IntersectionObserver/g)]).toHaveLength(1);
});

/* --------------------------------------------------- 2. Tables that scroll */

test('the risk register table scrolls instead of pushing the page', async () => {
  // MEASURED at 390px before this issue: /ai-policy overflowed by 543px and at
  // 768px by 165px. The table already had `overflow-x-auto` and `min-w-[56rem]`
  // -- the scroll container the epic's global constraints allow a table -- and
  // it never got the chance to use them. The container sits in a grid item, a
  // grid item's default `min-width: auto` resolves to its min-content width,
  // and 56rem of table is 896px of min-content, so the TRACK grew to 898px
  // instead of the container scrolling. The rail beside it stretched to match,
  // which is why the offending element measured as the <aside> and not as the
  // table -- and why reading the symptom would have sent someone to the rail.
  //
  // `min-w-0` on the grid item is the whole fix.
  const page = await html('/ai-policy');
  const content = /<div[^>]*data-policy-content[^>]*>/.exec(page);
  expect(content, 'no policy content column').not.toBeNull();
  expect(content![0]).toMatch(/\bmin-w-0\b/);
  expect(page).toContain('overflow-x-auto');
});

test('the evals table carries the same guard before it needs it', async () => {
  // /ops does NOT overflow today, and only because `min-w-[22rem]` is 352px and
  // that is narrower than a 390px viewport. It is the same latent trap under a
  // smaller number: widen that table by one column and the page starts pushing.
  // The guard goes on now, while the reason is written down.
  const page = await html('/ops');
  const panel = elementWith(page, 'section', 'id="evals"');
  expect(panel).toMatch(/\bmin-w-0\b/);

  // THE TABLE ITSELF IS ASSERTED FROM SOURCE, and the reason is the point of
  // the panel assertion above. This harness has no eval runs to render, so /ops
  // serves the "No runs recorded yet" branch and the table is not in the
  // markup at all -- which is exactly when a guard gets quietly dropped,
  // because nothing that renders here can miss it.
  const source = sourceOf('src/pages/ops.astro');
  const table = /<table class="([^"]*min-w-\[[^\]]+\][^"]*)"/.exec(source);
  expect(table, 'no width-floored table on /ops').not.toBeNull();
  expect(source).toContain('overflow-x-auto');
});

/* ------------------------------------------------ 3. The stacked diagram */

test('the stacked architecture diagram points its arrows down and up', async () => {
  // The content problem issue #113 names, and it is a content problem rather
  // than a layout one: stacked, `/mcp · chat · forms` runs from the Worker ABOVE
  // to the Worker BELOW and `document reads` runs back up. A `▶` says neither.
  // The labels are already right and do not change.
  const figure = elementWith(await html('/ops'), 'figure', 'data-architecture-diagram');
  expect(figure).toContain('▼');
  expect(figure).toContain('▲');
});

test('the vertical arrows are decoration, like the horizontal ones', async () => {
  // The same rule tests/ops-page.test.ts already applies to ▶ and ◀: the
  // connectors and glyphs are how the layout says "calls", and
  // ARCHITECTURE_DESCRIPTION already says it in words.
  const figure = elementWith(await html('/ops'), 'figure', 'data-architecture-diagram');
  for (const glyph of ['▼', '▲']) {
    const at = figure.indexOf(glyph);
    expect(at, `${glyph} is not in the diagram`).toBeGreaterThan(-1);
    expect(figure.slice(Math.max(0, at - 200), at)).toContain('aria-hidden');
  }
});

test('each arrow pair shows at exactly one of the two arrangements', async () => {
  // Both pairs are in the markup and the container query picks one. Without the
  // hidden/visible pair the stacked diagram would show all four arrows.
  const figure = elementWith(await html('/ops'), 'figure', 'data-architecture-diagram');
  const gutter = /<div[^>]*data-binding-gutter[^>]*>[\s\S]*?<\/div>/.exec(figure);
  expect(gutter, 'no binding gutter').not.toBeNull();
  expect(gutter![0]).toMatch(/@3xl:hidden/);
  expect(gutter![0]).toMatch(/@3xl:(inline|flex|block)/);
});

/* ------------------------------------------- 4. The home page on a phone */

test('the Now strip stacks below sm and is a row above it', async () => {
  // MEASURED at 390px before this change: the three clauses joined with a
  // middot are about 150 characters, which wraps to five lines of 14px text.
  // `items-baseline` on a flex row then pins the NOW chip to the baseline of
  // the FIRST of those five lines, so the label floats at the top left of the
  // paragraph it introduces rather than sitting beside it.
  //
  // Both halves are asserted. A container that stacked at every width would
  // pass a `flex-col` check alone while quietly deleting the design the strip
  // was drawn as.
  const page = await html('/');
  const container = /data-now-strip[^>]*>\s*<div class="([^"]+)"/.exec(page);
  expect(container, 'no Now strip container').not.toBeNull();
  expect(container![1]).toContain('flex-col');
  expect(container![1]).toContain('sm:flex-row');
  expect(container![1]).toContain('sm:items-baseline');
  // Without `w-fit` the chip stretches to the full width of a stacked column,
  // which turns a label into a band.
  const chip = /<span class="([^"]*bg-accent-ground[^"]*)"[^>]*>\s*NOW/.exec(page);
  expect(chip, 'no NOW chip').not.toBeNull();
  expect(chip![1]).toContain('w-fit');
});

test('the Now items are one copy of the content, separators included', async () => {
  // THE CONSTRAINT THAT RULES OUT THE OBVIOUS IMPLEMENTATION. A stacked list
  // for small viewports beside a joined line for large ones is the natural way
  // to build this, and it puts every clause in the DOM twice -- where the AI
  // Search index, an agent fetching the HTML, and `excerptFrom` in
  // src/lib/search/results.ts all see each one repeated with no way to tell
  // which copy a visitor was shown.
  //
  // So the separators are in the markup at every width and hidden with CSS,
  // and extracted text still reads `a · b · c` on a phone. Counting is what
  // makes the duplicate version fail: it renders each clause twice.
  const page = await html('/');
  const strip = /data-now-strip[\s\S]*?<\/section>/.exec(page);
  expect(strip, 'no Now strip').not.toBeNull();
  // Matched on the data attribute rather than on the class string. The first
  // version of this test keyed on `class="block sm:inline"` and went red the
  // moment a spacing utility was added to the same span -- a test that fails
  // for a change it does not care about is one the next person deletes.
  const items = [...strip![0].matchAll(/<span data-now-item\b/g)];
  expect(items.length, 'expected the Now clauses rendered once each').toBeGreaterThan(1);
  const separators = [...strip![0].matchAll(/aria-hidden="true"[^>]*>\s*·/g)];
  expect(separators.length, 'a separator per gap, hidden by CSS rather than absent').toBe(
    items.length - 1,
  );
  // READ OFF THE CLASS ATTRIBUTE, NOT THE WHOLE TAG, and the reason is a bug
  // this test shipped with for about ten minutes. It asserted
  // `expect(tag).toContain('hidden')` against the entire `<span ...>` string --
  // which always passes, because `aria-hidden="true"` is in that string. A
  // mutation run that stripped `hidden` from the class list was served a green
  // test. An assertion that cannot fail is not a check.
  for (const [, classes] of strip![0].matchAll(
    /<span[^>]*aria-hidden="true"[^>]*class="([^"]*)"/g,
  )) {
    const utilities = classes.split(/\s+/);
    expect(utilities, 'a separator that reaches a phone is a middot mid-sentence').toContain(
      'hidden',
    );
    expect(utilities).toContain('sm:inline');
  }
});

test('the bio column keeps a rule where the vertical one cannot reach', async () => {
  // The divider between the lead story and the bio is `lg:border-l`, so below
  // `lg` -- where the two blocks stack -- there is no divider at all, and 40px
  // of grid gap is the only thing between the end of one and the start of the
  // other. That is the whole of why they read as one jumbled block on a phone.
  //
  // Asserted as the pairing rather than as the presence of `border-t`: the
  // horizontal rule has to switch OFF again at `lg`, or the column gains a
  // stray hairline across the top of the layout the design did draw.
  const page = await html('/');
  //
  // SPLIT INTO UTILITIES RATHER THAN SUBSTRING-MATCHED, for the same reason the
  // separator test above carries. `toContain('border-t')` on the raw class
  // string is satisfied by `lg:border-t-0`, so deleting the mobile rule while
  // leaving its desktop switch-off behind passed a test written to catch
  // exactly that.
  const column = /<div class="([^"]*lg:border-l[^"]*)"/.exec(page);
  expect(column, 'no bio column').not.toBeNull();
  const utilities = column![1].split(/\s+/);
  expect(utilities, 'the stacked columns lost their divider').toContain('border-t');
  expect(utilities, 'the horizontal rule never switches off at lg').toContain('lg:border-t-0');
});

test('the bio kicker speaks to a person, not only to a parser', async () => {
  // "Who is writing" was written to answer a question a document gets asked,
  // and it read that way to the person the home page also serves. The markdown
  // twin carries the same heading over the same block, so this asserts both:
  // the page and its own export describing themselves differently is the
  // failure this pins.
  const page = await html('/');
  const bio = /data-bio[\s\S]*?<\/p>/.exec(page);
  expect(bio, 'no bio block').not.toBeNull();
  expect(bio![0]).toContain('About');
  expect(bio![0]).not.toContain('Who is writing');

  const markdown = await (await server.fetch('/index.md')).text();
  expect(markdown).toContain('## About');
  expect(markdown).not.toContain('## Who is writing');
});

test('the more-writing descriptions are clamped only where the cards share a row', async () => {
  // MEASURED at 1024px before this change: the three descriptions run 8, 14
  // and 8 lines in a 308px column, the grid row takes the tallest, and the two
  // short cards carry 172px of dead space above the reading-time line that
  // `mt-auto` pins to the bottom. At 1440px it was 63px and 92px.
  //
  // The clamp cannot be unconditional, and that is what this test guards.
  // Below `lg` the grid is one column, so each card is its own row and sizes
  // to its own content -- measured at 500px: 319/403/290 and no slack
  // anywhere. An unprefixed `line-clamp-4` would truncate three descriptions
  // on every phone to fix a problem phones do not have, and it would look
  // deliberate rather than broken, so nothing else would catch it.
  const page = await html('/');
  const section = /data-more-writing[\s\S]*?<\/section>/.exec(page);
  expect(section, 'no more-writing section').not.toBeNull();

  const descriptions = [...section![0].matchAll(/<p class="([^"]*text-ink-muted[^"]*)">/g)]
    .map((match) => match[1])
    .filter((classes) => classes.includes('line-clamp'));
  expect(descriptions.length, 'no clamped description in the card grid').toBeGreaterThan(0);
  for (const classes of descriptions) {
    const utilities = classes.split(/\s+/);
    expect(utilities, 'the clamp reaches the one-column layout').not.toContain('line-clamp-4');
    expect(utilities, 'the clamp is not scoped to the shared row').toContain('lg:line-clamp-4');
  }
});

test('a clamped description is still whole in the document', async () => {
  // `line-clamp` is overflow, not truncation: the text stays in the HTML for
  // the AI Search index, for an agent reading the page and for a screen
  // reader, and is hidden only from a sighted reader looking at the card. A
  // template that sliced the string instead would look IDENTICAL in a browser
  // and break all three of those at once, which is why this is asserted.
  //
  // ASSERTED AS EQUALITY, AND THE FIRST VERSION WAS NOT. It read
  // `expect(markdown).toContain(rendered)`, which a sliced description passes
  // trivially -- a prefix is always contained in the whole. A mutation run
  // that replaced the field with `description.slice(0, 120)` was served a
  // green test. This is the third assertion in this file to have failed that
  // way; `toContain` against a superset is the shape to distrust.
  //
  // Checked against /index.md rather than the frontmatter on disk: the
  // markdown twin renders the same collection field whole, so the two are two
  // renderings of one record, and no frontmatter parser has to be duplicated
  // into this file.
  const page = await html('/');
  const markdown = await (await server.fetch('/index.md')).text();
  const section = /data-more-writing[\s\S]*?<\/section>/.exec(page);
  expect(section, 'no more-writing section').not.toBeNull();

  const rendered = [...section![0].matchAll(/<p class="[^"]*line-clamp[^"]*">([^<]+)<\/p>/g)].map(
    (match) =>
      match[1].replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&').trim(),
  );
  expect(rendered.length, 'no clamped descriptions to check').toBeGreaterThan(0);

  // The twin's "More writing" section is heading/description pairs joined by
  // blank lines; the descriptions are the blocks that are not a heading line.
  const more = /## More writing\n\n([\s\S]*)$/.exec(markdown);
  expect(more, 'no more-writing section in the markdown twin').not.toBeNull();
  const recorded = more![1]
    .split('\n\n')
    .map((block) => block.trim().replaceAll('\\|', '|'))
    .filter((block) => block.length > 0 && !block.startsWith('**['));

  expect(rendered, 'the cards and the markdown twin disagree about the descriptions').toEqual(
    recorded,
  );
});
