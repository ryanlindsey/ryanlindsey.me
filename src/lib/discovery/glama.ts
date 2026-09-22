/**
 * The Glama ownership claim, served at /.well-known/glama.json on the MCP
 * origin and only there: glama.ai/mcp/faq (read 2026-09-20) requires the
 * file to "stay on the connector's origin", and the connector is
 * mcp.ryanlindsey.me/mcp. tests/discovery-glama.test.ts asserts the site
 * origin answers 404 for it.
 *
 * The token is opaque and bound to the Glama account, carries no personal
 * information, and is public by design, which is why it is committed. It has
 * to stay published: Glama re-checks it, and a file that disappears starts a
 * seven-day grace period before the claim lapses. A claim does not transfer
 * to a different origin, so a move of the endpoint means claiming again.
 *
 * Why claim at all: Glama is the one directory that documents recurring
 * introspection sweeps against a listed server and gives the claimant health
 * checks and analytics, and it scores tool descriptions, which this server
 * already writes with care.
 *
 * The listing this claims is glama.ai/mcp/connectors/me.ryanlindsey/ryanlindsey-me.
 * Measured 2026-09-21: the registry entry #310 published at 21:49 UTC was
 * already ingested and listed the same day, so the "allow a day" the issue
 * budgeted for Glama's hourly poll was not needed.
 */
export const GLAMA_CLAIM_TOKEN = 'glama_claim_Sd4uSzDA0x7hwNdUHTYfemQB0Kw4oq0c';

export function buildGlamaClaim(): { $schema: string; claim: string } {
  return { $schema: 'https://glama.ai/mcp/schemas/connector.json', claim: GLAMA_CLAIM_TOKEN };
}
