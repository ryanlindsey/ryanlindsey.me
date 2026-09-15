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
 * The résumé record, cast to the schema's OUTPUT type. The cast is safe for
 * this one file rather than in general: every field `content.config.ts` gives
 * a `.default([])` is written out explicitly in the YAML, so nothing the
 * assertions below read is a default the raw parse would leave undefined.
 */
const resume = parse(
  readFileSync(new URL('../src/content/resume/ryan-lindsey.yaml', import.meta.url), 'utf8'),
) as Resume;

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
 * apostrophe in "Anthropic's" and a quoted campaign name, which reach the page
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

/** The sheet as served, commentless -- see tests/markup.ts on why. */
async function sheet(): Promise<string> {
  const response = await server.fetch(SHEET_PATH);
  expect(response.status, `${SHEET_PATH} should be 200`).toBe(200);
  return stripComments(await response.text());
}

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
  expect(basics.profiles.length, 'the record should carry at least one profile').toBeGreaterThan(0);

  expect(html, 'the sheet should carry the email').toContain(basics.email);
  expect(html, 'the sheet should carry the phone number').toContain(basics.phone);
  expect(html, 'the sheet should carry the site url').toContain(basics.url);

  // DERIVED FROM THE ARRAY, which is the whole point of this assertion: a
  // third network added to the record has to appear on the sheet without an
  // edit to the page or to this file.
  for (const profile of basics.profiles) {
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

test('every profile url is a link, not just printed text', async () => {
  const html = await sheet();
  for (const profile of resume.basics.profiles) {
    expect(html, `${profile.network} should be linked`).toContain(`href="${profile.url}"`);
  }
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

  // `RESUME_READY_SELECTOR` in src/lib/resume-pdf.ts is `[data-resume-ready]`,
  // and this is the second page to write it. Both strings are asserted in the
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
    ...resume.work.flatMap((entry) => entry.highlights),
    ...resume.projects.flatMap((project) => project.highlights),
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

  for (const project of resume.projects) {
    expect(html, `${project.name} should appear`).toContain(escapeHtml(project.description));
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
