import { describe, expect, test } from 'vitest';
import {
  formatDateRange,
  resumeGaps,
  unresolvedArtifactSlugs,
  workHistoryIssues,
  type Resume,
  type ResumeWorkEntry,
} from '../src/lib/resume';

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
const resumeFixture: Resume = {
  basics: {
    name: 'Ryan Lindsey',
    label: 'Senior Engineering Manager',
    summary:
      'Agentic engineering is making engineers dramatically faster. I build the instruments that let the organization around them keep pace.',
    email: 'hello@ryanlindsey.me',
    url: 'https://ryanlindsey.me',
    location: { city: 'Laguna Niguel', region: 'CA', countryCode: 'US' },
    profiles: [],
  },
  work: [
    workEntry({ name: 'Weedmaps', position: 'Senior Engineering Manager', startDate: '2021-02' }),
    workEntry({
      name: 'Weedmaps',
      position: 'Engineering Manager',
      startDate: '2017-09',
      endDate: '2021-02',
    }),
    workEntry({
      name: 'Weedmaps',
      position: 'Manager, Front End Engineering',
      startDate: '2016-05',
      endDate: '2017-09',
    }),
    workEntry({
      name: 'Weedmaps',
      position: 'Sr. Front End Engineer',
      startDate: '2016-03',
      endDate: '2016-05',
    }),
    workEntry({
      name: 'RED Digital Cinema',
      position: 'Sr. Front End Developer',
      startDate: '2011-10',
      endDate: '2016-02',
    }),
    workEntry({
      name: 'Innocean Worldwide',
      position: 'Sr. Front End Developer',
      startDate: '2011-02',
      endDate: '2011-10',
    }),
    workEntry({
      name: 'Y&R Brands / Wunderman',
      position: 'Front End Developer',
      startDate: '2007-06',
      endDate: '2011-02',
    }),
    workEntry({
      name: 'Freelance',
      position: 'Web design & development',
      startDate: '2001-01',
      endDate: '2007-06',
    }),
  ],
  education: [],
  skills: [],
  meta: { version: '0.1.0', lastModified: '2026-09-06' },
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

  test('resolves when no entry declares x_artifacts', () => {
    expect(unresolvedArtifactSlugs(resumeFixture.work, ['shape-specimen'])).toEqual([]);
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
  test('flags every currently-missing piece of content', () => {
    const gaps = resumeGaps(resumeFixture);
    expect(gaps.filter((gap) => gap.includes('has no highlights'))).toHaveLength(8);
    expect(gaps).toContain('education is empty');
    expect(gaps).toContain('basics.phone is missing');
    expect(gaps).toContain('basics.profiles is empty');
    expect(gaps).not.toContain('basics.email is missing');
    expect(gaps).not.toContain('basics.url is missing');
    // 8 empty-highlight roles + education + phone + profiles.
    expect(gaps).toHaveLength(11);
  });

  // Deliberately red: the content-track gate. This fails today with the
  // eight empty-highlight roles, the empty education section, and the
  // missing phone/profiles fields, and it goes green when the content track
  // fills them in. `test.fails` keeps the suite green while the assertion
  // itself stays honest -- an ordinary failing test would block every later
  // task's `npx vitest run` verification step, and a skipped test would stop
  // reporting the gap at all.
  test.fails('the résumé has no content-track gaps left', () => {
    expect(resumeGaps(resumeFixture)).toEqual([]);
  });
});
