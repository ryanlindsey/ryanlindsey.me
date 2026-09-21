/**
 * The official MCP Registry entry for this server, built rather than
 * committed. `scripts/registry-publish.mjs` writes it to a temporary
 * `server.json` at publish time, and src/lib/discovery/server-card-v1.ts
 * reads this same builder for the SEP-2127 card, so the two cannot disagree
 * and there is no third copy of the version for release-please to keep in
 * step.
 *
 * Shape: static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json,
 * read 2026-09-20. `name`, `description` and `version` are required;
 * `remotes` is what makes this a remote listing; there is no `packages`
 * member because there is nothing to install. The registry's own docs
 * (registry/remote-servers, last changed 2026-09-05) still name the
 * 2025-12-11 schema as current.
 *
 * THE NAMESPACE IS THE DOMAIN, REVERSED. `me.ryanlindsey/...` is what the
 * registry's domain authentication binds a proof at ryanlindsey.me to; the
 * `io.github.<user>` alternative was rejected because a closed registry
 * issue (#494) shows a validator once refusing that namespace for a remote
 * whose host was not `<user>.github.io`, and nothing confirms the current
 * behavior either way. The server part matches `serverInfo.name`.
 *
 * THIS FILE IMPORTS NOTHING, and that is load-bearing. scripts/registry-
 * publish.mjs imports it under Node's type stripping, which strips types
 * and resolves nothing: a relative import with no extension fails there,
 * which is why src/lib/tier/token.ts, the file scripts/token.mjs imports the
 * same way, has no imports either. So the version is an argument (the script
 * reads package.json, which tests/discovery-server-card.test.ts pins to
 * DISCOVERY_VERSION; the card passes DISCOVERY_VERSION itself), and the two
 * URLs are literals that tests/discovery-registry.test.ts pins to
 * `MCP_ORIGIN` and `SITE_ORIGIN`.
 *
 * `description` is a client-readable string under 09 §2's vocabulary rule and
 * is asserted equal to the SEP-1649 card's, so there is one sentence to
 * review rather than two.
 */
export const REGISTRY_SERVER_NAME = 'me.ryanlindsey/ryanlindsey-me';
export const REGISTRY_REMOTE_URL = 'https://mcp.ryanlindsey.me/mcp';
export const REGISTRY_WEBSITE_URL = 'https://ryanlindsey.me';
export const REGISTRY_DESCRIPTION = "Ryan Lindsey's professional corpus, exposed as MCP tools.";

export interface RegistryEntry {
  $schema: string;
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  repository: { url: string; source: string };
  remotes: { type: 'streamable-http'; url: string }[];
}

export function buildRegistryEntry(version: string): RegistryEntry {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: REGISTRY_SERVER_NAME,
    title: 'Ryan Lindsey',
    description: REGISTRY_DESCRIPTION,
    version,
    websiteUrl: REGISTRY_WEBSITE_URL,
    repository: { url: 'https://github.com/ryanlindsey/ryanlindsey.me', source: 'github' },
    remotes: [{ type: 'streamable-http', url: REGISTRY_REMOTE_URL }],
  };
}
