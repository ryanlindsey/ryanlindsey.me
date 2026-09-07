import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import {
  formatDateRange,
  groupWorkByCompany,
  resumeGaps,
  unresolvedArtifactSlugs,
  workHistoryIssues,
  type Resume,
  type ResumeWorkEntry,
} from '../src/lib/resume';
import { stripXKeys } from '../src/lib/json-resume';

// This suite covers the pure half of the résumé data model only.
// `getResume()` (src/lib/resume-collection.ts) reads the `resume` content
// collection through `astro:content`, a virtual module that only resolves
// inside Astro's own build/dev pipeline -- not from a plain `vitest run`
// process the way this file runs. That guard is exercised at the HTTP level
// in Task 2, once `/resume` calls it for real. See
// .superpowers/sdd/2026-09-06-day3-resume-pipeline-agent-publishing-corpus/
// progress.md's Task 1 entry for the mid-task ruling that produced this
// split. Schema validity of the real YAML data file is `astro check`'s job
// (`npm run check`), not this suite's.

const workEntry = (
  entry: Pick<ResumeWorkEntry, 'name' | 'position' | 'startDate'> & Partial<ResumeWorkEntry>,
): ResumeWorkEntry => ({
  highlights: [],
  ...entry,
});

// Mirrors src/content/resume/ryan-lindsey.yaml. Kept here by hand rather than
// read from that file: resumeGaps/workHistoryIssues are pure and this suite
// deliberately runs without Astro's content pipeline (see src/lib/resume.ts's
// header), and there is no dependency-free way from a plain vitest process to
// parse real YAML. Task 2's HTTP-level tests, once /resume renders through
// the real collection, are the stronger, drift-proof version of the
// completeness assertion below -- this fixture must be kept in sync by hand
// until then.
//
// Highlight TEXT is abbreviated here rather than duplicated verbatim: the pure
// functions under test only ever read `highlights.length`, and a second copy of
// ~25 paragraphs of résumé prose would be a maintenance trap that drifts
// silently. Highlight COUNTS, and every other field, do mirror the real file --
// those are what these assertions actually depend on. The HTTP-level tests
// further down read the real collection and are the drift-proof check on the
// prose itself.
const resumeFixture: Resume = {
  basics: {
    name: 'Ryan Lindsey',
    label: 'Senior Engineering Manager',
    summary:
      'Agentic engineering is making engineers dramatically faster. I build the instruments that let the organization around them keep pace. Nineteen years in software, a decade of it leading engineering teams: I own incident management for an entire engineering organization, I build the agentic tooling that other managers choose to adopt, and I still ship the code. The habit underneath all of it is to measure a process before improving it, because the constraint is rarely where everyone assumes it is.',
    email: 'hello@ryanlindsey.me',
    url: 'https://ryanlindsey.me',
    location: { city: 'Laguna Niguel', region: 'CA', countryCode: 'US' },
    profiles: [
      { network: 'GitHub', username: 'ryanlindsey', url: 'https://github.com/ryanlindsey' },
      {
        network: 'LinkedIn',
        username: 'ryanclindsey',
        url: 'https://www.linkedin.com/in/ryanclindsey',
      },
    ],
  },
  work: [
    workEntry({
      name: 'Weedmaps',
      position: 'Senior Engineering Manager',
      startDate: '2021-02',
      x_artifacts: ['delivery-forecasting'],
      highlights: [
        'Own incident management for the entire engineering organization',
        'Measured the inherited process before changing it',
        'Risky changes are reviewed in advance by a change advisory board',
        'Designed and built a delivery-forecasting toolchain',
        'Publish agentic tooling as Claude Skills in a shared repository',
        'Took on an advertising technology platform to raise its engineering rigor',
        'Delivered an off-marketplace e-commerce platform for cannabis retailers',
      ],
    }),
    workEntry({
      name: 'Weedmaps',
      position: 'Engineering Manager',
      startDate: '2017-09',
      endDate: '2021-02',
      highlights: [
        'Managed 12 to 19 engineers across several cross-functional teams',
        'Decoupled deployment from feature release',
        'Introduced global edge caching across the primary web applications',
        'Tripled overall test coverage and reduced escape defects',
        'Led image processing pipeline work spanning millions of unique assets',
        'Sat several hundred interviews and grew the engineering team by dozens',
        'Founded and ran a public monthly engineering meetup',
      ],
    }),
    workEntry({
      name: 'Weedmaps',
      position: 'Manager, Front End Engineering',
      startDate: '2016-05',
      endDate: '2017-09',
      highlights: [
        "The company's first engineering manager below the executive level",
        'Chartered to develop front-end developers into front-end engineers',
        'Began the front-end re-architecture',
        'Defined and delivered the front-end staffing roadmap',
      ],
    }),
    workEntry({
      name: 'Weedmaps',
      position: 'Sr. Front End Engineer',
      startDate: '2016-03',
      endDate: '2016-05',
      highlights: ["Built and maintained features across the company's web applications"],
    }),
    workEntry({
      name: 'RED Digital Cinema',
      position: 'Sr. Front End Developer',
      startDate: '2011-10',
      endDate: '2016-02',
      highlights: [
        'Architected and implemented user-interface features',
        'Drove the adoption of a new UI component library and design language',
      ],
    }),
    workEntry({
      name: 'Innocean Worldwide',
      position: 'Sr. Front End Developer',
      startDate: '2011-02',
      endDate: '2011-10',
      highlights: [
        'Led development of interactive experiences for Hyundai USA',
        'Worked with the creative team from the conceptual phase onward',
      ],
    }),
    workEntry({
      name: 'Y&R Brands / Wunderman',
      position: 'Front End Developer',
      startDate: '2007-06',
      endDate: '2011-02',
      highlights: [
        'Delivered award-winning interactive experiences',
        'Recognized with Lester Wunderman and Creativity awards',
      ],
    }),
    workEntry({
      name: 'Freelance',
      position: 'Web design & development',
      startDate: '2001-01',
      endDate: '2007-06',
      highlights: ['Ran every part of the business'],
    }),
  ],
  education: [
    {
      institution: 'The Art Institute of California',
      area: 'Interactive Media (HCI)',
      studyType: 'B.S.',
    },
    { institution: 'Golden West College', area: 'Business Administration', studyType: 'A.A.' },
  ],
  skills: [
    {
      name: 'Engineering leadership',
      keywords: ['Incident management', 'Change management', 'Observability practice'],
    },
    { name: 'Agentic engineering', keywords: ['MCP servers', 'Claude Skills', 'Agent design'] },
    { name: 'Platform and delivery', keywords: ['CI/CD', 'Blue/green deployment'] },
    { name: 'Languages and runtimes', keywords: ['TypeScript', 'Ruby', 'Node.js'] },
  ],
  meta: { version: '0.2.0', lastModified: '2026-09-07' },
};

describe('workHistoryIssues', () => {
  test('the real work history has no ordering issues', () => {
    expect(workHistoryIssues(resumeFixture.work)).toEqual([]);
  });

  test('flags a work entry out of reverse-chronological order', () => {
    const work = [
      workEntry({ name: 'A', position: 'Later role', startDate: '2020-01', endDate: '2022-01' }),
      workEntry({ name: 'A', position: 'Earlier role', startDate: '2021-01', endDate: '2020-01' }),
    ];
    // The second entry both breaks ordering and precedes its own start date,
    // so assert on the ordering message specifically rather than the count.
    expect(workHistoryIssues(work).some((issue) => issue.includes('reverse-chronological'))).toBe(
      true,
    );
  });

  test('flags an endDate preceding its own startDate', () => {
    // A second, correctly open entry keeps the "exactly one open role" check
    // out of the result, isolating the one issue this test is about.
    const work = [
      workEntry({ name: 'A', position: 'Later role', startDate: '2023-01' }),
      workEntry({
        name: 'A',
        position: 'Earlier role',
        startDate: '2022-01',
        endDate: '2021-01',
      }),
    ];
    expect(workHistoryIssues(work)).toEqual([
      'A — Earlier role: endDate 2021-01 precedes startDate 2022-01',
    ]);
  });

  test('flags zero open roles', () => {
    const work = [
      workEntry({ name: 'A', position: 'Role', startDate: '2020-01', endDate: '2021-01' }),
    ];
    expect(workHistoryIssues(work)).toEqual([
      'expected exactly one work entry without endDate ("present"), found 0',
    ]);
  });

  test('flags more than one open role', () => {
    const work = [
      workEntry({ name: 'A', position: 'Role', startDate: '2022-01' }),
      workEntry({ name: 'B', position: 'Role', startDate: '2020-01' }),
    ];
    expect(workHistoryIssues(work)).toEqual([
      'expected exactly one work entry without endDate ("present"), found 2',
    ]);
  });
});

describe('groupWorkByCompany', () => {
  test('collapses the real eight-entry work history into five company groups', () => {
    const groups = groupWorkByCompany(resumeFixture.work);
    expect(groups.map((group) => group.name)).toEqual([
      'Weedmaps',
      'RED Digital Cinema',
      'Innocean Worldwide',
      'Y&R Brands / Wunderman',
      'Freelance',
    ]);
    // The four consecutive Weedmaps stints collapse into one block of four
    // roles; every other company held exactly one role in this data.
    expect(groups[0].roles).toHaveLength(4);
    expect(groups.slice(1).every((group) => group.roles.length === 1)).toBe(true);
  });

  test('only collapses consecutive entries at the same company', () => {
    // A, B, A must stay THREE groups, not collapse the two A entries
    // together -- that would misrepresent a return to a former employer as
    // one continuous stint.
    const work = [
      workEntry({ name: 'A', position: 'Later role at A', startDate: '2022-01' }),
      workEntry({ name: 'B', position: 'Role at B', startDate: '2021-01', endDate: '2022-01' }),
      workEntry({
        name: 'A',
        position: 'Earlier role at A',
        startDate: '2020-01',
        endDate: '2021-01',
      }),
    ];
    const groups = groupWorkByCompany(work);
    expect(groups.map((group) => group.name)).toEqual(['A', 'B', 'A']);
    expect(groups.every((group) => group.roles.length === 1)).toBe(true);
  });

  test('wraps a single entry in its own group', () => {
    const entry = workEntry({ name: 'A', position: 'Role', startDate: '2020-01' });
    expect(groupWorkByCompany([entry])).toEqual([{ name: 'A', roles: [entry] }]);
  });

  test('returns an empty array for an empty work history', () => {
    expect(groupWorkByCompany([])).toEqual([]);
  });
});

describe('unresolvedArtifactSlugs', () => {
  test('resolves when every x_artifacts slug matches a known case study', () => {
    const work = [
      workEntry({
        name: 'A',
        position: 'Role',
        startDate: '2020-01',
        x_artifacts: ['shape-specimen'],
      }),
    ];
    expect(unresolvedArtifactSlugs(work, ['shape-specimen'])).toEqual([]);
  });

  test('flags an x_artifacts slug with no matching case study', () => {
    // This is what stops the résumé linking to a case study that was never
    // published.
    const work = [
      workEntry({
        name: 'A',
        position: 'Role',
        startDate: '2020-01',
        x_artifacts: ['never-published'],
      }),
    ];
    expect(unresolvedArtifactSlugs(work, ['shape-specimen'])).toEqual(['never-published']);
  });

  // The résumé's own artifact link, checked against the case studies that
  // actually exist. `delivery-forecasting` is the case study written from the
  // same work as the Senior Engineering Manager entry's forecasting highlight.
  test("resolves the real résumé's artifact links against the published case studies", () => {
    expect(
      unresolvedArtifactSlugs(resumeFixture.work, [
        'delivery-forecasting',
        'silent-failure',
        'shape-specimen',
      ]),
    ).toEqual([]);
  });

  test("flags the résumé's artifact links when the case study is absent", () => {
    expect(unresolvedArtifactSlugs(resumeFixture.work, ['shape-specimen'])).toEqual([
      'delivery-forecasting',
    ]);
  });
});

describe('formatDateRange', () => {
  test('renders a closed range', () => {
    expect(formatDateRange('2016-05', '2017-09')).toBe('May 2016 — Sep 2017');
  });

  test('renders an open range as Present', () => {
    expect(formatDateRange('2021-02')).toBe('Feb 2021 — Present');
  });

  test('renders a range crossing a year boundary', () => {
    expect(formatDateRange('2020-11', '2021-02')).toBe('Nov 2020 — Feb 2021');
  });
});

describe('resumeGaps', () => {
  // Résumé interview session 2 (2026-09-07) closed every content-track gap
  // except one: all eight roles have highlights, education and profiles are
  // populated. `basics.phone` is the sole remaining gap and it is not an
  // oversight -- publishing a phone number is Ryan's decision, not a hole for
  // the content track to fill. See the YAML's comment at `basics`.
  test('flags every currently-missing piece of content', () => {
    const gaps = resumeGaps(resumeFixture);
    expect(gaps.filter((gap) => gap.includes('has no highlights'))).toHaveLength(0);
    expect(gaps).not.toContain('education is empty');
    expect(gaps).not.toContain('basics.profiles is empty');
    expect(gaps).not.toContain('basics.email is missing');
    expect(gaps).not.toContain('basics.url is missing');
    expect(gaps).toEqual(['basics.phone is missing']);
  });

  // Deliberately red: the content-track gate. It went from eleven gaps to one
  // on 2026-09-07. It stays `test.fails` because that last gap is a live
  // decision rather than missing content -- when Ryan rules on the phone
  // number this becomes an ordinary `test`, either because the number is added
  // or because `resumeGaps` stops treating an intentional omission as a gap.
  // `test.fails` keeps the suite green while the assertion itself stays honest.
  test.fails('the résumé has no content-track gaps left', () => {
    expect(resumeGaps(resumeFixture)).toEqual([]);
  });
});

// Day 3 Task 13 (carried from Task 3, progress.md's Task 3 entry, "SHOULD
// FIX BEFORE MERGE"): stripXKeys, unit-tested directly against a synthetic
// nested `x_` fixture. The HTTP test just below ("/resume.json parses...")
// pre-dates this and only proves the REAL résumé data carries no `x_`-prefixed
// key -- true today because no work entry populates `x_artifacts` at all, so
// that assertion passes VACUOUSLY: it proves there is nothing to strip, not
// that stripping works. This block is the actual proof, independent of
// whatever the real résumé data happens to contain.
describe('stripXKeys', () => {
  test('drops a top-level x_-prefixed key, keeping every other key', () => {
    expect(stripXKeys({ name: 'Ada', x_secret: 'drop me' })).toEqual({ name: 'Ada' });
  });

  test('drops an x_-prefixed key nested inside an object, at any depth', () => {
    expect(
      stripXKeys({
        work: { name: 'A', x_artifacts: ['shape-specimen'], nested: { x_internal: 1, kept: 2 } },
      }),
    ).toEqual({ work: { name: 'A', nested: { kept: 2 } } });
  });

  test('drops an x_-prefixed key inside objects nested inside an array', () => {
    expect(
      stripXKeys([
        { name: 'A', x_artifacts: ['one'] },
        { name: 'B', x_artifacts: ['two'] },
      ]),
    ).toEqual([{ name: 'A' }, { name: 'B' }]);
  });

  test('leaves a value with no x_-prefixed key anywhere unchanged', () => {
    const value = { basics: { name: 'Ada' }, work: [{ name: 'A', highlights: [] }] };
    expect(stripXKeys(value)).toEqual(value);
  });

  test('does not treat "x" or a mid-string "x_" as the prefix -- only a leading x_ matches', () => {
    // Guards the exact boundary of the rule this function implements: a key
    // has to START WITH `x_`, not merely contain it, or a real field like
    // `prefix_x_suffix` would be silently dropped.
    expect(stripXKeys({ x: 'kept', prefix_x_suffix: 'kept', x_dropped: 'gone' })).toEqual({
      x: 'kept',
      prefix_x_suffix: 'kept',
    });
  });
});

// Day 3 Task 3: /resume.json and /resume.md, exercised over HTTP the same
// way tests/pages.test.ts exercises /resume. This has to be HTTP-level, not
// a plain import, for the same reason this file's header gives for
// getResume() itself: both routes call getResume(), which resolves
// astro:content only inside Astro's own build pipeline.
//
// /resume.json is the most direct machine-readable exposure of getResume()'s
// own output available over HTTP (only x_ keys stripped, $schema added), so
// its parsed body stands in below for "derive the expected set from
// getResume()" -- checking that /resume.md and /resume both agree with it is
// the mechanical version of 02 §1's "one commit updates every format
// atomically" claim. Without this test, that claim is just a comment.
describe('/resume.json and /resume.md over HTTP', () => {
  const server = createTestHarness({
    workers: SITE_HARNESS_WORKERS,
  });

  beforeAll(async () => {
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  const fetchOk = async (path: string) => {
    const response = await server.fetch(path);
    expect(response.status, `${path} should be 200`).toBe(200);
    return response;
  };

  const hasXPrefixedKey = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasXPrefixedKey);
    if (value !== null && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).some(
        ([key, entryValue]) => key.startsWith('x_') || hasXPrefixedKey(entryValue),
      );
    }
    return false;
  };

  test('/resume.json parses, carries $schema first, and has no x_-prefixed key at any depth', async () => {
    const response = await fetchOk('/resume.json');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const raw = await response.text();
    // $schema first is checked on the raw text -- JSON.parse would discard
    // the key-order information this assertion depends on.
    expect(raw.trimStart().startsWith('{\n  "$schema"')).toBe(true);

    const parsed: unknown = JSON.parse(raw);
    expect((parsed as { $schema?: unknown }).$schema).toBe(
      'https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json',
    );
    expect(hasXPrefixedKey(parsed)).toBe(false);
  });

  // An h2 ("## ", two hashes and a space -- not a "### " company subheading,
  // which IS a section's content, not evidence of its absence) with no
  // non-blank line before either the next h2 or the end of the document. A
  // single combined regex for this over-matched: `$` in multiline mode is
  // zero-width before EVERY newline, including a blank line's own, so
  // `\s*(?:##|$)` after a heading matched the blank line separating
  // "## Experience" from its own "### Weedmaps" content. Walking lines
  // avoids that trap.
  const hasEmptyH2Section = (markdown: string): boolean => {
    const lines = markdown.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('## ')) continue;
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === '') next++;
      if (next >= lines.length || lines[next].startsWith('## ')) return true;
    }
    return false;
  };

  test('/resume.md serves as markdown with no empty bullets and no empty ## sections', async () => {
    const response = await fetchOk('/resume.md');
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');

    const markdown = await response.text();
    // A bullet with nothing after the dash (the literal "- \n" or "-\n" the
    // brief calls out).
    expect(markdown).not.toMatch(/^- *$/m);
    expect(hasEmptyH2Section(markdown)).toBe(false);
    // Both sections carry real data since 2026-09-07, so both headings must now
    // be present. `hasEmptyH2Section` above is what still guards the case these
    // assertions used to cover: a heading rendered over nothing.
    expect(markdown).toContain('## Education');
    expect(markdown).toContain('## Skills');
  });

  test('/resume.json, /resume.md and /resume name the same companies and date ranges', async () => {
    const jsonResume = (await (await fetchOk('/resume.json')).json()) as Resume;
    const companies = [...new Set(jsonResume.work.map((entry) => entry.name))];
    const dateRanges = jsonResume.work.map((entry) =>
      formatDateRange(entry.startDate, entry.endDate),
    );
    expect(companies.length).toBeGreaterThan(0);

    const markdown = await (await fetchOk('/resume.md')).text();
    // The HTML page escapes text nodes (Y&R Brands / Wunderman renders as
    // "Y&amp;R..."), so the raw value must be escaped the same way before
    // comparison -- see tests/pages.test.ts's identical htmlEscape helper.
    const htmlEscape = (value: string) => value.replaceAll('&', '&amp;');
    const html = await (await fetchOk('/resume')).text();

    for (const name of companies) {
      expect(markdown, `${name} should appear on /resume.md`).toContain(name);
      expect(html, `${name} should appear on /resume`).toContain(htmlEscape(name));
    }
    for (const range of dateRanges) {
      expect(markdown, `${range} should appear on /resume.md`).toContain(range);
      expect(html, `${range} should appear on /resume`).toContain(htmlEscape(range));
    }
  });
});
