import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { getResume } from '../lib/resume-collection';
import {
  artifactLinks,
  formatDateRange,
  groupWorkByCompany,
  type ArtifactLink,
  type Resume,
  type ResumeWorkEntry,
} from '../lib/resume';

// Day 3 Task 3 (02 §1): the clean-markdown format -- the one most likely to
// be fed straight into a model's context, so "no empty scaffolding" matters
// more here than anywhere else. Static output: pure function of the same
// committed résumé data /resume and /resume.json read, so it prerenders like
// every other page (Task 5 owns the first on-demand route, not this one).
//
// Astro's static build writes only the Response BODY to disk
// (dist/client/resume.md); the header set below does not survive into the
// deployed artifact, but Cloudflare's asset server already maps `.md` to
// `text/markdown; charset=utf-8` by default, so no public/_headers override
// is needed here the way /resume.json needed one.
export const prerender = true;

/**
 * Escapes the two characters that can corrupt this document if a future
 * highlight or title happens to contain them: a literal `|` (would look
 * like a table cell) and a leading `#` (would look like a heading). Neither
 * appears in the résumé data today -- see content.config.ts and
 * src/content/resume/ryan-lindsey.yaml -- so this function is currently a
 * no-op on every real field; it exists so that stops being true silently.
 */
function escapeMarkdown(text: string): string {
  const pipesEscaped = text.replaceAll('|', '\\|');
  return pipesEscaped.startsWith('#') ? `\\${pipesEscaped}` : pipesEscaped;
}

function renderRole(role: ResumeWorkEntry, links: readonly ArtifactLink[]): string {
  const title = `**${escapeMarkdown(role.position)}** · ${formatDateRange(role.startDate, role.endDate)}`;
  // "A role with no highlights contributes its title line and stops" -- and
  // now the same for a role with no summary. Built as parts rather than by
  // early return, because a role may carry either, both or neither.
  const parts = [title];
  if (role.summary) parts.push(escapeMarkdown(role.summary));
  if (role.highlights.length > 0) {
    parts.push(role.highlights.map((highlight) => `- ${escapeMarkdown(highlight)}`).join('\n'));
  }
  for (const link of links) {
    parts.push(`Case study: [${escapeMarkdown(link.title)}](${link.href})`);
  }
  return parts.join('\n\n');
}

function renderExperience(
  work: readonly ResumeWorkEntry[],
  caseStudyTitles: ReadonlyMap<string, string>,
): string {
  const companies = groupWorkByCompany(work).map(
    (group) =>
      `### ${escapeMarkdown(group.name)}\n\n${group.roles
        .map((role) => renderRole(role, artifactLinks(role, caseStudyTitles)))
        .join('\n\n')}`,
  );
  return `## Experience\n\n${companies.join('\n\n')}`;
}

/** `null` while `education` is `[]`, so the whole section -- heading included -- is omitted. */
function renderEducation(education: Resume['education']): string | null {
  if (education.length === 0) return null;
  const entries = education.map((entry) => {
    const lines = [`**${escapeMarkdown(entry.institution)}**`];
    const studyLine = [entry.studyType, entry.area]
      .filter((value): value is string => Boolean(value))
      .map(escapeMarkdown)
      .join(', ');
    if (studyLine) lines.push(studyLine);
    if (entry.startDate) lines.push(formatDateRange(entry.startDate, entry.endDate));
    return lines.join('\n');
  });
  return `## Education\n\n${entries.join('\n\n')}`;
}

/**
 * `null` while `projects` is `[]`, same "no empty scaffolding" rule as
 * Education and Skills. A project renders its name (linked when it carries a
 * `url`), then roles and dates where present, then its highlights.
 */
function renderProjects(
  projects: Resume['projects'],
  caseStudyTitles: ReadonlyMap<string, string>,
): string | null {
  if (projects.length === 0) return null;
  const entries = projects.map((project) => {
    const name = escapeMarkdown(project.name);
    const heading = project.url ? `**[${name}](${project.url})**` : `**${name}**`;
    const meta = [
      project.roles.map(escapeMarkdown).join(', '),
      project.startDate ? formatDateRange(project.startDate, project.endDate) : '',
    ].filter(Boolean);
    const lines = [meta.length > 0 ? `${heading} · ${meta.join(' · ')}` : heading];
    lines.push(escapeMarkdown(project.description));
    if (project.highlights.length > 0) {
      lines.push(project.highlights.map((h) => `- ${escapeMarkdown(h)}`).join('\n'));
    }
    for (const link of artifactLinks(project, caseStudyTitles)) {
      lines.push(`Case study: [${escapeMarkdown(link.title)}](${link.href})`);
    }
    return lines.join('\n\n');
  });
  return `## Projects\n\n${entries.join('\n\n')}`;
}

/** `null` while `skills` is `[]`, so the whole section -- heading included -- is omitted. */
function renderSkills(skills: Resume['skills']): string | null {
  if (skills.length === 0) return null;
  const items = skills.map(
    (skill) =>
      `- **${escapeMarkdown(skill.name)}:** ${skill.keywords.map(escapeMarkdown).join(', ')}`,
  );
  return `## Skills\n\n${items.join('\n')}`;
}

export function renderResumeMarkdown(
  resume: Resume,
  caseStudyTitles: ReadonlyMap<string, string>,
): string {
  const sections = [
    `# ${escapeMarkdown(resume.basics.name)}`,
    escapeMarkdown(resume.basics.label),
    escapeMarkdown(resume.basics.summary),
    renderExperience(resume.work, caseStudyTitles),
    renderProjects(resume.projects, caseStudyTitles),
    renderEducation(resume.education),
    renderSkills(resume.skills),
  ].filter((section): section is string => section !== null);
  return `${sections.join('\n\n')}\n`;
}

export const GET: APIRoute = async () => {
  const resume = await getResume();
  // Titles for the case studies `x_artifacts` points at. Read here rather than
  // in src/lib/resume.ts, which stays free of `astro:content` so a plain vitest
  // run can exercise its helpers.
  const caseStudyTitles = new Map(
    (await getCollection('caseStudies')).map((study) => [study.id, study.data.title]),
  );
  return new Response(renderResumeMarkdown(resume, caseStudyTitles), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
