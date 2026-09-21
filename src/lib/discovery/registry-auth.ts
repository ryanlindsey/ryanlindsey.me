/**
 * PLACEHOLDER. Issue #310 step 1 is owner-run and has not happened yet, so
 * there is no real Ed25519 public key to paste here. `MCP_REGISTRY_PUBLIC_KEY`
 * below is the sentinel `PLACEHOLDER-AWAITING-ISSUE-310-STEP-1`, deliberately
 * shaped so it cannot be mistaken for a real 44-character base64 key.
 * Landing the real value is three edits, not one: paste the public key
 * issue #310 step 1 generates in place of the sentinel below, delete this
 * placeholder paragraph, and delete the skip on the proof-format test in
 * tests/discovery-registry.test.ts. A guard test in that file fails if
 * either of the last two is left undone.
 *
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
export const MCP_REGISTRY_PUBLIC_KEY = 'PLACEHOLDER-AWAITING-ISSUE-310-STEP-1';

export function buildRegistryAuth(): string {
  return `v=MCPv1; k=ed25519; p=${MCP_REGISTRY_PUBLIC_KEY}`;
}
