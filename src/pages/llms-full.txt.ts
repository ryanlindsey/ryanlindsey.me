import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import type { ExportableEntry } from '../lib/markdown-export';
import { buildLlmsFullTxt, byPublishedDesc } from '../lib/llms-index';

// Day 3 Task 9 (research appendix B1.5): the bulk-ingestion corpus.
// `llms-full.txt` is not in the llms.txt spec (v1 or v2) -- it is a vendor
// convention Mintlify originated ("your entire documentation site into a
// single file"). This site's version follows the same shape: every
// published document's markdown, concatenated, each preceded by its
// canonical URL (src/lib/llms-index.ts's `buildLlmsFullTxt`). `/llms.txt`
// is the curated index meant to fit in an agent's context; this file is the
// opposite of that on purpose, which is exactly why /llms.txt links it but
// src/components/SiteFooter.astro does not -- see that file's comment.
//
// This route is deliberately thin, same reasoning as src/pages/llms.txt.ts:
// the generator lives in src/lib/llms-index.ts, which has no runtime
// `astro:content` import and so can be unit-tested from a plain
// `vitest run` process.
//
// Prerendered, same as /llms.txt: a pure function of the same published
// content collections, built once at build time.
export const prerender = true;

export const GET: APIRoute = async () => {
  // Aggregation surface: same `!data.draft` filter as /llms.txt,
  // src/pages/writing/index.astro and src/pages/work/index.astro. This is
  // the single highest-risk leak surface on the site (task-9-brief.md's own
  // words) precisely because it concatenates every document into one
  // response -- anything that leaks anywhere leaks here, so the filter this
  // route applies is exactly as load-bearing as the index pages' own.
  const posts = await getCollection('posts', ({ data }) => !data.draft);
  const caseStudies = await getCollection('caseStudies', ({ data }) => !data.draft);

  // Grouped by collection (all posts, then all case studies), each newest
  // first -- the same grouping /llms.txt's own Writing/Case studies
  // sections use, rather than interleaving the two collections by date.
  const entries: ExportableEntry[] = [
    ...posts.sort(byPublishedDesc),
    ...caseStudies.sort(byPublishedDesc),
  ];

  // Content-Type does not survive Astro's static build -- see
  // src/pages/llms.txt.ts's identical note. public/_headers ships the real
  // one.
  return new Response(buildLlmsFullTxt(entries), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
