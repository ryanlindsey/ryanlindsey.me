import { ADVERTISED_SURFACE } from './surface';

export interface LinksetLink {
  href: string;
  type: string;
}

export interface LinksetEntry {
  anchor: string;
  'service-doc': LinksetLink[];
  'service-desc': LinksetLink[];
}

export interface Linkset {
  linkset: LinksetEntry[];
}

/**
 * `/.well-known/api-catalog`, RFC 9727's API catalog, served as the
 * `application/linkset+json` document RFC 9264 registers for it.
 *
 * One entry per `ADVERTISED_SURFACE` member, anchored at the endpoint itself.
 * Every entry carries the same two relations: `service-doc` at `/llms.txt`,
 * the prose companion every one of these endpoints is already linked from,
 * and `service-desc` at the MCP Server Card
 * (`ryanlindsey/ryanlindsey.me#166`), the one machine-readable description
 * this site actually serves.
 *
 * NO `status` RELATION, on purpose. RFC 9727 offers one and this site has no
 * health endpoint behind any of these eight paths. Adding `/api/health` to
 * satisfy the field would be building a thing to serve a scanner rather than
 * a caller, which is the inversion the epic this issue belongs to (#165)
 * exists to avoid -- see that issue's "Global constraints" section. A missing
 * relation costs a scanner point; a `status` link pointing at a 404 costs the
 * reader's trust in the other seven links beside it.
 *
 * `origin` is the caller's to supply, for the two reasons every builder in
 * this directory gives (see src/lib/mcp/discovery.ts's own header): the site
 * and the MCP Worker's vanity domain each serve documents describing
 * themselves and neither can derive the other's hostname, and under
 * `createTestHarness` `request.url` reads as a loopback address rather than
 * the real custom domain.
 */
export function buildApiCatalog(origin: string): Linkset {
  return {
    linkset: ADVERTISED_SURFACE.map((endpoint) => ({
      anchor: `${origin}${endpoint.path}`,
      'service-doc': [{ href: `${origin}/llms.txt`, type: 'text/plain' }],
      'service-desc': [
        { href: `${origin}/.well-known/mcp/server-card.json`, type: 'application/json' },
      ],
    })),
  };
}
