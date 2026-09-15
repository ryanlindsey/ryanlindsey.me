import type { APIRoute } from 'astro';
import { buildProtectedResource } from '../../lib/discovery/protected-resource';
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
// nothing at all to guess from without that rule.
//
// SITE_ORIGIN, NOT the MCP endpoint's own origin: this route's `resource`
// field has to identify the origin that actually SERVED this copy of the
// document, per RFC 9728 §2, which a client validates against. This route
// used to hard-code `https://mcp.ryanlindsey.me/mcp` regardless of which
// origin served it, on the reasoning that both origins' copies describe the
// "same" resource -- a production scan (isitagentready.com, checked
// 2026-09-14) caught that this made the site's own copy self-inconsistent:
// a document served from ryanlindsey.me that names mcp.ryanlindsey.me as
// its own resource fails RFC 9728's own validation. This route genuinely
// does serve `/mcp` too (the `MCP` service binding forwards it, see
// astro.config.mjs / src/worker.ts), so `SITE_ORIGIN` is not a workaround --
// it is what this origin's own copy of the document should have said from
// the start. workers/mcp/src/index.ts's own branch makes the same change
// for its origin, passing `MCP_ORIGIN` instead.
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(buildProtectedResource(SITE_ORIGIN), null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
