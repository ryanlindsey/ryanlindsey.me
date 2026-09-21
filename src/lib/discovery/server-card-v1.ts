import { buildRegistryEntry, type RegistryEntry } from './registry-entry';
import { DISCOVERY_VERSION } from './version';

/**
 * The SEP-2127 MCP Server Card, served at `<streamable-http-url>/server-card`.
 *
 * SEP-1649, the card src/lib/discovery/server-card.ts builds, was closed on
 * 2026-01-26 and continued in SEP-2127 (modelcontextprotocol PR #2127, open,
 * in review as of 2026-09-12). Its extension repository,
 * modelcontextprotocol/experimental-ext-server-card, read 2026-09-20,
 * reserves `GET <streamable-http-url>/server-card`, names the media type
 * `application/mcp-server-card+json`, and says of the well-known location the
 * old card uses that it "adds no value". The old card stays where it is for
 * whoever still reads it; this one is what the AI Catalog entry points at.
 *
 * CARD-ONLY. The README: the v1 shape "intentionally does not include the
 * registry-shaped Server / packages types", and "Server Cards intentionally
 * omit primitive listings (tools, resources, prompts)". So this is the
 * registry entry with `$schema` swapped and no more, and building it from the
 * same source as the registry entry is what keeps the card's consistency
 * rule true: its name, version and description SHOULD NOT contradict
 * `serverInfo` and `server/discover`, and they cannot when they are one
 * value.
 *
 * THE SCHEMA URL RETURNS 404 TODAY. The extension's own JSON Schema requires
 * `$schema` to match `^https://static\.modelcontextprotocol\.io/schemas/v1/
 * server-card\.schema\.json$` exactly, and that path is not published yet;
 * the README's graduation plan says it will be. Measured 2026-09-20. A card
 * citing an unresolvable schema is what every conforming card does until
 * then, and the pattern leaves no other choice.
 *
 * `remotes` names the origin serving THIS copy, for the reason every builder
 * in this directory gives: the site and the MCP Worker's vanity domain each
 * serve documents describing themselves.
 */
export const SERVER_CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
export const SERVER_CARD_SCHEMA_URL =
  'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

export type ServerCardV1 = Omit<RegistryEntry, '$schema'> & { $schema: string };

export function buildServerCardV1(origin: string): ServerCardV1 {
  const { $schema: _registrySchema, ...entry } = buildRegistryEntry(DISCOVERY_VERSION);
  return {
    $schema: SERVER_CARD_SCHEMA_URL,
    ...entry,
    remotes: [{ type: 'streamable-http', url: `${origin}/mcp` }],
  };
}

/**
 * The card as an HTTP response, with the headers docs/discovery.md makes
 * mandatory (the four Access-Control headers) and recommended (an hour of
 * public caching, an ETag, and 304 on a matching If-None-Match). The ETag is
 * the first sixteen hex characters of the body's SHA-256, strong, so two
 * origins' copies differ and a version bump changes it.
 */
export async function serverCardResponse(origin: string, request: Request): Promise<Response> {
  const body = `${JSON.stringify(buildServerCardV1(origin), null, 2)}\n`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const etag = `"${[...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}"`;
  const headers = {
    'Content-Type': SERVER_CARD_MEDIA_TYPE,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag',
    'Cache-Control': 'public, max-age=3600',
    ETag: etag,
  };
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { headers });
}
