import type { APIRoute } from 'astro';
import { buildAiCatalog } from '../../lib/discovery/ard';
import { SITE_ORIGIN } from '../../lib/markdown-export';

// Prerendered, for the reason src/pages/.well-known/mcp.json.ts gives at
// length: a pure function of a literal origin known at build time.
export const prerender = true;

// THE SAME DOCUMENT AS ai-catalog.json, UNDER THE NAME ARD v0.91 READS.
// ards-project/ard-spec §5.1 (2026-08-26, read 2026-09-20): a consumer "MUST
// fetch /.well-known/ard.json", and consulting the predecessor name
// ai-catalog.json is "a courtesy ... not a conformance requirement". ARD reads
// only `entries` and ignores other top-level members, and its two further
// requirements, a mandatory displayName and representativeQueries, are already
// on every entry, so the bytes are identical and tests/discovery-catalog.test.ts
// asserts they stay so. Both names are served because SEP-2127 and the AI
// Catalog spec still use the old one.
//
// Neither header below survives `astro build` -- public/_headers is what
// actually ships them. ARD names no media type for this file, so it takes
// the generic JSON type this repository uses for a document with no
// registered one, plus the CORS header ai-catalog.json carries and for the
// same reason.
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(buildAiCatalog(SITE_ORIGIN), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
