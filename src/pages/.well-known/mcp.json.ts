import type { APIRoute } from 'astro';
import { buildMcpDiscovery } from '../../lib/mcp/discovery';
import { SITE_ORIGIN } from '../../lib/markdown-export';

// Day 4 Task 14 (roadmap "/.well-known + discovery"; 03 §5; 08 v1 item 2).
//
// A prerendered page, not a forward to the MCP Worker's own copy of this
// route (workers/mcp/src/index.ts): the document is a pure function of a
// literal origin (SITE_ORIGIN, same constant /llms.txt's own MCP_LINKS
// already uses), known at build time and never dependent on anything the
// MCP Worker computes per-request. Forwarding would trade that for a
// service-binding round trip on every fetch, for content that a static build
// already answers for free -- the same tradeoff src/worker.ts's own `/mcp`
// forward makes in the other direction, where the target genuinely is
// stateful protocol traffic this origin cannot answer itself. This route is
// prerendered like every other pure-content endpoint on this site
// (/resume.json, /llms.txt, ...), and the MCP Worker gets its own copy for
// exactly the same reason it needs its own robots.txt: it is a separate
// origin (RFC 9309 §2.3 makes the same point for robots.txt) serving its own
// vanity endpoint (https://mcp.ryanlindsey.me/mcp), which this build cannot
// describe.
export const prerender = true;

// Astro's static build discards a prerendered endpoint's own Response
// headers (day 3 established this for /resume.json, /resume.md, /llms.txt
// and every `.md` detail route) -- the Content-Type set below does not
// survive into the deployed artifact. public/_headers' own
// `/.well-known/mcp.json` rule is what actually ships it; this is kept for
// fidelity under `astro dev` regardless, matching every other route above.
export const GET: APIRoute = async () => {
  const doc = buildMcpDiscovery(SITE_ORIGIN);
  return new Response(JSON.stringify(doc, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
