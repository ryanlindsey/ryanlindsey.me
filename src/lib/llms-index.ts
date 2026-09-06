import type { CollectionEntry } from 'astro:content';
import { canonicalUrlFor, toMarkdown, SITE_ORIGIN, type ExportableEntry } from './markdown-export';

// Day 3 Task 9 (02 §3 / research appendix B1): the pure half of `/llms.txt`
// and `/llms-full.txt` -- everything that does not need `getCollection` at
// request time lives here, same split src/lib/markdown-export.ts and
// src/lib/resume.ts already use, and for the same reason: `astro:content`
// is a virtual module that only resolves inside Astro's own build/dev
// pipeline, not from a plain `vitest run` process (`CollectionEntry` below
// is a type-only import, exactly like markdown-export.ts's). Keeping the
// generator functions here, importable with no Astro-flavoured module
// loaded, is what lets tests/pages.test.ts unit-test both the omission
// behaviour AND a populated fixture directly -- see task-9-brief.md's
// "fooled six times" warning, which is exactly the trap of only ever
// asserting today's real, all-draft, empty output.
//
// src/pages/llms.txt.ts and llms-full.txt.ts are the thin, impure routes
// that call `getCollection`/`getResume` and hand the results to the
// functions here.

/** One `- [title](url): description` file-list line's worth of data. */
export interface LlmsLink {
  title: string;
  url: string;
  description: string;
}

/**
 * Builds one `## heading` file-list section, or returns `null` when `links`
 * is empty.
 *
 * THE THING MOST LIKELY TO SHIP WRONG (task-9-brief.md's own words): both
 * `.mdx` specimens in this repo are `draft: true` today, so the Writing and
 * Case studies sections have nothing to list right now. The spec's own mock
 * example (llms.txt v2) never shows a `## Section name` heading with an
 * empty list under it, and a heading promising links that are not there is
 * worse than no section at all to an agent parsing this file. So an empty
 * `links` array omits the heading entirely -- the same "no empty
 * scaffolding" rule src/pages/resume.md.ts already applies to Education and
 * Skills -- and the section comes back automatically the moment a post or
 * case study is published.
 */
function buildSection(heading: string, links: LlmsLink[]): string | null {
  if (links.length === 0) return null;
  const items = links.map((link) => `- [${link.title}](${link.url}): ${link.description}`);
  return `## ${heading}\n\n${items.join('\n')}`;
}

/**
 * The whole `/llms.txt` file: an H1, a blockquote summary, then zero or more
 * `## heading` file-list sections -- llms.txt v2's own section order
 * (research appendix B1.3), NOT v1. `RESUME_LINKS`/`MCP_LINKS` are supplied
 * by the caller rather than hardcoded here so this function stays a pure
 * mapping from data to text, testable with a plain fixture.
 */
export function buildLlmsTxt(input: {
  summary: string;
  resume: LlmsLink[];
  mcp: LlmsLink[];
  posts: LlmsLink[];
  caseStudies: LlmsLink[];
}): string {
  const header = `# Ryan Lindsey\n\n> ${input.summary}`;
  const sections = [
    buildSection('Resume', input.resume),
    buildSection('MCP', input.mcp),
    buildSection('Writing', input.posts),
    buildSection('Case studies', input.caseStudies),
  ].filter((value): value is string => value !== null);

  return sections.length > 0 ? `${header}\n\n${sections.join('\n\n')}\n` : `${header}\n`;
}

/**
 * A post or case study's `/llms.txt` file-list entry, pointed at its `.md`
 * URL (Task 7's `[...slug].md.ts` routes) rather than its HTML page -- v2's
 * own recommendation ("The links in an llms.txt file should therefore point
 * to LLM-friendly content, such as the markdown versions of pages").
 * `entry.data.description` is already the one-line description every
 * content-collection entry carries (content.config.ts), so no separate
 * summary needs writing here.
 */
export function markdownLinkFor(
  entry: CollectionEntry<'posts'> | CollectionEntry<'caseStudies'>,
): LlmsLink {
  const routeSection = entry.collection === 'posts' ? 'writing' : 'work';
  return {
    title: entry.data.title,
    url: `${SITE_ORIGIN}/${routeSection}/${entry.id}.md`,
    description: entry.data.description,
  };
}

/** Newest first -- the same order /writing and /work's own indexes use. */
export const byPublishedDesc = <T extends { data: { publishedAt: Date } }>(a: T, b: T): number =>
  b.data.publishedAt.getTime() - a.data.publishedAt.getTime();

/**
 * Concatenates `entries`' rendered markdown for `/llms-full.txt`, each
 * preceded by its canonical URL, separated by a horizontal rule --
 * task-9-brief.md Step 2. `llms-full.txt` is not part of the llms.txt spec
 * (research appendix B1.5); this is this site's own convention, following
 * the vendor pattern (Mintlify) it originated from.
 *
 * `toMarkdown` throws (does not return) if an entry still carries an
 * unstrippable MDX component tag -- see markdown-export.ts's module doc.
 * That throw is deliberately left to propagate here: a corrupted document
 * belongs in a failed build, not in a silently-shipped corpus file.
 */
export function buildLlmsFullTxt(entries: ExportableEntry[]): string {
  return entries
    .map((entry) => `${canonicalUrlFor(entry)}\n\n${toMarkdown(entry)}`)
    .join('\n---\n\n');
}
