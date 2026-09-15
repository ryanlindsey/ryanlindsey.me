import { DISCOVERY_VERSION } from './version';

export interface McpServerCard {
  serverInfo: { name: string; version: string };
  description: string;
  url: string;
  transport: { type: 'streamable-http' };
  capabilities: { tools: boolean; resources: boolean };
}

/**
 * The MCP Server Card (SEP-1649), the shape the agent-readiness scanner reads
 * and `/.well-known/mcp.json` predates.
 *
 * `origin` is the caller's to supply, for the same two reasons
 * src/lib/mcp/discovery.ts gives: the site and the MCP Worker's vanity domain
 * each serve this document describing THEMSELVES and neither can derive the
 * other's hostname, and under `createTestHarness` `request.url` reads as a
 * loopback address rather than the real custom domain.
 *
 * `resources: true` is a fact, not an aspiration: workers/mcp/src/resources.ts
 * registers two through `defineResource`.
 */
export function buildMcpServerCard(origin: string): McpServerCard {
  return {
    serverInfo: { name: 'ryanlindsey-me', version: DISCOVERY_VERSION },
    description: "Ryan Lindsey's professional corpus, exposed as MCP tools.",
    url: `${origin}/mcp`,
    transport: { type: 'streamable-http' },
    capabilities: { tools: true, resources: true },
  };
}
