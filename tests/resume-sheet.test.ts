/**
 * The print sheet at `/resume.print/` (issue #181), asserted against the
 * résumé record rather than against a list written here.
 *
 * WHY EVERY EXPECTATION IS DERIVED FROM THE YAML. The failure this suite
 * exists to catch already happened once on the other résumé surface: the PDF
 * shipped with no contact block at all, because the column that carried it was
 * hidden in print and nothing compared the rendered document to the record it
 * came from (src/pages/resume.astro records that fix in full). A test holding
 * a hardcoded list of "GitHub, LinkedIn, email, phone" would have passed on
 * that page too, right up until the list itself went stale. So the expected
 * values below are read off src/content/resume/ryan-lindsey.yaml: a third
 * profile added to the record fails this suite until it reaches the sheet.
 *
 * Read with the `yaml` package rather than through `astro:content`, which is a
 * virtual module that only resolves inside Astro's own pipeline and not from a
 * plain `vitest run` process -- the same constraint tests/resume.test.ts's
 * header records, and the reason that suite keeps a hand-built fixture.
 *
 * ASSERTED AGAINST RENDERED OUTPUT FETCHED THROUGH THE HARNESS, never against
 * the source of the `.astro` file. A test that greps the template for
 * `mailto:` passes on a template that renders it into a comment; the same
 * lesson tests/seo.test.ts opens with.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { stripComments } from './markup';
import { formatDateRange, groupWorkByCompany, type Resume } from '../src/lib/resume';

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

/**
 * MEASURED FROM THE BUILD rather than assumed. `src/pages/resume.print.astro`
 * carries a dot in its filename, and with `build.format: 'directory'` that
 * could plausibly have emitted `dist/client/resume.print.html` instead. It does
 * not: it emits `dist/client/resume.print/index.html`, so the route has a
 * trailing slash and tests/seo.test.ts's `builtPages()` -- which collects
 * `index.html` files only -- sees this page and holds it to every `<head>`
 * invariant the rest of the site is held to.
 */
const SHEET_PATH = '/resume.print/';

/**
 * The same route without the trailing slash. Which spelling answers is a
 * measurement rather than a convention here: `/resume.print` looks like a file
 * with a `.print` extension to Cloudflare's asset server, and `wrangler.jsonc`'s
 * `run_worker_first` lists `/resume` and `/resume/` as exact paths while naming
 * neither of these. A later change types this route as a constant, and it
 * should read the measured answer rather than guess one.
 */
const SHEET_PATH_BARE = '/resume.print';

/**
 * The résumé record, cast to the schema's OUTPUT type.
 *
 * THE CAST IS A LIE IN ONE DIRECTION AND THE READS BELOW ALLOW FOR IT. Every
 * field `content.config.ts` gives a `.default([])` -- `basics.profiles`,
 * `work[].highlights`, `projects` and `projects[].highlights` -- is written out
 * explicitly in today's YAML, so the cast is accurate right now. It is the raw
 * parse, though: Zod's defaults never run here, so a future entry that
 * legitimately omits `highlights:` arrives as `undefined` while the type says
 * `string[]`.
 *
 * That would turn a `flatMap` into a TypeError, which is a test failing with a
 * stack trace about a missing method instead of a report about the sheet. The
 * defaulted fields are therefore read through `?? []` at their call sites. It
 * costs nothing and weakens no assertion: an absent array and an empty one both
 * mean "nothing to check here", which is the same answer Zod would have given.
 */
const resume = parse(
  readFileSync(new URL('../src/content/resume/ryan-lindsey.yaml', import.meta.url), 'utf8'),
) as Resume;

/**
 * The two defaulted top-level arrays, read once through the guard the comment
 * above describes, so no test below has to remember to. `education` and
 * `skills` need no equivalent: the schema requires both, so a record without
 * them never reaches a build.
 */
const profiles = resume.basics.profiles ?? [];
const projects = resume.projects ?? [];

/**
 * Astro's own text escaping, reproduced so expectations can be compared
 * against the markup AS SERVED.
 *
 * The alternative -- unescaping the page -- was rejected: it needs a full
 * entity table to be correct, and getting it wrong fails open, quietly turning
 * a strict comparison into a loose one. Escaping the expectation needs only
 * the five characters Astro actually escapes, and getting THAT wrong fails
 * closed.
 *
 * This is not hypothetical tidiness. The résumé contains `>80%`, a literal
 * apostrophe in "Anthropic's" and a quoted award title, which reach the page
 * as `&gt;`, `&#39;` and `&quot;`. A suite that did not handle them would have
 * been weakened to a prefix match, which is the assertion that stops catching
 * a truncated bullet.
 *
 * `&` is replaced first, or it would re-escape the ampersands the later
 * replacements introduce.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A literal for use inside a `RegExp`, so a URL's dots match only dots. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every `<link rel="stylesheet">` href on a commentless page, in order. */
const stylesheetHrefs = (markup: string): string[] =>
  [...markup.matchAll(/<link rel="stylesheet" href="([^"]*)"/g)].map((match) => match[1]);

/** The sheet as served, commentless -- see tests/markup.ts on why. */
async function sheet(): Promise<string> {
  const response = await server.fetch(SHEET_PATH);
  expect(response.status, `${SHEET_PATH} should be 200`).toBe(200);
  return stripComments(await response.text());
}

/**
 * MEASURED, NOT ASSUMED: `/resume.print` answers 307 to `/resume.print/`, and
 * the redirect lands on the sheet.
 *
 * Every other test in this file fetches the trailing-slash form and would go on
 * passing if the bare one 404ed, so nothing here knew which spellings were live
 * until this test. That matters to more than tidiness: a later change types this
 * route as a constant, and a constant written from the page's filename rather
 * than from a measurement is one that names a URL nobody checked.
 *
 * `redirect: 'manual'` so the redirect itself is the subject. Following it
 * silently would assert only that some chain ends in a 200, which is the
 * assertion that cannot tell a redirect from a duplicate page -- two live URLs
 * for one document, which is what the canonical tag exists to prevent and what
 * tests/seo.test.ts records as an open defect for /chat and /ops.
 */
test('the sheet answers at both spellings of its route, one redirecting to the other', async () => {
  const bare = await server.fetch(SHEET_PATH_BARE, { redirect: 'manual' });
  expect(bare.status, `${SHEET_PATH_BARE} should redirect rather than 404`).toBe(307);
  expect(bare.headers.get('location'), `${SHEET_PATH_BARE} should point at the slashed form`).toBe(
    SHEET_PATH,
  );

  const slashed = await server.fetch(SHEET_PATH);
  expect(slashed.status, `${SHEET_PATH} should be 200`).toBe(200);
  expect(slashed.headers.get('content-type'), `${SHEET_PATH} should serve HTML`).toContain(
    'text/html',
  );
});

test('every contact value in the résumé record reaches the sheet', async () => {
  const html = await sheet();
  const { basics } = resume;

  // Asserted present in the record first. Without this, a record that lost its
  // email would make the `toContain(undefined)` below throw a type error
  // rather than report a missing field -- and a record with no contact detail
  // at all would pass a loop over an empty array.
  expect(basics.email, 'the record should carry an email').toBeTruthy();
  expect(basics.phone, 'the record should carry a phone number').toBeTruthy();
  expect(basics.url, 'the record should carry a url').toBeTruthy();
  expect(profiles.length, 'the record should carry at least one profile').toBeGreaterThan(0);

  expect(html, 'the sheet should carry the email').toContain(basics.email);
  expect(html, 'the sheet should carry the phone number').toContain(basics.phone);
  expect(html, 'the sheet should carry the site url').toContain(basics.url);

  // DERIVED FROM THE ARRAY, which is the whole point of this assertion: a
  // third network added to the record has to appear on the sheet without an
  // edit to the page or to this file.
  for (const profile of profiles) {
    expect(html, `the sheet should carry the ${profile.network} url`).toContain(profile.url);
  }

  expect(html, 'the sheet should carry the location').toContain(
    `${basics.location.city}, ${basics.location.region}`,
  );
});

test('the email and phone fields are dialable links, not plain text', async () => {
  const html = await sheet();

  expect(html).toContain(`href="mailto:${resume.basics.email}"`);

  // E.164, the same derivation src/pages/resume.astro uses and for the reason
  // its comment gives: the record stores the number the way a person reads it
  // and every dialer accepts this shape without guessing.
  const digits = (resume.basics.phone ?? '').replace(/\D/g, '');
  expect(digits.length, 'the phone number should contain digits').toBeGreaterThan(0);
  expect(html).toContain(`href="tel:+1${digits}"`);
});

/**
 * Two halves of one row, asserted together because a test that checked either
 * alone would miss the other.
 *
 * THE HREF carries the URL exactly as the record spells it, so the link
 * annotation in the printed PDF resolves.
 *
 * THE TEXT is the URL with its scheme and any `www.` stripped -- `displayUrl`
 * in src/pages/resume.print.astro, and this is the only place that function is
 * observable at all. Every other URL assertion in this suite matches the full
 * URL, which appears in the `href` whatever the text says, so a `displayUrl`
 * that returned its input unchanged -- printing `https://www.linkedin.com/in/…`
 * across a field column designed at 7.5pt -- passed every one of them.
 *
 * The expected text is computed here rather than imported, because the function
 * lives in an `.astro` frontmatter block and no plain vitest process can import
 * one. So the computed comparison is backed by two assertions that do not
 * restate the transform: a printed URL must not begin with a scheme, and must
 * not begin with `www.`. A reimplementation that drifted the same way twice
 * still fails those.
 */
test('every printed URL drops its scheme while its link keeps it', async () => {
  const html = await sheet();
  const linked = [resume.basics.url, ...profiles.map((profile) => profile.url)].filter(
    (url): url is string => typeof url === 'string' && url.length > 0,
  );
  expect(linked.length, 'the record should carry at least two linked URLs').toBeGreaterThan(1);

  for (const url of linked) {
    const anchor = new RegExp(`<a href="${escapeRegExp(url)}">([^<]*)</a>`).exec(html);
    expect(anchor, `${url} should be linked, not printed as plain text`).not.toBeNull();

    const printed = anchor?.[1] ?? '';
    expect(printed, `${url} should print without its scheme or www.`).toBe(
      url.replace(/^https?:\/\//, '').replace(/^www\./, ''),
    );
    expect(printed, `${url} printed a scheme`).not.toMatch(/^https?:/);
    expect(printed, `${url} printed a www. prefix`).not.toMatch(/^www\./);
  }
});

/**
 * THE PROPERTY THIS ROUTE EXISTS FOR, and the one nothing else in this
 * repository can see.
 *
 * src/pages/resume.print.astro uses neither Base.astro nor Shell.astro, and
 * forty lines across that file and src/styles/resume-sheet.css argue for it:
 * those layouts pull in global.css, tokens.css, Tailwind's preflight and the
 * theme script, and the measured three-page layout is a measurement of a
 * document carrying none of them.
 *
 * THE REGRESSION IS NOT EXOTIC. The hand-written `<head>` tags on that page
 * look like duplication of what Base.astro already renders, and the obvious
 * tidy-up is to wrap the page in it. Every other test in this repository stays
 * green if someone does: tests/seo.test.ts passes because the layout supplies
 * the same tags, every assertion in this file passes because every value it
 * checks still renders, and /resume is untouched. The sheet silently stops
 * being three pages and nothing says so.
 *
 * THE SIBLING'S STYLESHEETS ARE FETCHED RATHER THAN NAMED. Asserting that the
 * sheet does not link `Shell.<hash>.css` would hardcode a Vite chunk name that
 * is not this repository's to promise. `/resume` is the page that does use
 * Shell, so what it loads IS the definition of "what the site loads", and the
 * two sets must not intersect.
 *
 * The count is links PLUS inline `<style>` blocks, not links alone: Astro
 * inlines a stylesheet under 4 KB (`build.inlineStylesheets: 'auto'`), and the
 * sheet's own bundle is 4.4 KB today. If it ever drops under that, this stays
 * correct instead of going red for a reason that has nothing to do with
 * layouts.
 */
test('the sheet loads its own stylesheet and nothing the site loads', async () => {
  const html = await sheet();

  const linked = stylesheetHrefs(html);
  const inlined = [...html.matchAll(/<style[\s>]/g)].length;
  expect(
    linked.length + inlined,
    `the sheet should load exactly one stylesheet, got ${linked.length} linked and ${inlined} inline`,
  ).toBe(1);

  const response = await server.fetch('/resume/');
  expect(response.status, '/resume/ should be 200').toBe(200);
  const siblingSheets = stylesheetHrefs(stripComments(await response.text()));
  expect(
    siblingSheets.length,
    '/resume/ should load at least one stylesheet, or this test compares against nothing',
  ).toBeGreaterThan(0);

  const shared = linked.filter((href) => siblingSheets.includes(href));
  expect(
    shared,
    "the sheet is loading the site's own bundle, so it has been wrapped in a layout -- see this page's header for why it must not be",
  ).toEqual([]);

  // The theme script is the other half of what a layout would bring, and it is
  // inline rather than bundled, so it leaves no stylesheet for the check above
  // to catch. A sheet printed on paper has no theme.
  expect(html, 'the sheet should carry no theme machinery').not.toContain('data-theme');
});

test('the sheet refuses indexing', async () => {
  const directives = [...(await sheet()).matchAll(/<meta name="robots" content="([^"]*)"/g)].map(
    (match) => match[1],
  );

  // Exactly one, for the reason tests/seo.test.ts gives: two directives that
  // disagree leave the choice to the crawler rather than to this site.
  expect(directives, 'the sheet should carry exactly one robots directive').toHaveLength(1);
  expect(directives[0]).toContain('noindex');
});

test('the sheet is absent from the sitemap', async () => {
  const response = await server.fetch('/sitemap-0.xml');
  expect(response.status, '/sitemap-0.xml should be 200').toBe(200);
  const paths = [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => new URL(match[1]).pathname,
  );

  expect(paths.length, 'the sitemap should list at least one URL').toBeGreaterThan(0);
  expect(paths, 'the sheet is a render source and must not be advertised').not.toContain(
    SHEET_PATH,
  );

  // The neighbour it must not take with it. `isUnindexed` matches on path
  // segments, so `/resume.print` cannot swallow `/resume` -- this is the
  // assertion that would go red if that ever stopped being true.
  expect(paths, '/resume/ should still be in the sitemap').toContain('/resume/');
});

test('the sheet announces its own readiness the way the renderer waits for it', async () => {
  const html = await sheet();

  // `READY_ATTRIBUTE` in scripts/resume-sheet.mjs is `data-resume-ready` --
  // it was `RESUME_READY_SELECTOR` in src/lib/resume-pdf.ts until #186 moved
  // authority to the renderer that waits on it -- and this is the second page
  // to write it. Both strings are asserted in the
  // SERVED markup rather than in the template: an inline script is what puts
  // them there, and a bundled one would move both into an external file while
  // the page still looked correct in source.
  expect(html, 'the readiness attribute should be written by the served page').toContain(
    'data-resume-ready',
  );

  // `setAttribute` rather than `dataset.resumeReady`, per the day-2 ruling
  // src/pages/resume.astro records: a data-* contract has to stay greppable at
  // every write site.
  expect(html, 'the attribute should be set with setAttribute').toContain('setAttribute');

  expect(html, 'the wait should be on document.fonts.ready').toContain('document.fonts.ready');
});

test('every highlight in the résumé record prints on the sheet', async () => {
  const html = await sheet();

  // Work and projects both. Checking only `work` would let a project bullet
  // disappear silently, which is exactly the half of the sheet that is newest.
  const highlights = [
    ...resume.work.flatMap((entry) => entry.highlights ?? []),
    ...(resume.projects ?? []).flatMap((project) => project.highlights ?? []),
  ];
  expect(highlights.length, 'the record should carry highlights').toBeGreaterThan(0);

  const missing = highlights.filter((highlight) => !html.includes(escapeHtml(highlight)));

  // Collected and reported at once rather than failing on the first, the same
  // reasoning tests/seo.test.ts's sitemap test gives: one dropped bullet and
  // twenty dropped bullets are different bugs and should not look alike.
  expect(
    missing.map((highlight) => highlight.slice(0, 60)),
    'these highlights never reached the sheet',
  ).toEqual([]);
});

/**
 * THE SHAPE THE FIRST IMPLEMENTATION PASS GOT WRONG, which is why it is pinned
 * here rather than left to a reader's eye on the rendered PDF.
 *
 * A company where one title was held prints its range ONCE: the tenure beside
 * the company name is by construction that role's own range (`tenureOf` in
 * src/lib/resume.ts derives the span from the roles), so a range on the role
 * row as well would print the identical string twice, three lines apart. A
 * company where several titles were held prints a range per role, because the
 * tenure across the group is a span no single role carries.
 *
 * Asserted STRUCTURALLY -- does this `<h4>` carry a dates span at all -- rather
 * than by counting a date string. Two roles at one company can legitimately
 * share a boundary month, and a count-based assertion would turn that data
 * coincidence into a test failure about something else entirely.
 *
 * The expected grouping comes from `groupWorkByCompany`, the same function the
 * page calls. That is not circular here: the page's decision under test is
 * `group.roles.length > 1`, and what this checks is that the decision reached
 * the markup -- a page that dropped the condition, or applied it inverted,
 * fails against the same grouping.
 */
test('a company with one title prints its date range once, a company with several prints one per role', async () => {
  const html = await sheet();
  const groups = groupWorkByCompany(resume.work);

  // Both shapes have to exist in the real record, or this test passes by
  // covering only one of the two cases it is about.
  expect(
    groups.filter((group) => group.roles.length === 1).length,
    'the record should contain at least one single-role company',
  ).toBeGreaterThan(0);
  expect(
    groups.filter((group) => group.roles.length > 1).length,
    'the record should contain at least one multi-role company',
  ).toBeGreaterThan(0);

  // The Experience section only. Sliced to the first `</section>` after its own
  // heading, so the Projects entries below -- which use the same `.entry` and
  // `.dates` class names for a different job -- cannot be counted as work.
  const start = html.indexOf('<h2>Experience</h2>');
  expect(start, 'the sheet should carry an Experience section').toBeGreaterThan(-1);
  const experience = html.slice(start, html.indexOf('</section>', start));

  // `chunks[0]` is the heading that precedes the first entry; the rest line up
  // with `groups` in order, which the company-name assertion below verifies
  // rather than assumes.
  const chunks = experience.split('<div class="entry">').slice(1);
  expect(chunks.length, 'every work group should render one entry').toBe(groups.length);

  const problems: string[] = [];
  for (const [index, group] of groups.entries()) {
    const chunk = chunks[index];
    if (!chunk.includes(`<span class="org-name">${escapeHtml(group.name)}</span>`)) {
      problems.push(`entry ${index} should be ${group.name}`);
      continue;
    }

    // The company tenure, which every entry carries whatever its role count.
    const tenure = formatDateRange(group.startDate, group.endDate);
    if (!chunk.includes(`<span class="dates">${tenure}</span>`)) {
      problems.push(`${group.name} should print its tenure ${tenure}`);
    }

    const roleRows = [...chunk.matchAll(/<h4 class="row">([\s\S]*?)<\/h4>/g)].map(
      (match) => match[1],
    );
    if (roleRows.length !== group.roles.length) {
      problems.push(
        `${group.name} should render ${group.roles.length} role row(s), rendered ${roleRows.length}`,
      );
      continue;
    }

    const wantDates = group.roles.length > 1;
    for (const [roleIndex, row] of roleRows.entries()) {
      const hasDates = row.includes('class="dates"');
      if (hasDates !== wantDates) {
        problems.push(
          wantDates
            ? `${group.name} holds ${group.roles.length} titles, so role ${roleIndex} should print its own range`
            : `${group.name} holds one title, so role ${roleIndex} must not repeat the tenure`,
        );
      }
    }
  }

  expect(problems, `the role rows disagree with the record:\n${problems.join('\n')}`).toEqual([]);
});

test('every section of the record prints: summary, education and skills', async () => {
  const html = await sheet();

  expect(html).toContain(escapeHtml(resume.basics.summary));

  for (const entry of resume.education) {
    expect(html, `${entry.institution} should appear`).toContain(escapeHtml(entry.institution));
  }

  for (const skill of resume.skills) {
    expect(html, `${skill.name} should appear`).toContain(escapeHtml(skill.name));
    expect(html, `${skill.name}'s keywords should appear`).toContain(
      escapeHtml(skill.keywords.join(', ')),
    );
  }

  /*
   * BOTH THE NAME AND THE DESCRIPTION, and the heading asserted in the shape
   * the `project.url ? <a> : name` branch produces.
   *
   * Until fix round 2 this loop's failure message named `project.name` while
   * its only assertion read `project.description`, and nothing anywhere checked
   * the name at all. A project that lost its heading, or a broken link branch
   * that printed the URL where the title belongs, left every test in this file
   * green.
   */
  for (const project of projects) {
    const heading = project.url
      ? `<span class="org-name"><a href="${project.url}">${escapeHtml(project.name)}</a></span>`
      : `<span class="org-name">${escapeHtml(project.name)}</span>`;
    expect(
      html,
      `${project.name} should head its entry${project.url ? ', linked to its url' : ''}`,
    ).toContain(heading);
    expect(html, `${project.name}'s description should appear`).toContain(
      escapeHtml(project.description),
    );
  }
});

/**
 * The run-in rows, pinned join by join.
 *
 * NOT A RESTATEMENT of the presence assertions above. Those ask whether a skill
 * name and its keywords reached the page; this asks whether anything got
 * BETWEEN them, which is a different failure and one the presence checks pass
 * straight through.
 *
 * WHY IT MATTERS HERE AND NOWHERE ELSE ON THE SHEET. `.runin .sep` is
 * `display: none` in Skills, so nothing absorbs whitespace written between the
 * label and the keyword list: one newline in the template renders as a real
 * space, and a space in front of the keywords pushes every row off the 116pt
 * hanging column the `.runin` rules exist to hold. What removes it today is
 * Astro's `compressHTML`, a default astro.config.mjs never sets -- so the
 * layout of this row rests on a build-tool default rather than on anything in
 * this repository. src/pages/resume.print.astro records that in full; this is
 * the assertion that makes it fail loudly rather than shift quietly.
 *
 * Each row is asserted whole, so a stray space anywhere in the join fails.
 */
test('the run-in rows join their label to their value with no whitespace', async () => {
  const html = await sheet();

  for (const skill of resume.skills) {
    expect(html, `${skill.name}'s row should carry no whitespace in its joins`).toContain(
      `<span class="lead">${escapeHtml(skill.name)}</span><span class="sep"> · </span>${escapeHtml(
        skill.keywords.join(', '),
      )}`,
    );
  }
});

test('the revision line is read from the record rather than typed into the page', async () => {
  const html = await sheet();

  // The ruling this asserts: a hand-typed revision string on a résumé is wrong
  // the first time anything else changes, and wrong silently. `meta.version`
  // and `meta.lastModified` are schema-validated fields of the record, so they
  // move in the same commit as the content they describe.
  expect(html).toContain(`Rev ${resume.meta.version} · ${resume.meta.lastModified}`);
});
