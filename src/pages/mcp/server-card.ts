import type { APIRoute } from 'astro';
import { serverCardResponse } from '../../lib/discovery/server-card-v1';
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
// public/_headers rule. Adding one would be the second rule setting that
// header on this path, which that file's own header forbids.
export const prerender = false;

export const GET: APIRoute = async ({ request }) => serverCardResponse(SITE_ORIGIN, request);
