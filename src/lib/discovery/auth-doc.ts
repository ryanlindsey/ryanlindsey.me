import { PUBLIC_SCOPES } from '../tier/token';

/**
 * The private-tier paragraph, verbatim from `PRIVATE_ACCESS_TEXT`
 * (workers/mcp/src/tools.ts) -- that string's own comment calls it 03 §2's
 * single most delicate string in the repo, reviewed neutral wording that
 * tests/mcp-tools.test.ts asserts as a whole. `auth.md` reuses it rather
 * than paraphrasing it for the same reason `request_private_access` returns
 * it unmodified: a second hand-written version of a reviewed sentence is a
 * second thing that can drift out of review, and the whole point of
 * reviewing it once was to stop that.
 *
 * Not imported: `PRIVATE_ACCESS_TEXT` is an unexported module-local constant
 * on the MCP Worker, and tests/mcp-tools.test.ts already keeps its own copy
 * for the same structural reason -- this file and that Worker are built and
 * deployed separately, and the string is short enough that a literal copy,
 * with this comment naming its source, is more honest than a cross-Worker
 * import would be.
 */
const PRIVATE_ACCESS_TEXT =
  'Some material on this site is served to scoped tokens rather than published: ' +
  'reference contacts, engagement logistics, and the unredacted layer of a few case ' +
  'studies. This is an ordinary access tier, not a waiting list. Email ' +
  'hello@ryanlindsey.me with who you are and what you are evaluating, and Ryan will ' +
  'issue a scoped, expiring token if it fits. Public tools cover the portfolio in full.';

/**
 * `auth.md`, the human- and agent-readable companion to
 * `/.well-known/oauth-protected-resource` (RFC 9728 names the metadata
 * document; it does not require prose alongside it, and this repo writes
 * the prose anyway because the metadata alone cannot say WHY there is no
 * authorization server, only that there is not one).
 *
 * The scope list is DERIVED from `PUBLIC_SCOPES` (../tier/token.ts), same
 * discipline as ./protected-resource.ts and for the same reason: `evals` must
 * not appear in a document served to anonymous callers (see that scope's own
 * comment in ../tier/token.ts), and deriving rather than typing the names out
 * means a sixth scope added to the closed set cannot silently go unlisted
 * here while `evals` cannot silently leak in. `PUBLIC_SCOPES` used to be a
 * filter written out independently in this file and in
 * ./protected-resource.ts -- two copies of the epic's highest-stakes
 * invariant with nothing tying them together. It is now derived once, there,
 * and both files import it.
 */
export function buildAuthDoc(): string {
  const scopeList = PUBLIC_SCOPES.map((scope) => `- \`${scope}\``).join('\n');

  // `# auth.md`, lowercase, matching the filename -- do not "fix" the
  // capitalization. The canonical auth.md protocol
  // (github.com/workos/auth.md) opens its own document with exactly this
  // heading, and the epic's own acceptance scanner (isitagentready.com,
  // verified against production 2026-09-14) checks for it literally: a
  // different heading, however reasonable, reads to that scanner as a
  // missing document and fails the check. This used to open
  // `# Authorization`, which read fine to a person and failed exactly that.
  return `# auth.md

Most of this corpus needs no credential at all. An MCP client that connects to \`https://mcp.ryanlindsey.me/mcp\` with no \`Authorization\` header reaches the public tier: the résumé, every published case study and post, semantic search over that corpus, and a tool that explains how to reach Ryan. Every result cites a URL a browser can open on its own, and nothing served at this tier depends on holding a token.

${PRIVATE_ACCESS_TEXT}

## Scopes

A token carries one or more of these scopes:

${scopeList}

## No self-service registration

There is no authorization server behind this endpoint and no self-service registration endpoint. A token is minted by hand, after the email above, and handed to one person; nothing here issues one automatically. The machine-readable description of what this endpoint accepts lives at \`/.well-known/oauth-protected-resource\`, on this origin and on the MCP endpoint's own origin.
`;
}
