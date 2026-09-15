import type { APIRoute } from 'astro';
import { buildSkillsIndex } from '../../../lib/discovery/skills';
import { SITE_ORIGIN } from '../../../lib/markdown-export';

// Prerendered, for the reason src/pages/.well-known/mcp/server-card.json.ts
// gives at length: the document is a pure function of a literal origin known
// at build time, so forwarding to the MCP Worker would buy a service-binding
// round trip for content a static build already answers for free.
export const prerender = true;

// The Content-Type below does not survive `astro build` -- public/_headers is
// what actually ships it. Kept for fidelity under `astro dev`, matching every
// other prerendered endpoint in this repository.
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(await buildSkillsIndex(SITE_ORIGIN), null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
