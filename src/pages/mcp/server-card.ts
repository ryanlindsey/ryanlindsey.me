import type { APIRoute } from 'astro';
import { SERVER_CARD_CORS_HEADERS, serverCardResponse } from '../../lib/discovery/server-card-v1';
import { SITE_ORIGIN } from '../../lib/markdown-export';

// On-demand, unlike the SEP-1649 card beside it at
// src/pages/.well-known/mcp/server-card.json.ts, which is prerendered. The
// SEP-2127 extension makes four Access-Control headers MUST and an ETag with
// 304-on-If-None-Match SHOULD, and a prerendered asset gets its headers from
// public/_headers and its 304 from Cloudflare's asset server -- a different
// mechanism from the one the MCP origin uses, which is exactly how the two
// copies would come to differ. Running the same `serverCardResponse` on both
// origins is what makes the conformance test on one of them evidence about
// the other.
//
// Because this route is on-demand, it sets its own Content-Type and takes no
// public/_headers rule -- not because a second rule on this path is
// forbidden, but because one would never fire. public/_headers's own header
// note records a measurement taken 2026-09-07, right below the `/*` rule:
// those rules are applied by Cloudflare's asset server and decorate only a
// response whose BODY came from a static asset, which is why `/mcp` carries
// none of them despite being a `run_worker_first` path. This route is
// on-demand for the same reason `/mcp` is -- astro build writes no file for
// it -- so a `public/_headers` rule here would have no asset response to
// attach to.
export const prerender = false;

export const GET: APIRoute = async ({ request }) => serverCardResponse(SITE_ORIGIN, request);

// The MCP origin's branch (workers/mcp/src/index.ts) matches `/mcp/server-card`
// on pathname alone and answers its own OPTIONS with the same four
// Access-Control headers below; Astro's endpoint runtime has no such
// fallback -- a route that exports only `GET` returns a bare 404 with no
// headers for any other method, `OPTIONS` included. Without this export, a
// browser-resident client sending a non-safelisted header (`If-None-Match`,
// to revalidate) would preflight successfully against mcp.ryanlindsey.me and
// fail against this origin with a CORS error `fetch()` cannot recover from,
// which is exactly the divergence the header comment above says running one
// helper on both origins eliminates. The 200s match because both origins
// call that one helper; method handling, including this, is per-route and
// does not come from it -- SERVER_CARD_CORS_HEADERS is shared so the two
// origins' preflight responses and the 200 cannot drift on the values
// themselves.
export const OPTIONS: APIRoute = async () =>
  new Response(null, { status: 204, headers: SERVER_CARD_CORS_HEADERS });
