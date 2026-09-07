import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { getResume } from '../lib/resume-collection';
import { buildJsonFeed } from '../lib/feeds';
import type { ExportableEntry } from '../lib/markdown-export';

// Day 3 Task 11 (02 §3): JSON Feed 1.1, hand-built -- `@astrojs/rss` is RSS
// 2.0 only (task-11-brief.md's appendix), and JSON Feed's shape is small and
// stable enough that a second dependency is not worth adding for it.
//
// This route is deliberately thin, same reasoning as src/pages/rss.xml.ts:
// the actual feed-building lives in src/lib/feeds.ts, which has no runtime
// `astro:content` import and so can be unit-tested from a plain
// `vitest run` process.
//
// Prerendered, same as /rss.xml.
export const prerender = true;

export const GET: APIRoute = async (context) => {
  // Same reasoning as src/pages/rss.xml.ts: `site` comes from the endpoint
  // context, not a hardcoded string.
  if (!context.site) {
    throw new Error('/feed.json: astro.config.mjs must declare `site`');
  }

  // Aggregation surface: same `!data.draft` filter as /rss.xml, /llms.txt
  // and the writing/work indexes.
  const [resume, posts, caseStudies] = await Promise.all([
    getResume(),
    getCollection('posts', ({ data }) => !data.draft),
    getCollection('caseStudies', ({ data }) => !data.draft),
  ]);

  const entries: ExportableEntry[] = [...posts, ...caseStudies];

  const feed = buildJsonFeed(entries, {
    title: resume.basics.name,
    description: resume.basics.summary,
    homePageUrl: new URL('/', context.site).href,
    feedUrl: new URL('/feed.json', context.site).href,
  });

  // Content-Type does not survive Astro's static build -- see
  // src/pages/rss.xml.ts's identical note. public/_headers ships the real
  // one. `application/feed+json` is the JSON Feed spec's own registered
  // media type (jsonfeed.org/version/1.1's Discovery section), not the more
  // generic `application/json` -- the same distinction /resume.json's
  // _headers rule already draws for a different reason (charset).
  return new Response(JSON.stringify(feed, null, 2), {
    headers: { 'Content-Type': 'application/feed+json; charset=utf-8' },
  });
};
