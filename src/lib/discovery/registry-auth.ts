/**
 * The public half of the Ed25519 keypair that proves `ryanlindsey.me` to the
 * official MCP Registry, served at /.well-known/mcp-registry-auth. Public by
 * nature; the private half lives in 1Password as `RLME MCP Registry Key` and
 * is read by scripts/registry-publish.mjs through `op run`, never from here.
 *
 * Format: modelcontextprotocol.io/registry/authentication, read 2026-09-20,
 * whose own generator is `openssl pkey -pubout -outform DER | tail -c 32 |
 * base64`. The page specifies no Content-Type for the file; `text/plain` is
 * this repository's choice and public/_headers is what ships it. Measured
 * 2026-09-21 against internal/api/handlers/v0/auth/http.go in
 * modelcontextprotocol/registry: the proof fetcher disables redirects
 * (CheckRedirect returns an error) and TrimSpaces the body, so the route's
 * trailing newline is harmless but a redirect placed in front of this path
 * would break login with no signal anywhere in this repository.
 *
 * An HTTP proof rather than the DNS TXT alternative: it is versioned here,
 * tested by tests/discovery-registry.test.ts, and needs no dashboard change.
 * Rotating the key means a new item in 1Password, a new value here, and a
 * fresh `mcp-publisher login`; entries already published stay published.
 */
export const MCP_REGISTRY_PUBLIC_KEY = 'ozjB/2RV69uKAiDQPpSfXEx6IvXpKK3hQ7EK9sBhFQI=';

export function buildRegistryAuth(): string {
  return `v=MCPv1; k=ed25519; p=${MCP_REGISTRY_PUBLIC_KEY}`;
}
