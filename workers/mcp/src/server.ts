import { McpServer } from '@modelcontextprotocol/server';
import type { Grant, GrantRefusal } from '../../../src/lib/tier/grant';
import { defineTool, type ToolContext } from './define';
import { gatedToolLines, registerGatedTools } from './gated';
import { registerResources } from './resources';
import { registerTools } from './tools';

/**
 * Sent on every `initialize` (03 §1), so this is a tool MAP rather than
 * prose on purpose: tests/mcp.smoke.test.ts's "the instructions name every
 * registered tool" enumerates `tools/list` at runtime and fails the moment a
 * later task adds a tool without a matching line here.
 *
 * 03 §1's ~1200-character budget is THIS string's, and saying which string it
 * governs matters now that there is more than one. Measured 2026-09-08: this
 * constant is 922 characters, and the instructions a grant carrying all four
 * scopes is sent are 1364. The larger number is not an overrun to trim: the
 * budget describes what every client is sent on an unauthenticated connect,
 * and a per-token map that enumerates the tools a grant unlocked is the whole
 * point of `buildInstructions` below. Keep THIS one under the budget; let the
 * granted one be as long as the grant makes it. The two `resume://json` /
 * `writing://{slug}` resources get their own line for the same reason
 * `/llms.txt`'s MCP description (src/pages/llms.txt.ts) names both: two texts
 * describing the same server should not disagree about what it serves.
 *
 * Candidacy-language discipline (09 §2/§4) applies to this string exactly as
 * it does to `request_private_access`'s copy in ./tools.ts: never `hire`,
 * `candidate`, `job-search`, `recruiter`. The vocabulary here is *audience
 * tiers*, *private tier*, *scoped tokens*.
 *
 * ASSERTED VERBATIM in tests/mcp.smoke.test.ts, and day 5 kept it that way on
 * purpose: an untokened connection is served exactly this string and nothing
 * appended, so the private tier is invisible in the handshake as well as in
 * `tools/list`. Everything day 5 adds is in `buildInstructions` below, which
 * reaches this constant only through the branches a token opens.
 */
const PUBLIC_INSTRUCTIONS = [
  "Ryan Lindsey's professional corpus, exposed as MCP tools across audience tiers.",
  '',
  'get_contact: how to reach Ryan, and his working timezone.',
  'get_resume: JSON Resume, published markdown, or a short prose summary.',
  'list_case_studies: published case studies with descriptions and citation URLs.',
  'get_case_study: full markdown of one case study, by slug.',
  'list_writing: published posts with descriptions and citation URLs.',
  'get_post: full markdown of one post, by slug.',
  'search_writing: semantic search over the corpus; each result is a passage with a real, fetchable citation URL.',
  'request_private_access: explains the private tier and how to request a scoped token.',
  '',
  'Two MCP resources serve the same documents for clients that prefer resource attachment over tool calls: resume://json and writing://{slug}.',
  '',
  'A private tier exists beyond these public tools, for scoped tokens; call request_private_access to learn how to request one.',
].join('\n');

/**
 * The line a caller sees when they presented a token that was not honoured.
 *
 * Deliberately unspecific. A revocation drill (09 §3 item 6) needs to be able
 * to OBSERVE that a revoked token stopped working, which this provides; a
 * stranger probing for valid tokens must learn nothing about which of
 * expired, revoked, unknown or forged they hit, which naming the reason would
 * hand them. One sentence serves both.
 */
const REFUSED_LINE =
  'The scoped token presented with this request was not accepted; the public tools below are what this connection has.';

/**
 * What one connection is told it has.
 *
 * Three states, and the first is the one with a test on it: NO token at all
 * gets `PUBLIC_INSTRUCTIONS` byte for byte, which is what
 * tests/mcp.smoke.test.ts asserts and what keeps the private tier absent from
 * an unauthenticated handshake. A REFUSED token gets one added sentence. A
 * grant gets the map of what its scopes opened.
 *
 * 03 §1 asks for exactly that -- per-token MCP `initialize` instructions
 * enumerating the tools the grant unlocks -- and `gatedToolLines` (./gated.ts)
 * is where the enumeration comes from. THAT IS THE POINT, and it is worth
 * saying what it replaced: this module used to keep its own table of tool
 * names per scope, parallel to the registrations in ./gated.ts and checked by
 * nothing. Renaming a gated tool there and forgetting the table here handed
 * every granted caller a map naming a tool `tools/list` does not carry --
 * silently, on the one surface whose job is to tell a holder what their token
 * is for. There is one list now, it lives beside the registrations, and this
 * function's whole contribution is the framing around it.
 */
export function buildInstructions(grant: Grant | null, refusal: GrantRefusal | null): string {
  if (grant === null) {
    return refusal === null ? PUBLIC_INSTRUCTIONS : `${PUBLIC_INSTRUCTIONS}\n\n${REFUSED_LINE}`;
  }
  const granted = gatedToolLines(grant);
  const header = `This connection carries a scoped token for the audience "${grant.audience}".`;
  // A grant that opens NO tool still gets the header, and gets it without the
  // colon. Every scope opens a tool in this build, so the state is now reached
  // by a grant carrying NO scope -- which is not hypothetical: a grant's scopes
  // come from its REGISTRY ROW rather than from its claim (src/lib/tier/grant.ts),
  // so narrowing a live token to nothing is one operator edit away, and it is
  // the natural shape of a soft revoke. Such a caller would otherwise be sent
  // "It also has:" followed by nothing at all -- a dangling colon that reads as
  // a broken server rather than as a shut door. The header itself is kept
  // because it is true and useful: it confirms the token WAS accepted, which is
  // the other half of what the refusal line above says.
  if (granted.length === 0) return [PUBLIC_INSTRUCTIONS, '', header].join('\n');
  return [PUBLIC_INSTRUCTIONS, '', `${header} It also has:`, '', ...granted].join('\n');
}

/**
 * The server one HTTP request is served by.
 *
 * `instructions` belongs to ServerOptions (the second argument), not to the
 * Implementation identity. Passing it here is also what puts it at the top
 * level of the initialize result, where the spec and clients look for it.
 * The `x-release-please-version` marker is load-bearing: release-please's `generic` updater
 * rewrites the semver on any line carrying it, which is what keeps the version this server
 * advertises over MCP in step with package.json. Moving the version off this line, or letting
 * a formatter split it across lines, silently strands it at whatever it says today. The path
 * release-please looks in is `extra-files` in release-please-config.json, and it names THIS
 * file -- moving this line to another one means editing that entry in the same commit.
 *
 * `refusal` defaults to `null` so every existing call site keeps its meaning
 * ("no token was presented"). ./index.ts passes the real value, and that
 * parameter is the ONLY way a refusal becomes visible to the caller rather
 * than only to the operator log.
 */
export function createServer(tc: ToolContext, refusal: GrantRefusal | null = null): McpServer {
  const server = new McpServer(
    { name: 'ryanlindsey-me', version: '1.10.0' }, // x-release-please-version
    { instructions: buildInstructions(tc.grant, refusal) },
  );

  defineTool(
    server,
    tc,
    {
      name: 'get_contact',
      title: 'Contact details',
      description: 'How to reach Ryan Lindsey, and his working timezone.',
      // No `inputSchema`: this tool takes no arguments, and the empty-object
      // form resolves to the deprecated raw-shape overload.
      cost: 'cheap',
    },
    async () => ({
      email: 'hello@ryanlindsey.me',
      site: 'https://ryanlindsey.me',
      timezone: 'America/Los_Angeles',
    }),
  );

  registerTools(server, tc);
  // The private tier (03 §2). A no-op without a grant -- and a no-op is
  // stronger than a refusal here: the tools are not registered, so there is
  // no name in `tools/list` and nothing for `tools/call` to reach.
  registerGatedTools(server, tc);
  // The same documents, for clients that prefer resource attachment over tool
  // calls (03 §2). Registered through `defineResource`, which limits and
  // audits a read exactly as `defineTool` does a call. NOT per grant, and
  // never per grant: see that module's own comment for why day 5's answer to
  // the `resources/list` hole was to add no gated resource at all.
  registerResources(server, tc);

  return server;
}
