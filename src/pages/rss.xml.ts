import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { getResume } from '../lib/resume-collection';
import { buildRssFeed } from '../lib/feeds';
import type { ExportableEntry } from '../lib/markdown-export';

// Day 3 Task 11 (02 §3): RSS 2.0 via `@astrojs/rss` (pinned 4.0.19 --
// task-11-brief.md's appendix: no peerDependencies/engines, so it cannot be
// package-manager-incompatible with Astro 7; its Astro-7 support is
// inferred, not stated in its own changelog).
//
// This route is deliberately thin, same reasoning as src/pages/llms.txt.ts:
// the actual feed-building lives in src/lib/feeds.ts, which has no runtime
// `astro:content` import and so can be unit-tested from a plain
// `vitest run` process.
//
// Prerendered: a pure function of the same published content collections
// /writing, /work and /llms.txt already read, so it builds once, at the
// same time they do.
export const prerender = true;

export const GET: APIRoute = async (context) => {
  // `@astrojs/rss` recommends taking `site` from the endpoint context rather
  // than a hardcoded string (its own RSSOptions.site doc comment) -- this is
  // the one call site on this site that follows that recommendation, rather
  // than reusing markdown-export.ts's `SITE_ORIGIN` copy the way llms-index.ts
  // does for per-entry URLs. astro.config.mjs always sets `site`, so this can
  // only be missing if that config regresses -- a build-time failure, not a
  // silently wrong feed, is the right outcome for that.
  if (!context.site) {
    throw new Error('/rss.xml: astro.config.mjs must declare `site` for @astrojs/rss to work');
  }

  // Aggregation surface (task-11-brief.md's "draft rule"): only published
  // entries reach this feed, matching src/pages/llms.txt.ts and
  // src/pages/writing/index.astro's own `!data.draft` filter exactly. The
  // detail routes and their `.md` siblings are the other tier -- they serve
  // drafts too, deliberately.
  const [resume, posts, caseStudies] = await Promise.all([
    getResume(),
    getCollection('posts', ({ data }) => !data.draft),
    getCollection('caseStudies', ({ data }) => !data.draft),
  ]);

  const entries: ExportableEntry[] = [...posts, ...caseStudies];

  const xml = await buildRssFeed(entries, {
    // Matches Base.astro's Person node and /llms.txt's own H1/summary --
    // one name, one reused résumé summary, not a fourth hand-written copy.
    title: resume.basics.name,
    description: resume.basics.summary,
    site: context.site,
  });

  // The Content-Type set here does not survive Astro's static build --
  // Astro discards a prerendered endpoint's Response headers and writes
  // only the body (same note as /llms.txt and /llms-full.txt).
  // public/_headers is what actually makes the deployed response serve
  // `application/rss+xml`. Kept for fidelity under `astro dev` regardless.
  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
};
