import type { APIRoute } from 'astro';
import { buildProtectedResource } from '../../lib/discovery/protected-resource';

// Prerendered, for the reason src/pages/.well-known/mcp.json.ts gives at
// length: the document is a pure function of a literal origin known at build
// time, so forwarding to the MCP Worker would buy a service-binding round trip
// for content a static build already answers for free.
export const prerender = true;

// The Content-Type below does not survive `astro build` -- public/_headers is
// what actually ships it. Kept for fidelity under `astro dev`, matching every
// other prerendered endpoint in this repository. This document is
// extensionless, so unlike a `.json` route Cloudflare's mime lookup has
// nothing at all to guess from without that rule.
//
// The literal is the MCP endpoint, not SITE_ORIGIN: this route describes the
// resource a bearer token is presented TO, which is always
// https://mcp.ryanlindsey.me/mcp regardless of which origin serves this copy
// of the document -- same reasoning workers/mcp/src/index.ts's own branch
// gives for the identical literal.
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(buildProtectedResource('https://mcp.ryanlindsey.me/mcp'), null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
