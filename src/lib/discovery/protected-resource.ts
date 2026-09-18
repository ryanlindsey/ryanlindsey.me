import { PUBLIC_SCOPES, type Scope } from '../tier/token';

export interface ProtectedResourceMetadata {
  resource: string;
  scopes_supported: readonly Scope[];
  bearer_methods_supported: ['header'];
  resource_documentation: string;
}

/**
 * RFC 9728 protected-resource metadata for the MCP endpoint.
 *
 * `authorization_servers` IS DELIBERATELY ABSENT, and RFC 9728 makes it
 * optional. There is no authorization server: tokens are HMAC-signed and
 * minted by hand through scripts/token.mjs, then issued out of band by email.
 * Any value here would name an endpoint that 404s, which is the one thing this
 * whole surface exists not to do. Do not "complete" this document by adding it.
 *
 * This does not contradict `authentication: 'none'` in src/lib/mcp/discovery.ts.
 * That field says what the advertised endpoint REQUIRES, which is nothing --
 * every tool a caller gets without a token is served without one. This document
 * says what the endpoint ACCEPTS. Both are true at once, and
 * tests/discovery-auth.test.ts pins the pair so the next reader who spots the
 * apparent conflict finds the answer instead of "fixing" one of them.
 *
 * `origin`, NOT A FULL RESOURCE URL, is the caller's to supply -- the same
 * origin-as-argument contract every builder in this directory follows, for
 * the two reasons src/lib/mcp/discovery.ts's own header gives: the site and
 * the MCP Worker's vanity domain each serve their own copy of this document,
 * and `request.url` reads as a loopback address under `createTestHarness`
 * rather than the real custom domain. This function used to take the whole
 * `resource` string instead, hard-coded identically to
 * `https://mcp.ryanlindsey.me/mcp` at both call sites, on the reasoning that
 * both documents describe the "same" resource. A production scan
 * (isitagentready.com, checked 2026-09-14) caught that this reasoning is
 * backwards under RFC 9728 §2: a client validates that `resource` identifies
 * the resource server it fetched THIS document from, so a document that
 * names `mcp.ryanlindsey.me` while being served from `ryanlindsey.me` is
 * self-inconsistent, not merely redundant. Each origin's copy now names its
 * own `/mcp` -- true independently of the other, because the site really
 * does serve `/mcp` too, forwarded by the `MCP` service binding.
 */
export function buildProtectedResource(origin: string): ProtectedResourceMetadata {
  return {
    resource: `${origin}/mcp`,
    // PUBLIC_SCOPES (../tier/token.ts) rather than SCOPES, so a PUBLIC scope
    // added to the closed set cannot quietly skip this document. Two scopes are
    // withheld rather than one (`evals` since day 6, `authoring` since epic
    // 263): each one's comment in ../tier/token.ts makes the same argument,
    // that a scoped grant is this repo's mechanism for exposing something
    // without publishing that it exists, and naming it to anonymous callers
    // would undo that. That withholding used to be a filter written out here
    // AND, independently, in ./auth-doc.ts -- two expressions of the epic's
    // highest-stakes invariant with nothing tying them together. PUBLIC_SCOPES
    // is now the one place either can drift from.
    scopes_supported: PUBLIC_SCOPES,
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://ryanlindsey.me/auth.md',
  };
}
