import { ADVERTISED_SURFACE } from './surface';

export interface ArdHost {
  name: string;
  url: string;
}

interface ArdEntryFields {
  id: string;
  displayName: string;
  type: string;
  representativeQueries: string[];
}

/**
 * An ARD entry describes ONE resource, reached either by fetching a `url` or
 * by reading `data` inline. Every entry `buildAiCatalog` emits chooses `url`,
 * because every member of `ADVERTISED_SURFACE` is a live HTTP resource this
 * site already serves -- there is no static value worth inlining instead.
 * The `data` arm stays in the type rather than being deleted, because it is
 * part of what an ARD entry IS, not a hypothetical this site might grow into;
 * deleting it would describe a narrower format than the one this document
 * claims to speak. tests/discovery-catalog.test.ts's "exactly one of url or
 * data" pins the union rather than trusting this comment.
 */
export type ArdEntry = (ArdEntryFields & { url: string }) | (ArdEntryFields & { data: unknown });

export interface ArdManifest {
  specVersion: string;
  host: ArdHost;
  entries: ArdEntry[];
}

/**
 * `/.well-known/ai-catalog.json`, this site's ARD (AI-Readable Data) manifest
 * -- the same surface `buildApiCatalog` describes in RFC 9727's vocabulary,
 * described again in the ARD specification's own vocabulary. ONE list feeds
 * both builders (`./surface.ts`), so the two documents cannot drift the way
 * two hand-maintained copies would the first time an endpoint moved.
 *
 * Each entry's `id` is a URN, `urn:air:ryanlindsey.me:<namespace>:<name>`.
 * The site name inside it is a literal rather than derived from `origin`,
 * deliberately: a URN names a resource independent of where it is currently
 * reachable, the way `ADVERTISED_SURFACE`'s `namespace`/`name` pair names an
 * endpoint independent of which origin's copy of this document is being
 * read. `host`, by contrast, DOES vary with `origin`, because it answers a
 * different question: who is serving this particular copy.
 *
 * `origin` is the caller's to supply, for the two reasons every builder in
 * this directory gives (see src/lib/mcp/discovery.ts's own header): the site
 * and the MCP Worker's vanity domain each serve documents describing
 * themselves and neither can derive the other's hostname, and under
 * `createTestHarness` `request.url` reads as a loopback address rather than
 * the real custom domain.
 */
export function buildAiCatalog(origin: string): ArdManifest {
  return {
    // `specVersion` names the version of THIS DOCUMENT FORMAT, not this
    // site's software -- it is deliberately not `DISCOVERY_VERSION`
    // (./version.ts), which tracks the release the MCP server advertises and
    // has nothing to do with how an ARD manifest is shaped. There is no
    // pinned external ARD schema this repository builds against to cite a
    // version from, so '1.0.0' is not a citation of one -- it is this
    // manifest's own starting value, to be bumped here if the shape below
    // ever changes in a way a reader would need to detect.
    specVersion: '1.0.0',
    // `host.name` identifies the Worker serving this document, not the
    // person -- same value as `wrangler.jsonc`'s own `name` field and
    // `server-card.ts`'s `serverInfo.name`, both of which are the site
    // Worker's name regardless of which origin's copy of a document is being
    // read (see that file's comment for why an identity string is a literal
    // rather than derived from `origin`). `host.url`, unlike `host.name`,
    // DOES vary with `origin`, for the reason this function's own docstring
    // gives.
    host: { name: 'ryanlindsey-me', url: origin },
    entries: ADVERTISED_SURFACE.map((endpoint) => ({
      id: `urn:air:ryanlindsey.me:${endpoint.namespace}:${endpoint.name}`,
      displayName: endpoint.displayName,
      type: endpoint.mediaType,
      url: `${origin}${endpoint.path}`,
      representativeQueries: endpoint.representativeQueries,
    })),
  };
}
