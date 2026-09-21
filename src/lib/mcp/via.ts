/**
 * The header the site Worker adds when it forwards `/mcp` to the MCP Worker
 * over the service binding, so the MCP Worker can tell a forwarded request
 * from one that arrived at mcp.ryanlindsey.me directly.
 *
 * WHY THE MCP WORKER DOES NOT SIMPLY RECORD EVERY REQUEST. src/worker.ts
 * writes one Analytics Engine row per request the SITE serves, outside every
 * branch, and a forwarded `/mcp` is one of those. MEASURED 2026-09-20: a
 * request to mcp.ryanlindsey.me/mcp, the address every discovery document
 * publishes, wrote a D1 audit row per tool call and no Analytics Engine row
 * at all, so /ops's traffic panels had never seen the one surface this site
 * exists to expose. Recording every request on the MCP side would fix that
 * by counting every proxied request twice.
 *
 * WHY A HEADER AND NOT THE ORIGIN. A service binding delivers the request
 * with its URL untouched, so the origin says where the CLIENT addressed it,
 * and under the test harness the site's origin is whatever port workerd
 * picked rather than SITE_ORIGIN. A comparison against that variable would
 * pass in production and double count under the suite, which is the one
 * place the double count would ever be measured. A client that forges this
 * header removes itself from a count and gains nothing else.
 */
export const VIA_SITE_HEADER = 'x-rlme-via';
export const VIA_SITE_VALUE = 'site';

export function forwardedBySite(request: Request): boolean {
  return request.headers.get(VIA_SITE_HEADER) === VIA_SITE_VALUE;
}

/** The same request, URL and body untouched, carrying the via header. */
export function markForwardedBySite(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set(VIA_SITE_HEADER, VIA_SITE_VALUE);
  return new Request(request, { headers });
}
