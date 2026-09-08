/**
 * `/.well-known/mcp.json`.
 *
 * NOT a ratified standard. The MCP specification defines
 * `/.well-known/oauth-protected-resource` for authorization discovery and
 * nothing else under /.well-known; this file is a convention, the same kind
 * of bet /llms.txt is, and it is documented as one rather than presented as
 * compliance. Keep it small and obvious so a human reading it learns the
 * endpoint in one glance -- that is its actual job today.
 *
 * `authentication: 'none'` describes the PUBLIC tier truthfully. Day 5 adds
 * scoped tokens and must revisit this field rather than leave it lying.
 *
 * `origin` is the caller's to supply rather than something this function
 * infers: the site origin (https://ryanlindsey.me) and the MCP Worker's own
 * vanity domain (https://mcp.ryanlindsey.me) each serve this document
 * describing themselves, and neither can derive the other's hostname from
 * its own request -- see src/pages/.well-known/mcp.json.ts and
 * workers/mcp/src/index.ts for the two literals this is called with.
 */
export function buildMcpDiscovery(origin: string) {
  return {
    name: 'ryanlindsey-me',
    description: "Ryan Lindsey's professional corpus, exposed as MCP tools.",
    endpoint: `${origin}/mcp`,
    transport: 'streamable-http',
    authentication: 'none',
    documentation: 'https://ryanlindsey.me/llms.txt',
  };
}

/**
 * `robots.txt` for `mcp.ryanlindsey.me` -- the day-3 owner decision this
 * task settles (03 §5): robots.txt is per-origin (RFC 9309 §2.3), so the
 * site's own file (public/robots.txt), which says as much explicitly, has
 * no effect here and this origin needs its own.
 *
 * Same posture as the site's file, for the same reason stated there: this
 * origin stays permissive (`Allow: /`, never `Disallow: /`) rather than
 * disallowing everything just because there is little to crawl. There is
 * nothing here a `Disallow` would protect -- no draft content, nothing
 * gated -- and per the site file's own warning (RFC 9309 §2.2.1), a
 * `Disallow` added under `*` later would not reach any of the named groups
 * below anyway, since a named group never inherits from `*`. Both groups
 * below repeat `Allow: /` explicitly rather than one relying on the other,
 * for exactly that reason.
 *
 * No `Content-Signal` line -- not because there is nothing worth protecting,
 * but because the reservation is not made here. `Content-Signal`, and
 * specifically `ai-train=no`, is an Article 4(3) TDM rights reservation over
 * copyrightable CONTENT a crawler reads via GET on the origin the line sits
 * on. The corpus this server exposes is not stored on this origin at all:
 * the MCP Worker holds no copy of it and fetches every document, per call,
 * from https://ryanlindsey.me over `SITE_ORIGIN` (global constraint,
 * src/lib/corpus.ts) -- so the only things a GET on mcp.ryanlindsey.me can
 * ever return are this file and /.well-known/mcp.json, neither of which is
 * the corpus. That content already carries its reservation at the origin
 * where it actually lives: every group in the site's own robots.txt repeats
 * `ai-train=no` for exactly this reason. Restating the line here would not
 * extend the reservation to anything new -- there is nothing new here to
 * reserve rights over -- and it would have nowhere to attach on this
 * origin's one real protocol surface regardless: `/mcp` answers JSON-RPC
 * POST, not the GET-driven page retrieval `Content-Signal` was written to
 * describe.
 *
 * Named agents are welcomed by the same tokens the site's own file uses,
 * for legibility -- consistent with 03 §5's framing, not because any of
 * them fetches anything different here than `*` would already allow: `/mcp`
 * only answers JSON-RPC POST, so there is no page for any crawler, named or
 * not, to actually retrieve.
 */
export function buildMcpRobotsTxt(): string {
  return `# robots.txt for https://mcp.ryanlindsey.me
#
# robots.txt is per-origin (RFC 9309 §2.3): https://ryanlindsey.me/robots.txt
# says nothing about this host, and this file says nothing about that one.
# This origin serves a Model Context Protocol tool endpoint, not pages --
# POST /mcp speaks JSON-RPC and there is nothing here for a crawler to read
# or index. See https://ryanlindsey.me/llms.txt for the curated, agent-facing
# index of what this corpus actually publishes, and /.well-known/mcp.json on
# this origin for the machine-readable description of the endpoint itself.
#
# Permissive anyway (\`Allow: /\`, no \`Disallow\`), same reasoning as the
# site's own file: a named \`User-agent\` group below does not inherit
# anything from the \`*\` group (RFC 9309 §2.2.1), so both groups state
# \`Allow: /\` explicitly rather than one leaning on the other.

User-agent: *
Allow: /

# Named for legibility, matching the site's own robots.txt -- there is
# nothing on this origin for any of these to fetch beyond this file,
# /.well-known/mcp.json, and /mcp itself (JSON-RPC POST only, not a page).
User-agent: ClaudeBot
User-agent: Claude-User
User-agent: Claude-SearchBot
User-agent: GPTBot
User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: Google-Extended
User-agent: PerplexityBot
User-agent: Perplexity-User
User-agent: CCBot
User-agent: meta-externalagent
User-agent: meta-webindexer
User-agent: meta-externalads
User-agent: meta-externalfetcher
User-agent: Amazonbot
User-agent: Applebot
User-agent: Applebot-Extended
User-agent: MistralAI-User
Allow: /
`;
}
