import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { CASE_STUDY_SECTIONS, factsFor, statusClass } from '../src/lib/case-study-shape';

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

const html = async (path: string) => {
  const response = await server.fetch(path);
  expect(response.status, `${path} should be 200`).toBe(200);
  return response.text();
};

// Read off disk rather than hardcoding a list, so a case study added tomorrow is
// covered by the shape assertion without anyone remembering to edit this file.
// That is the whole value of the ratchet: it has to apply to content that does
// not exist yet.
const slugs = readdirSync('src/content/caseStudies')
  .filter((file) => file.endsWith('.mdx'))
  .map((file) => file.replace(/\.mdx$/, ''));

// Draft state read the same way for the same reason: the index test below
// needs to know which slugs the aggregation surface is supposed to carry, and
// hardcoding "everything except shape-specimen" would go quietly wrong the day
// a second specimen or an unfinished case study lands. Same frontmatter-only
// regex tests/pages.test.ts uses, so `draft:` in prose cannot be mistaken for
// the field.
const isDraft = (slug: string) => {
  const source = readFileSync(`src/content/caseStudies/${slug}.mdx`, 'utf8');
  const end = source.indexOf('\n---', 3);
  return /\ndraft:\s*true\b/.test(end === -1 ? source : source.slice(0, end));
};

const publishedSlugs = slugs.filter((slug) => !isDraft(slug));
const draftSlugs = slugs.filter(isDraft);

// Markdown turns a straight apostrophe into a typographic one, so "What I'd do
// differently" does not match its own source text after rendering.
const straighten = (text: string) => text.replace(/[‘’]/g, "'");

const sectionHeadings = (page: string) =>
  [...page.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)]
    // The heading-anchor plugin puts an empty <a> inside every heading, so the
    // tags have to come out before the text is comparable.
    .map((match) => straighten(match[1].replace(/<[^>]*>/g, '')).trim())
    .filter(Boolean);

test('there is at least one case study to check', () => {
  // A suite that silently checks nothing reports that nobody minds it having
  // asked nothing. If this collection is ever emptied, that is a finding rather
  // than a reason for the shape assertions below to pass vacuously.
  expect(slugs.length, 'src/content/caseStudies has no .mdx entries').toBeGreaterThan(0);
});

test.each(slugs)('/work/%s carries the 02 §4 shape, in order', async (slug) => {
  const page = await html(`/work/${slug}`);
  // Exact equality, not a subset. 02 §4 calls the shape fixed, so an extra
  // top-level section is a shape change and should have to be argued for in a
  // diff to src/lib/case-study-shape.ts. Subsections are <h3> and are free.
  expect(sectionHeadings(page)).toEqual([...CASE_STUDY_SECTIONS]);
});

test('renders a case study through the article template', async () => {
  // Pinned to the specimen rather than slugs[0]: this asserts the template's
  // furniture, not any particular case study, and an index into a list that the
  // guard above may have just found empty reports itself as "/work/undefined".
  const page = await html('/work/shape-specimen');
  expect(page).toContain('data-testid="reading-time"');
  expect(page).toMatch(/\d+ min read/);
  expect(page).toMatch(/<nav[^>]*aria-label="Table of contents"/);
  // Case studies are not posts and have no series, so the pillar label must not
  // leak into their meta line and the series nav must not render.
  expect(page).toContain('data-testid="article-kicker"');
  expect(page).toMatch(/data-testid="article-kicker"[^>]*>Case study</);
  expect(page).not.toContain('data-series-nav');
});

test('renders code blocks in a case study with Expressive Code frames', async () => {
  // The Mechanism section is where excerpts live, so the integration has to
  // work on this route and not only on /writing.
  const page = await html('/work/shape-specimen');
  expect(page).toContain('class="expressive-code');
  expect(page).toContain('data-language="ts"');
  expect(page).toContain('data-code=');
});

test('lists every published case study in the index and keeps drafts out of it', async () => {
  // Both halves, deliberately. Until the first case studies shipped this test
  // asserted only the exclusion plus `data-testid="work-empty"`, which an
  // index that had silently stopped listing anything would also have passed.
  // The inclusion half is what stops that, and the guards below are what stop
  // either half from going vacuous if the collection's makeup changes.
  expect(publishedSlugs.length, 'expected at least one published case study').toBeGreaterThan(0);
  expect(draftSlugs.length, 'expected at least one draft case study').toBeGreaterThan(0);

  const index = await html('/work');
  for (const slug of publishedSlugs) {
    expect(index, `/work should link /work/${slug}`).toContain(`/work/${slug}`);
  }
  for (const slug of draftSlugs) {
    expect(index, `/work must not link the draft /work/${slug}`).not.toContain(`/work/${slug}`);
  }
  // The empty state is the other side of the same branch in
  // src/pages/work/index.astro, so it must be gone now that entries exist.
  expect(index).not.toContain('data-testid="work-empty"');
});

test('the specimen declares a figure block, and being a draft still keeps it off the index', async () => {
  // Issue #106 puts the figure set on the specimen rather than on either real
  // case study, because inventing numbers for real work is not a template
  // change. That makes the specimen the only entry in the tree exercising the
  // frontmatter shape, so this asserts it is actually there -- a fixture that
  // silently lost the block it exists to carry would otherwise take the
  // schema's only real-file coverage with it.
  //
  // The second half is the draft rule holding at the same time: declaring
  // figures does not buy an entry a row. Both halves together are what says
  // the rendered block is dormant BY THE DRAFT RULE rather than by a bug in
  // the index, which is the distinction tests/pages.test.ts's figure test
  // depends on being true.
  const source = readFileSync('src/content/caseStudies/shape-specimen.mdx', 'utf8');
  const frontmatter = source.slice(0, source.indexOf('\n---', 3));
  expect(frontmatter, 'the specimen should declare a figures block').toMatch(/\nfigures:\s*$/m);
  expect(draftSlugs).toContain('shape-specimen');

  const index = await html('/work');
  expect(index).not.toContain('/work/shape-specimen');
});

test('serves a draft case study by URL even though the index omits it', async () => {
  // The detail tier of the draft rule (tests/pages.test.ts's own framing):
  // aggregation surfaces filter on `!data.draft`, detail routes do not.
  for (const slug of draftSlugs) {
    expect((await server.fetch(`/work/${slug}`)).status, `/work/${slug} should be 200`).toBe(200);
  }
});

test('links Work from the primary navigation and marks it current', async () => {
  const index = await html('/work');
  expect(index).toMatch(/<a[^>]+href="\/work"[^>]*aria-current="page"/);
  // And the link exists from elsewhere, without the current marker.
  const home = await html('/');
  expect(home).toMatch(/<a[^>]+href="\/work"/);
  expect(home).not.toMatch(/<a[^>]+href="\/work"[^>]*aria-current/);
});

// --- 1j: the inverted masthead and the facts bar (issue #107, epic #96) ---

// Read off disk for the same reason `isDraft` above is: which case study
// declares facts is a property of the corpus, not of this file, and the
// figures ratchet in tests/pages.test.ts already learned that naming slugs
// here turns a content decision into a failing test. Only the four flat
// scalars content.config.ts declares count, and only inside the frontmatter --
// the same frontmatter-only slice `isDraft` takes, so the word `status:` in
// prose cannot be mistaken for the field.
const declaresFacts = (slug: string) => {
  const source = readFileSync(`src/content/caseStudies/${slug}.mdx`, 'utf8');
  const end = source.indexOf('\n---', 3);
  return /\n(?:role|stack|model|status):\s*\S/.test(end === -1 ? source : source.slice(0, end));
};

test('a case study masthead is inverted and an article masthead is not', async () => {
  // Both halves. The variant decides the masthead and nothing else, so the
  // assertion that /writing did NOT change is the half that catches the
  // branch applied to the wrong collection -- ArticleLayout serves both, and
  // its header records that typing it to one is what blocked /work.
  const study = await html('/work/silent-failure');
  expect(study).toContain('data-masthead="case-study"');
  const article = await html('/writing/agent-native-site');
  expect(article).toContain('data-masthead="article"');
});

test.each(slugs)('/work/%s renders a facts bar exactly when it declares facts', async (slug) => {
  const page = await html(`/work/${slug}`);
  // A <dl>, so this slice is the WHOLE bar rather than its first cell. The
  // issue's draft of this test matched to the first `</div>`, which closes
  // cell one: the label/value counts below would then have compared 1 to 1
  // and gone green on a bar whose other three cells were blank -- the exact
  // failure the counts exist to catch, wearing the costume of a passing test.
  const bar = /data-facts-bar[\s\S]*?<\/dl>/.exec(page);

  if (!declaresFacts(slug)) {
    // Absent cells are omitted, not blanked, and an entry declaring none
    // renders no bar at all. /ops has lived by that rule since launch and the
    // figures contract states it outright: never render an empty cell. Four
    // labels over four blanks is the same failure in a different costume.
    expect(bar, `${slug} declares no facts and should render no bar`).toBeNull();
    return;
  }

  expect(bar, `${slug} declares facts and should render a bar`).not.toBeNull();
  expect(bar![0]).not.toMatch(/>\s*<\/dt>/);
  expect(bar![0]).not.toMatch(/>\s*<\/dd>/);
  const labels = [...bar![0].matchAll(/data-fact-label/g)].length;
  const values = [...bar![0].matchAll(/data-fact-value/g)].length;
  expect(labels, `${slug} should render no labelled blank`).toBe(values);
  expect(labels).toBeGreaterThan(0);
});

test('the specimen declares all four facts, so the full bar has a page behind it', async () => {
  // The presence arm above goes vacuous the day nothing on disk declares
  // facts, and the specimen is what stops it -- the same job it already does
  // for the `figures` block and the six sections. Asserted against the
  // rendered page rather than the file, because a schema field that never
  // reaches the markup is the failure worth catching.
  expect(declaresFacts('shape-specimen')).toBe(true);
  const bar = /data-facts-bar[\s\S]*?<\/dl>/.exec(await html('/work/shape-specimen'));
  expect(bar).not.toBeNull();
  expect([...bar![0].matchAll(/data-fact-label/g)].length).toBe(4);
  for (const label of ['Role', 'Stack', 'Model', 'Status']) {
    expect(bar![0], `the bar should carry a ${label} cell`).toContain(label);
  }
});

test('the case study keeps the spine the article issue built', async () => {
  // The variant changes the masthead. The three-column spine, the contents
  // rail and the meta rail are #104's and have to survive untouched.
  const page = await html('/work/silent-failure');
  expect(page).toContain('data-article-toc');
  expect(page).toContain('data-article-meta-rail');
  expect(page).toContain('data-reading-progress');
});

test('a live status is green and anything else is not', () => {
  // The one place this page uses the status ramp, and the one way to keep
  // --rl-ok meaning something: colouring every status green makes the token
  // decorative.
  expect(statusClass('Live')).toContain('text-ok');
  expect(statusClass('live')).toContain('text-ok');
  expect(statusClass('  Live  ')).toContain('text-ok');
  expect(statusClass('Archived')).not.toContain('text-ok');
  expect(statusClass(undefined)).not.toContain('text-ok');
  // EQUALITY, NOT CONTAINMENT, and this is the case that decides it:
  // "Delivered" contains "live". A substring match would paint a finished,
  // handed-off project with the live ramp, and nobody would catch it until a
  // reader believed a dead thing was still running.
  expect(statusClass('Delivered')).not.toContain('text-ok');
});

test('the facts bar omits what an entry does not declare, in a fixed order', () => {
  // The omission rule tested where every permutation is reachable. The
  // rendered-page arms above can only ever cover what the corpus happens to
  // declare, which is the lesson `figureCellsFor(undefined)` already records
  // in tests/case-study-figures.test.ts.
  expect(factsFor({})).toEqual([]);
  expect(factsFor({ stack: 'Workers, D1' }).map((fact) => fact.label)).toEqual(['Stack']);
  expect(
    factsFor({ role: 'Solo engineer', model: 'Claude', status: 'Live' }).map((fact) => fact.label),
  ).toEqual(['Role', 'Model', 'Status']);
  // Declaration order in the frontmatter cannot reorder the bar: the design
  // fixes it at Role / Stack / Model / Status.
  expect(
    factsFor({ status: 'Live', model: 'Claude', stack: 'Workers', role: 'Solo engineer' }).map(
      (fact) => fact.label,
    ),
  ).toEqual(['Role', 'Stack', 'Model', 'Status']);
});

test('a declared-but-empty fact is omitted rather than rendered as a labelled blank', () => {
  // The one shape "absent cells are omitted" fails as, and the place this
  // layer disagrees with the exporter ON PURPOSE. `role: ""` is a
  // declaration, so `!== undefined` keeps it in the EXPORT -- dropping it
  // there is the documented fix round in src/lib/markdown-export.ts. The bar
  // is a different question: a label over nothing is exactly the blank the
  // rule forbids, so it is the cell that goes, not the declaration.
  expect(factsFor({ role: '', stack: 'Workers' }).map((fact) => fact.label)).toEqual(['Stack']);
  expect(factsFor({ status: '   ' })).toEqual([]);
});

test('only the status cell carries a value class', () => {
  // Which is what keeps ArticleLayout from matching on a label string to
  // decide a colour.
  const facts = factsFor({ role: 'Solo engineer', status: 'Live' });
  expect(facts.find((fact) => fact.label === 'Role')?.valueClass).toBeUndefined();
  expect(facts.find((fact) => fact.label === 'Status')?.valueClass).toContain('text-ok');
});
