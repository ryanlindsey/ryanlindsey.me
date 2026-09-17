import type { z } from 'astro/zod';
// Type-only: `content.config.ts` itself imports `astro:content` (for
// `defineCollection`), which only resolves inside Astro's own pipeline. A
// value import here would pull that in transitively and break this module
// under plain `vitest run`; `import type` is erased before that happens.
import type { resumeSchema } from '../content.config';

// Pure half of the résumé data model (day 3, 02 §1). `astro:content` is a
// virtual module that only resolves inside Astro's own build/dev pipeline --
// not from a plain `vitest run` process -- so everything in this file takes
// data as arguments instead of reading the collection itself, and imports
// nothing Astro-flavoured beyond the `z` type. That is what makes it directly
// unit-testable the way `series.ts` and `toc.ts` are (tests/resume.test.ts).
//
// The collection read lives separately, in `src/lib/resume-collection.ts`.
// This split was not in the original plan; see
// .superpowers/sdd/2026-09-06-day3-resume-pipeline-agent-publishing-corpus/
// progress.md's Task 1 entry for the mid-task ruling.

/**
 * The résumé's data shape, inferred from the Zod schema in
 * `content.config.ts` rather than hand-written here -- a hand-written
 * duplicate would be a second source of truth for the same shape.
 */
export type Resume = z.infer<typeof resumeSchema>;
export type ResumeWorkEntry = Resume['work'][number];

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function formatYearMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  // A bare `YYYY` renders as the year alone. Education dates are allowed to be
  // year-only (see `yearOrYearMonth` in content.config.ts); without this branch
  // the missing month would index past MONTH_NAMES and render "undefined 2003".
  if (month === undefined) return year;
  return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

/**
 * One date-range renderer shared by the HTML, Markdown and PDF formats so
 * the three cannot drift. `endDate` absent means "present". Dates are
 * YYYY-MM strings (never `Date`), so this needs no timezone-sensitive
 * parsing -- splitting on "-" and indexing into a month-name table is exact.
 */
export function formatDateRange(startDate: string, endDate?: string): string {
  const end = endDate ? formatYearMonth(endDate) : 'Present';
  return `${formatYearMonth(startDate)} — ${end}`;
}

/**
 * Human-readable list of what the résumé is missing: a work entry with no
 * highlights, an empty education section, and any absent top-level contact
 * field. This is the content-track gate that tests/resume.test.ts asserts is
 * empty (deliberately red until the content track fills these in), and the
 * function `/resume` (Task 2) uses to decide whether to render its dev-only
 * gap notice.
 */
export function resumeGaps(resume: Resume): string[] {
  const gaps: string[] = [];

  for (const entry of resume.work) {
    if (entry.highlights.length === 0) {
      gaps.push(`${entry.name} — ${entry.position} (${entry.startDate}) has no highlights`);
    }
  }

  if (resume.education.length === 0) {
    gaps.push('education is empty');
  }

  if (!resume.basics.email) gaps.push('basics.email is missing');
  if (!resume.basics.phone) gaps.push('basics.phone is missing');
  if (!resume.basics.url) gaps.push('basics.url is missing');
  if (resume.basics.profiles.length === 0) gaps.push('basics.profiles is empty');

  return gaps;
}

/**
 * Work-history invariants the Zod schema cannot express by itself (they
 * compare one entry to another): reverse-chronological order by
 * `startDate`, no `endDate` preceding its own `startDate`, and exactly one
 * entry without an `endDate` ("present"). Returns one human-readable
 * violation per problem found; `[]` means the work history is internally
 * consistent.
 *
 * YYYY-MM strings compare correctly with plain string comparison (zero-
 * padded, most-significant part first), so this needs no date parsing and
 * none of the timezone risk `z.coerce.date()` would add.
 */
export function workHistoryIssues(work: readonly ResumeWorkEntry[]): string[] {
  const issues: string[] = [];

  for (let i = 1; i < work.length; i++) {
    if (work[i].startDate > work[i - 1].startDate) {
      issues.push(
        `${work[i].name} — ${work[i].position} (${work[i].startDate}) is out of reverse-chronological order`,
      );
    }
  }

  for (const entry of work) {
    if (entry.endDate && entry.endDate < entry.startDate) {
      issues.push(
        `${entry.name} — ${entry.position}: endDate ${entry.endDate} precedes startDate ${entry.startDate}`,
      );
    }
  }

  const openRoles = work.filter((entry) => !entry.endDate);
  if (openRoles.length !== 1) {
    issues.push(
      `expected exactly one work entry without endDate ("present"), found ${openRoles.length}`,
    );
  }

  return issues;
}

/**
 * One block per company, carrying every role held there. Consecutive `work`
 * entries sharing a `name` collapse into one block -- four separate
 * Weedmaps rows would read as four jobs at four companies; one Weedmaps
 * block with four titles reads as the decade of promotions that actually
 * happened. Grouping is consecutive-only: two stints at the same company
 * split by another employer stay two separate blocks, which is the correct
 * shape for a résumé.
 *
 * Extracted here (day 3 Task 3) from where it used to live inline in
 * `src/pages/resume.astro` so `/resume` and `/resume.md` share one grouping
 * implementation instead of two that agree today and can silently drift --
 * the same lesson day 2's inline `SeriesNav` bug already taught this repo
 * once (see `src/lib/series.ts`).
 */
export interface WorkGroup {
  name: string;
  location?: string;
  /**
   * The tenure across the whole group, in the same YYYY-MM shape a role
   * carries, so `formatDateRange` renders it and no second formatter exists.
   * `endDate` absent means "present", exactly as it does on a role.
   *
   * Here rather than in the template (2026-09 redesign, design 1k) because
   * the span is the number that goes beside the company name, and a company
   * with four titles has a tenure no single role carries: Weedmaps runs from
   * Mar 2016, and its newest role starts in Feb 2021. Computed once, beside
   * the grouping it belongs to, for the same reason the grouping itself moved
   * out of `src/pages/resume.astro` -- so every format that renders it agrees
   * by construction instead of by agreement.
   */
  startDate: string;
  endDate?: string;
  roles: ResumeWorkEntry[];
}

/**
 * The span across every role in one group. YYYY-MM strings compare correctly
 * with plain string comparison, so this needs no date parsing.
 *
 * Read off the dates rather than off the array's ends on purpose.
 * `groupWorkByCompany` does not sort, and reverse-chronological order is
 * `workHistoryIssues`' business -- it reports a violation rather than
 * repairing it. Taking the span from `roles[0]` and `roles.at(-1)` would agree
 * with this on every well-ordered input and be silently wrong on the one input
 * already known to be broken.
 */
function tenureOf(roles: readonly ResumeWorkEntry[]): Pick<WorkGroup, 'startDate' | 'endDate'> {
  let startDate = roles[0].startDate;
  let endDate = roles[0].endDate;

  for (const role of roles.slice(1)) {
    if (role.startDate < startDate) startDate = role.startDate;

    // One open role leaves the whole tenure open: somebody still at the
    // company has not left it, whatever the rows for their earlier titles say.
    if (endDate === undefined) continue;
    if (role.endDate === undefined) endDate = undefined;
    else if (role.endDate > endDate) endDate = role.endDate;
  }

  return { startDate, endDate };
}

export function groupWorkByCompany(work: readonly ResumeWorkEntry[]): WorkGroup[] {
  const groups: WorkGroup[] = [];
  for (const entry of work) {
    const current = groups[groups.length - 1];
    if (current && current.name === entry.name) {
      current.roles.push(entry);
    } else {
      groups.push({
        name: entry.name,
        location: entry.location,
        startDate: entry.startDate,
        endDate: entry.endDate,
        roles: [entry],
      });
    }
  }

  // Second pass, after every group is closed: a group's tenure is a fact about
  // all of its roles, and the first pass only ever has some of them.
  for (const group of groups) {
    const { startDate, endDate } = tenureOf(group.roles);
    group.startDate = startDate;
    group.endDate = endDate;
  }

  return groups;
}

/**
 * Anything that may declare `x_artifacts`: a `work` entry or a `projects`
 * entry. Structural rather than a union of the two concrete types, so this
 * guard keeps working if a third section ever declares artifact links.
 */
export type ArtifactBearing = { x_artifacts?: readonly string[] };

/**
 * `x_artifacts` slugs that do not match any of the given case-study slugs --
 * this is what stops the résumé linking to a case study that was never
 * published. `[]` means every artifact link resolves. The caller supplies
 * the known slugs (e.g. read from the `caseStudies` collection, or off disk
 * the way tests/case-studies.test.ts does) rather than this module reading
 * them itself, so it stays free of any `astro:content` import.
 *
 * Callers pass every artifact-bearing section, e.g.
 * `[...resume.work, ...resume.projects]` -- checking only `work` would let a
 * project link to a case study that was never published.
 */
export function unresolvedArtifactSlugs(
  entries: readonly ArtifactBearing[],
  knownCaseStudySlugs: readonly string[],
): string[] {
  const known = new Set(knownCaseStudySlugs);
  const unresolved = new Set<string>();
  for (const entry of entries) {
    for (const slug of entry.x_artifacts ?? []) {
      if (!known.has(slug)) unresolved.add(slug);
    }
  }
  return [...unresolved];
}

/**
 * One rendered case-study link per resolvable `x_artifacts` slug.
 *
 * The caller supplies the titles for the same reason `unresolvedArtifactSlugs`
 * takes its known slugs: this module stays free of any `astro:content` import,
 * so a plain `vitest run` can exercise it without Astro's pipeline.
 *
 * A slug with no title is OMITTED rather than rendered with a placeholder.
 * `unresolvedArtifactSlugs()` is what fails the build for an unpublished slug,
 * and a "Case study: undefined" line here would be a second, worse error that
 * ships instead of failing.
 */
export interface ArtifactLink {
  slug: string;
  title: string;
  href: string;
}

export function artifactLinks(
  entry: ArtifactBearing,
  titlesBySlug: ReadonlyMap<string, string>,
): ArtifactLink[] {
  const links: ArtifactLink[] = [];
  for (const slug of entry.x_artifacts ?? []) {
    const title = titlesBySlug.get(slug);
    if (title) links.push({ slug, title, href: `/work/${slug}` });
  }
  return links;
}
