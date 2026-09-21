/**
 * Every endpoint this site advertises to agents, in one list.
 *
 * ONE list rather than two, because /.well-known/api-catalog and
 * /.well-known/ai-catalog.json describe the same surface in different
 * vocabularies, and two hand-maintained copies would drift the first time an
 * endpoint moved.
 *
 * WHAT IS DELIBERATELY ABSENT: /fit and everything beneath it. Those routes are
 * unlisted by requirement -- absent from nav, sitemap and llms.txt -- and
 * /fit/r/<id> carries a scoped token in the URL itself. A catalog is a
 * published list of the paths its author finds interesting, so listing one here
 * would un-list it exactly the way public/robots.txt's own header warns a
 * Disallow line would. tests/discovery-catalog.test.ts asserts this against
 * src/lib/unindexed-routes.mjs rather than trusting this comment.
 */
export interface AdvertisedEndpoint {
  path: string;
  namespace: string;
  name: string;
  displayName: string;
  mediaType: string;
  representativeQueries: string[];
  /**
   * A document that DESCRIBES the endpoint, for the manifest builders that
   * want one, while `path` stays the endpoint itself for the linkset. Added
   * 2026-09-20 for the MCP server: SEP-2127 has the AI Catalog entry point
   * at the server card with the card's media type, and RFC 9727's linkset
   * still names the API. Absent on every entry that is its own description.
   */
  descriptor?: { path: string; mediaType: string };
}

export const ADVERTISED_SURFACE = [
  {
    path: '/mcp',
    namespace: 'mcp',
    name: 'corpus',
    displayName: 'Model Context Protocol endpoint',
    // UNREAD WHILE THE DESCRIPTOR BELOW IS PRESENT, and kept regardless: the
    // manifest builder takes the descriptor's type instead and the linkset
    // builder reads no media type at all, so nothing currently consumes this
    // line. It stays because the field is required and because it is what
    // this entry reverts to if the descriptor ever goes. It is also the
    // weakest claim in this list -- `GET /mcp` answers 405, never a JSON body
    // -- which is a second reason not to let a builder read it again without
    // deciding what it should say.
    mediaType: 'application/json',
    // A literal rather than an import of `SERVER_CARD_MEDIA_TYPE`: this file
    // is the leaf every builder imports and must import nothing back.
    // tests/discovery-catalog.test.ts pins the two equal.
    descriptor: { path: '/mcp/server-card', mediaType: 'application/mcp-server-card+json' },
    representativeQueries: [
      'What has Ryan Lindsey written about agent-native sites?',
      'Show me the case studies in this portfolio',
    ],
  },
  {
    path: '/chat',
    namespace: 'mcp',
    name: 'chat',
    // NOT the SSE stream itself. `/chat` is `src/pages/chat.astro`, a page a
    // person or an agent that reads HTML can open; verified against
    // production on 2026-09-14, `GET https://ryanlindsey.me/chat` answers
    // `text/html`. The stream lives at `POST /chat/send`, which needs a
    // Turnstile response token an agent cannot mint, so it is not
    // advertised here -- `mediaType: 'text/event-stream'` used to sit on
    // this entry and was wrong for exactly that reason: it named a media
    // type this path never serves and implied an agent-callable endpoint
    // this path is not. `src/pages/llms.txt.ts`'s own `/chat` entry, the
    // document this catalog names as its `service-doc`, has always
    // described the same path as a page; this entry now agrees with it.
    displayName: 'Grounded chat page',
    mediaType: 'text/html',
    representativeQueries: [
      'Where can I ask a question about this portfolio and read a cited answer?',
      'Is there a page for asking what a project actually changed?',
    ],
  },
  {
    path: '/llms.txt',
    namespace: 'content',
    name: 'index',
    displayName: 'Curated index for agents',
    mediaType: 'text/plain',
    representativeQueries: ['What is on this site?', 'Where do I start reading this corpus?'],
  },
  {
    path: '/llms-full.txt',
    namespace: 'content',
    name: 'full',
    displayName: 'Full corpus as one document',
    mediaType: 'text/plain',
    representativeQueries: [
      'Give me everything published on this site in one file',
      'Load the whole corpus for grounding',
    ],
  },
  {
    path: '/resume.json',
    namespace: 'profile',
    name: 'resume-json',
    displayName: 'Resume as JSON Resume',
    mediaType: 'application/json',
    representativeQueries: [
      "What is Ryan Lindsey's work history?",
      'Parse this resume as structured data',
    ],
  },
  {
    path: '/resume.md',
    namespace: 'profile',
    name: 'resume-markdown',
    displayName: 'Resume as markdown',
    mediaType: 'text/markdown',
    representativeQueries: ['Read the resume as a document', 'Summarize this background'],
  },
  {
    path: '/rss.xml',
    namespace: 'feed',
    name: 'rss',
    displayName: 'Writing feed (RSS)',
    mediaType: 'application/rss+xml',
    representativeQueries: [
      'Subscribe to new writing from this site',
      'What was published recently?',
    ],
  },
  {
    path: '/feed.json',
    namespace: 'feed',
    name: 'json-feed',
    displayName: 'Writing feed (JSON Feed)',
    mediaType: 'application/feed+json',
    representativeQueries: ['Poll this site for new posts as JSON', 'What was published recently?'],
  },
] as const satisfies readonly AdvertisedEndpoint[];
