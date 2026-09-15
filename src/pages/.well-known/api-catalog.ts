import type { APIRoute } from 'astro';
import { buildApiCatalog } from '../../lib/discovery/api-catalog';
import { SITE_ORIGIN } from '../../lib/markdown-export';

// Prerendered, for the reason src/pages/.well-known/mcp.json.ts gives at
// length: the document is a pure function of a literal origin known at build
// time, so forwarding to the MCP Worker would buy a service-binding round trip
// for content a static build already answers for free.
export const prerender = true;

// The Content-Type below does not survive `astro build` -- public/_headers is
// what actually ships it. Kept for fidelity under `astro dev`, matching every
// other prerendered endpoint in this repository. This document is
// extensionless, so unlike a `.json` route Cloudflare's mime lookup has
// nothing at all to guess from without that rule. No charset on
// `application/linkset+json`: RFC 9264 registers the type without one, unlike
// this repo's own `application/json; charset=utf-8` convention.
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(buildApiCatalog(SITE_ORIGIN), null, 2), {
    headers: { 'Content-Type': 'application/linkset+json' },
  });
