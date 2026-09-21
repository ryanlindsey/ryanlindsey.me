import type { APIRoute } from 'astro';
import { buildRegistryAuth } from '../../lib/discovery/registry-auth';

// Prerendered, for the reason src/pages/.well-known/mcp.json.ts gives at
// length: a pure function of values known at build time.
export const prerender = true;

// The Content-Type below does not survive `astro build` -- public/_headers is
// what actually ships it. This document is extensionless, so Cloudflare's
// mime lookup has nothing to guess from without that rule, exactly the
// situation src/pages/.well-known/oauth-protected-resource.ts documents.
export const GET: APIRoute = async () =>
  new Response(`${buildRegistryAuth()}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
