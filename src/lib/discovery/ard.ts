import { ADVERTISED_SURFACE } from './surface';

/**
 * Pinned against `ards-project/ard-spec`'s `ai-catalog.schema.json`
 * (`$defs.ai-catalog.schema.json#/properties/host`, fetched and read
 * directly on 2026-09-14, not paraphrased): `host` is `additionalProperties:
 * false` with `displayName` its only required field. `identifier` (a
 * verifiable host identity, typically a `did:web:` DID per that schema's own
 * conformance examples) and `documentationUrl` are both optional and both
 * absent here on purpose -- this site publishes no DID document a caller
 * could resolve `identifier` against, and there is no general documentation
 * page at either origin's bare root for `documentationUrl` to name (`GET /`
 * on the MCP origin is a genuine 404; see src/pages/llms.txt.ts's own note on
 * the site side). Publishing either would be exactly the failure mode the
 * epic's global constraints warn about: a field that claims a capability
 * (verifiable identity, documentation) this site does not actually have.
 *
 * `url` used to live here instead, carrying which origin served this
 * particular copy -- REMOVED, not renamed: the real schema has no field for
 * that at all (`additionalProperties: false` rejects an unrecognised key
 * outright), so there is nowhere in a conformant `host` object for that fact
 * to live. It is not lost information; a caller who wants to know which
 * origin served this copy already knows, because they are the one who
 * fetched it from there.
 */
export interface ArdHost {
  displayName: string;
}

interface ArdEntryFields {
  identifier: string;
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
 * ai-catalog.io/guides/serving-your-catalog, read 2026-09-20: "Serve the
 * file over HTTPS with the Content-Type header: application/ai-catalog+json".
 * The site served `application/json` from #168 until 2026-09-20 because the
 * type had not been checked against the spec. No charset, for the reason the
 * linkset rule in public/_headers gives: a `+json` type is registered without
 * one. IANA has neither this type nor the `ai-catalog` relation registered
 * as of 2026-09-20; the spec's IANA Considerations section requests both.
 */
export const AI_CATALOG_MEDIA_TYPE = 'application/ai-catalog+json';

/**
 * `/.well-known/ai-catalog.json`, this site's ARD (AI-Readable Data) manifest
 * -- the same surface `buildApiCatalog` describes in RFC 9727's vocabulary,
 * described again in the ARD specification's own vocabulary. ONE list feeds
 * both builders (`./surface.ts`), so the two documents cannot drift the way
 * two hand-maintained copies would the first time an endpoint moved.
 *
 * Each entry's `identifier` is a URN, `urn:air:ryanlindsey.me:<namespace>:<name>`
 * -- named `identifier` because that is the field name
 * `ards-project/ard-spec`'s schema actually requires (see this function's
 * own `specVersion` comment below); it used to be `id` here, which is why
 * every entry failed schema validation until the epic-165 follow-up review's
 * second wave caught it against a real scan. The site name inside the URN is
 * a literal rather than derived from `origin`, deliberately: a URN names a
 * resource independent of where it is currently reachable, the way
 * `ADVERTISED_SURFACE`'s `namespace`/`name` pair names an endpoint
 * independent of which origin's copy of this document is being read.
 *
 * `host`, unlike an entry's `url`, does NOT vary with `origin` -- it used to,
 * carrying which origin served this copy, but the real schema's `host`
 * object has no field for that (see `ArdHost`'s own comment). `origin` is
 * still this function's argument regardless, because every entry's own `url`
 * does need it, for the two reasons every builder in this directory gives
 * (see src/lib/mcp/discovery.ts's own header): the site and the MCP Worker's
 * vanity domain each serve documents describing themselves and neither can
 * derive the other's hostname, and under `createTestHarness` `request.url`
 * reads as a loopback address rather than the real custom domain.
 */
export function buildAiCatalog(origin: string): ArdManifest {
  return {
    // PINNED, not chosen: `ards-project/ard-spec`'s `ai-catalog.schema.json`
    // (fetched and read directly 2026-09-14, not assumed) declares
    // `specVersion` an enum of exactly one allowed value, `"1.0"`. This used
    // to read `'1.0.0'`, on the reasoning that there was no pinned external
    // schema to cite a version from and this was the manifest's own starting
    // value -- that reasoning was wrong the day it was written (a real,
    // versioned schema existed and was never checked against), and a
    // production scan (isitagentready.com) is what surfaced the mismatch.
    specVersion: '1.0',
    // `ArdHost`'s own comment explains why this is `displayName` alone, with
    // no `identifier` or `documentationUrl`: this site has neither a
    // resolvable DID document nor a general documentation page to name
    // truthfully in either field. The value matches `wrangler.jsonc`'s own
    // `name` field and `server-card.ts`'s `serverInfo.name`, both of which
    // identify the Worker serving this document (not the person) regardless
    // of which origin's copy is being read.
    host: { displayName: 'ryanlindsey-me' },
    entries: ADVERTISED_SURFACE.map((endpoint) => {
      // The descriptor when there is one (./surface.ts says why): SEP-2127 has
      // the MCP entry point at the server card, not the endpoint.
      //
      // `'descriptor' in endpoint`, not `endpoint.descriptor?.`. ./surface.ts
      // closes with `as const satisfies`, so ADVERTISED_SURFACE's element type
      // is a UNION of one literal object type per entry, and only the member
      // carrying a descriptor declares the property at all -- optional-chaining
      // straight off the union is ts(2339) on the other seven, which `npm test`
      // would never have told us (it does not typecheck). An `in` check narrows
      // the union instead, the same idiom tests/discovery-catalog.test.ts uses
      // to skip the described entries.
      const descriptor = 'descriptor' in endpoint ? endpoint.descriptor : undefined;
      return {
        identifier: `urn:air:ryanlindsey.me:${endpoint.namespace}:${endpoint.name}`,
        displayName: endpoint.displayName,
        type: descriptor?.mediaType ?? endpoint.mediaType,
        url: `${origin}${descriptor?.path ?? endpoint.path}`,
        representativeQueries: endpoint.representativeQueries,
      };
    }),
  };
}
