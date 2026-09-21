import type { APIRoute } from 'astro';
import { AI_CATALOG_MEDIA_TYPE, buildAiCatalog } from '../../lib/discovery/ard';
import { SITE_ORIGIN } from '../../lib/markdown-export';

// Prerendered, for the reason src/pages/.well-known/mcp.json.ts gives at
// length: the document is a pure function of a literal origin known at build
// time, so forwarding to the MCP Worker would buy a service-binding round trip
// for content a static build already answers for free.
export const prerender = true;

// Neither header below survives `astro build` -- public/_headers is what
// actually ships them. Kept for fidelity under `astro dev`, matching every
// other prerendered endpoint in this repository.
//
// Access-Control-Allow-Origin is required by the ARD specification, so a
// browser-resident agent running on another origin can read this manifest
// with `fetch()` instead of failing the browser's own CORS check -- nothing
// here is a credentialed request, so `*` costs this document nothing.
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(buildAiCatalog(SITE_ORIGIN), null, 2), {
    headers: {
      'Content-Type': AI_CATALOG_MEDIA_TYPE,
      'Access-Control-Allow-Origin': '*',
    },
  });
