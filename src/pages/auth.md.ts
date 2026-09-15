import type { APIRoute } from 'astro';
import { buildAuthDoc } from '../lib/discovery/auth-doc';

// Static output: `buildAuthDoc()` is a pure function of the closed `SCOPES`
// set, with no request-time data, so this prerenders like every other pure-
// content endpoint on this site (/resume.md, /llms.txt, ...).
export const prerender = true;

// Astro's static build writes only the Response BODY to disk; the header set
// below does not survive into the deployed artifact. Cloudflare's asset
// server already maps `.md` to `text/markdown; charset=utf-8` by default, the
// same default /resume.md.ts relies on with no public/_headers rule of its
// own -- but this file gets an explicit rule anyway (Step 8), for the same
// reason its extensionless sibling above needs one: the two ship together as
// one discovery surface, and an explicit charset here is one fewer thing to
// re-derive if that default mime mapping ever changes.
export const GET: APIRoute = async () =>
  new Response(buildAuthDoc(), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
