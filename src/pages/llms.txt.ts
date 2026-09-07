import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { getResume } from '../lib/resume-collection';
import { SITE_ORIGIN } from '../lib/markdown-export';
import { buildLlmsTxt, markdownLinkFor, byPublishedDesc, type LlmsLink } from '../lib/llms-index';

// Day 3 Task 9 (02 §3 / research appendix B1): the curated agent index, in
// llms.txt v2 (2026-08-10) shape -- NOT v1. v2 is what defines the exact
// section order (H1, then a blockquote summary, then H2 "file list"
// sections of `- [title](url): description` links) that src/lib/llms-index.ts's
// `buildLlmsTxt` implements, and it is also what gives the links below
// their shape: v2 folds .md-URL discoverability into the spec itself, which
// is why every Writing/Case studies link points at a page's `.md` form
// (Task 6/7's exporter and routes), never its HTML sibling. v2 also strips
// the old `Optional` section of its mechanical meaning (research appendix
// B1.4) -- this file has no such section, on purpose.
//
// This route is deliberately thin: `astro:content` is a real (not
// type-only) import here, which is exactly why the generator logic itself
// lives in src/lib/llms-index.ts instead -- a plain `vitest run` process
// cannot resolve `astro:content` (see that file's module doc), and this
// route's own dotted filename (`llms.txt.ts`) makes it importable from a
// test at all only by accident of Vite's resolver; keeping this file free
// of anything a test needs to call directly sidesteps the question.
//
// Prerendered: a pure function of the same content collections
// /writing and /work's own indexes already read, so it builds once, at the
// same time they do.
export const prerender = true;

/**
 * `mcp.ryanlindsey.me` is a different origin from `SITE_ORIGIN`
 * (src/lib/markdown-export.ts), so it is its own literal rather than
 * derived -- workers/mcp/wrangler.jsonc's own `routes` entry is the other
 * place this hostname is declared.
 *
 * Fix round 1 (task-9-report.md): the bare origin 404s. The custom domain
 * is only the host; `workers/mcp/src/index.ts`'s
 * `createMcpHandler(createServer, { route: '/mcp' })` mounts the actual
 * JSON-RPC endpoint at `/mcp` (confirmed live: POST /mcp with an
 * `initialize` body succeeds; GET /mcp answers 405, which is expected for
 * an endpoint that only speaks JSON-RPC POST; GET / is a genuine 404). The
 * path is part of the endpoint, not incidental to it.
 */
const MCP_ENDPOINT = 'https://mcp.ryanlindsey.me/mcp';

/**
 * The résumé in all four formats (02 §1 / task-9-brief.md Step 1) --
 * unlike the Writing/Case studies sections, every one of these formats gets
 * its own link, HTML included, because this section IS the format manifest,
 * not a pointer to the single most LLM-friendly representation of one
 * document.
 */
const RESUME_LINKS: LlmsLink[] = [
  {
    title: 'Resume (Markdown)',
    url: `${SITE_ORIGIN}/resume.md`,
    description: 'Portable markdown résumé -- the cleanest format for a model to read.',
  },
  {
    title: 'Resume (JSON)',
    url: `${SITE_ORIGIN}/resume.json`,
    description: 'JSON Resume schema, machine-readable.',
  },
  {
    title: 'Resume (PDF)',
    url: `${SITE_ORIGIN}/resume.pdf`,
    description: 'Print-formatted résumé.',
  },
  {
    title: 'Resume (HTML)',
    url: `${SITE_ORIGIN}/resume`,
    description: 'The résumé as a web page.',
  },
];

const MCP_LINKS: LlmsLink[] = [
  {
    title: 'MCP server',
    url: MCP_ENDPOINT,
    // Task 12 (03 §1): the previous line ("One tool today: get_contact") was
    // accurate at Task 9 and false since Task 6 -- tools/list grew to eight
    // tools across Tasks 6-11 and nothing here followed. Written literally
    // rather than generated from workers/mcp/src/server.ts's own
    // registrations: that tool map lives in a separate Worker with its own
    // module graph, and `astro:content` (this file's own build, per the
    // module doc above) cannot import it. tests/pages.test.ts's
    // "/llms.txt describes the MCP server current tool map" assertion is
    // what stops this hand-written copy drifting from the real registrations
    // silently a second time -- keep the two in step by hand on every task
    // that changes either one.
    description:
      'Model Context Protocol server with eight tools (get_contact, get_resume, ' +
      'list_case_studies, get_case_study, list_writing, get_post, search_writing, ' +
      'request_private_access) and two resources (resume://json, writing://{slug}). ' +
      'A private tier exists for scoped tokens; request_private_access explains how to ask.',
  },
];

/**
 * The bulk-ingest corpus (fix round 2). `/llms-full.txt` had no inbound link
 * from anywhere on the site, while src/pages/llms-full.txt.ts,
 * src/components/SiteFooter.astro and tests/pages.test.ts each explained their
 * own shape by saying that /llms.txt pointed at it. This is that link.
 *
 * Unconditional, like RESUME_LINKS and MCP_LINKS above and unlike the
 * Writing/Case studies sections: the route always exists and always resolves.
 * It is empty today only because every content entry is `draft: true`, and it
 * fills in on its own with no change here -- the same way /llms.txt's own
 * sections do.
 */
const FULL_CONTENT_LINKS: LlmsLink[] = [
  {
    title: 'All content (llms-full.txt)',
    url: `${SITE_ORIGIN}/llms-full.txt`,
    description:
      "Every published document's markdown in one file -- one fetch instead of one per page.",
  },
];

export const GET: APIRoute = async () => {
  // Aggregation surface (task-9-brief.md's "draft rule"): only published
  // entries reach this file, matching src/pages/writing/index.astro and
  // src/pages/work/index.astro's own `!data.draft` filter exactly. The
  // detail routes and their `.md` siblings are the other tier -- they serve
  // drafts too, deliberately (see src/pages/writing/[...slug].md.ts).
  const [resume, posts, caseStudies] = await Promise.all([
    getResume(),
    getCollection('posts', ({ data }) => !data.draft),
    getCollection('caseStudies', ({ data }) => !data.draft),
  ]);

  const body = buildLlmsTxt({
    // Reused from the résumé's own reviewed summary rather than hand-written
    // here a second time -- one source of truth, same reasoning
    // content.config.ts gives for the résumé data model as a whole.
    summary: resume.basics.summary,
    resume: RESUME_LINKS,
    mcp: MCP_LINKS,
    posts: posts.sort(byPublishedDesc).map(markdownLinkFor),
    caseStudies: caseStudies.sort(byPublishedDesc).map(markdownLinkFor),
    full: FULL_CONTENT_LINKS,
  });

  // The Content-Type set here does not survive Astro's static build --
  // Astro discards a prerendered endpoint's Response headers and writes
  // only the body (same as /resume.md, /resume.json and Task 7's `.md`
  // routes). public/_headers is what actually makes the deployed response
  // serve `text/plain`. Kept for fidelity under `astro dev` regardless.
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
