import type { APIRoute } from 'astro';
import { getCollection, type CollectionEntry } from 'astro:content';
import { canonicalUrlFor } from '../lib/markdown-export';
import { getNowItems } from '../lib/now-collection';
import { PILLAR_LABELS } from '../lib/pillars';
import { getResume } from '../lib/resume-collection';
import type { Resume } from '../lib/resume';

// Issue #171 (epic #165, "agent readiness"): the markdown twin of the home
// page. Built from the SAME THREE collections src/pages/index.astro reads --
// published posts sorted by date, getResume()'s basics, and getNowItems() --
// not from /llms.txt's own data, which is a curated index of the whole site
// rather than a rendering of this one page (see that route's own module
// doc). Static output: a pure function of committed content, so it
// prerenders like every other page (src/pages/resume.pdf.ts owns the one
// on-demand route this site needs).
//
// Astro's static build writes only the Response BODY to disk (same as
// src/pages/resume.md.ts): the header set below does not survive into the
// deployed artifact. public/_headers is what makes the deployed response
// serve `text/markdown; charset=utf-8` -- see that file's `/index.md` rule.
export const prerender = true;

/**
 * Escapes the two characters that can corrupt this document if a title, the
 * bio or a Now item happens to contain them: a literal `|` (would look like
 * a table cell) and a leading `#` (would look like a heading). Copied from
 * src/pages/resume.md.ts rather than shared: both files keep this as a small,
 * local, single-purpose helper -- markdown-export.ts's `toMarkdown` renders a
 * whole document (frontmatter plus body) and has no equivalent inline
 * escaping job for this exporter to reuse.
 */
function escapeMarkdown(text: string): string {
  const pipesEscaped = text.replaceAll('|', '\\|');
  return pipesEscaped.startsWith('#') ? `\\${pipesEscaped}` : pipesEscaped;
}

function renderNow(items: readonly string[]): string {
  return `## Now\n\n${escapeMarkdown(items.join(' · '))}`;
}

function renderBio(basics: Resume['basics']): string {
  return (
    '## Who is writing\n\n' +
    `**${escapeMarkdown(basics.name)}**, ${escapeMarkdown(basics.label)}.\n\n` +
    escapeMarkdown(basics.summary)
  );
}

function pillarLabelFor(post: CollectionEntry<'posts'>): string {
  return PILLAR_LABELS[post.data.pillar] ?? post.data.pillar;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** One post's heading line: title (linked to its canonical URL), pillar, date. */
function renderPostHeading(post: CollectionEntry<'posts'>): string {
  const link = `**[${escapeMarkdown(post.data.title)}](${canonicalUrlFor(post)})**`;
  return `${link} · ${pillarLabelFor(post)} · ${isoDate(post.data.publishedAt)}`;
}

/**
 * `null` while there is no published post to lead with, so the section --
 * heading included -- is omitted, matching src/pages/resume.md.ts's rule for
 * an empty section and index.astro's own "First pieces land soon." empty
 * state (rendered there instead of omitted, because that page always shows
 * something; this document just leaves the section out).
 */
function renderLead(lead: CollectionEntry<'posts'> | undefined): string | null {
  if (!lead) return null;
  return `## Latest\n\n${renderPostHeading(lead)}\n\n${escapeMarkdown(lead.data.description)}`;
}

/** `null` while there are no further posts, same "no empty scaffolding" rule as `renderLead`. */
function renderMore(posts: readonly CollectionEntry<'posts'>[]): string | null {
  if (posts.length === 0) return null;
  const entries = posts.map(
    (post) => `${renderPostHeading(post)}\n\n${escapeMarkdown(post.data.description)}`,
  );
  return `## More writing\n\n${entries.join('\n\n')}`;
}

export const GET: APIRoute = async () => {
  // Same query and slice as src/pages/index.astro: the lead and the "more
  // writing" list have to agree about which post is most recent, and a
  // second, independently-filtered query is how a markdown twin drifts from
  // the page it mirrors.
  const published = await getCollection('posts', ({ data }) => !data.draft);
  const posts = published.sort(
    (a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime(),
  );
  const lead = posts.at(0);
  const more = posts.slice(1, 4);

  const { basics } = await getResume();
  const nowItems = await getNowItems();

  const sections = [
    `# ${escapeMarkdown(basics.name)}`,
    renderNow(nowItems),
    renderLead(lead),
    renderBio(basics),
    renderMore(more),
  ].filter((section): section is string => section !== null);

  return new Response(`${sections.join('\n\n')}\n`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
