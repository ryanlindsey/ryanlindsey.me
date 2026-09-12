/**
 * The one description of how this site is deployed, read by both the drawing
 * and the markdown.
 *
 * WHY THIS IS A MODULE AND NOT TWO STRINGS. ArchitectureDiagram.astro renders
 * an inline SVG, and an SVG is nothing at all in the markdown an agent reads:
 * src/lib/markdown-export.ts strips the component tag, so every consumer of the
 * portable document -- the `.md` routes, the `Accept:`-negotiated responses,
 * /llms-full.txt, the feeds' full content and the corpus chunker -- got a post
 * with a hole where the architecture was. The obvious fix is a second
 * description written into the exporter. That is the wrong fix, and this file
 * exists to refuse it: ArchitectureDiagram.astro's own header records two
 * claims in its first draft that came from a stale copy of the architecture and
 * were false, and a hand-written duplicate here would be that mistake with a
 * longer fuse, because nobody reads the markdown variant to notice it drifting.
 *
 * So the fallback is not a second description. It is the SAME string the SVG
 * already carried in its `<desc>` for screen readers, which was always the
 * best prose statement of this architecture in the repository and was reaching
 * exactly one audience. tests/markdown-export.test.ts asserts that
 * ArchitectureDiagram.astro imports from here and does not re-inline the prose.
 *
 * PUBLISHED PROSE, AND IT WAS NOT BEING CHECKED AS SUCH. This text now ships
 * into published markdown, so house style applies without argument. It carried
 * an em dash while it lived in the .astro file, which the checker could not
 * see: check-prose.mjs classifies any line indented four spaces or more as
 * indented code, and every continuation line in an Astro template is indented,
 * so the whole `<desc>` block passed vacuously for as long as it lived there.
 * A test in tests/markdown-export.test.ts now asserts the absence directly.
 *
 * Keep this in step with the two wrangler.jsonc files and the two Worker
 * entries, which is what ArchitectureDiagram.astro's header says the drawing is
 * derived from. Every claim in it was re-verified 2026-09-11 against those
 * sources; that header carries the per-claim reasoning and is the place to read
 * before changing a word here.
 */
export const ARCHITECTURE_TITLE = 'How this site is deployed';

/** The screen-reader description, and the markdown fallback. One string. */
export const ARCHITECTURE_DESCRIPTION =
  'Two Cloudflare Workers. Visitors and agents reach the site Worker at ryanlindsey.me, which serves the pages, posts, case studies and the résumé, prerendered with some routes rendered on demand, plus llms.txt, the markdown variants and the feeds; it hosts the chat page and the form surfaces, and runs the queue consumer that sends the notification email. It calls the MCP Worker at mcp.ryanlindsey.me over a service binding for the MCP endpoint, for chat and for form posts; the MCP Worker calls back the same way to read published documents. The MCP Worker serves the MCP endpoint statelessly, rebuilding the server for each request, alongside the streamed chat inference and the discovery routes; it holds the one Durable Object in this system, which enforces the rate limits, and it is where inference runs: through AI Gateway to Anthropic, and through Workers AI into Vectorize for retrieval. Both Workers share D1 for the audit log, tokens, transcripts and eval runs, KV for caches and flags, R2 for generated PDFs and documents, Analytics Engine for request telemetry, and a queue that carries high-intent events to the email. Analytics Engine and the queue are independent sinks; neither feeds the other.';
