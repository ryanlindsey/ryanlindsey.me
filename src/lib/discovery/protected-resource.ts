import { SCOPES, type Scope } from '../tier/token';

export interface ProtectedResourceMetadata {
  resource: string;
  scopes_supported: Scope[];
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
 * `resourceUrl` is the caller's to supply rather than something this function
 * infers, for the same two reasons every builder in this directory gives: the
 * site and the MCP Worker's vanity domain each serve a copy of this document,
 * and `request.url` reads as a loopback address under `createTestHarness`
 * rather than the real custom domain.
 */
export function buildProtectedResource(resourceUrl: string): ProtectedResourceMetadata {
  return {
    resource: resourceUrl,
    // DERIVED from SCOPES rather than written out, so a scope added to the
    // closed set cannot quietly skip this document -- and filtered rather than
    // sliced, so reordering SCOPES cannot silently change what is published.
    // `evals` is withheld: its own comment in ../tier/token.ts says a scoped
    // grant is this repo's mechanism for exposing something without publishing
    // that it exists, and naming it to anonymous callers would undo that.
    scopes_supported: SCOPES.filter((scope) => scope !== 'evals'),
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://ryanlindsey.me/auth.md',
  };
}
