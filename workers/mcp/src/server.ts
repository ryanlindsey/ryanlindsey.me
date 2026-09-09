import { McpServer } from '@modelcontextprotocol/server';
import type { Grant, GrantRefusal } from '../../../src/lib/tier/grant';
import { SCOPES, type Scope } from '../../../src/lib/tier/token';
import { defineTool, type ToolContext } from './define';
import { registerGatedTools } from './gated';
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
 * The tool map a GRANTED connection is sent, keyed by the scope that unlocks
 * each group rather than written out as one fixed list.
 *
 * 03 §1 asks for exactly this -- per-token MCP `initialize` instructions that
 * enumerate the tools the grant unlocks.
 *
 * WHAT THIS STRUCTURE GUARANTEES, AND WHAT IT DOES NOT, because the difference
 * is easy to overclaim and a comment that overclaims it is worse than none.
 * Driving the map off the same `scopes` array that decided registration means
 * the SCOPE SET cannot disagree: a scope the grant lacks contributes no lines,
 * so no caller is ever told about a group of tools their token did not open.
 * That much is structural.
 *
 * The tool NAMES inside each array are a hand-maintained duplicate of
 * ./gated.ts, and nothing detects a mismatch between them. Rename a tool there
 * and forget this table, and a granted caller is handed a map naming a tool
 * `tools/list` does not contain -- which is exactly the failure the structure
 * above prevents at the coarser grain, at the finer grain still possible.
 * tests/mcp-gated.test.ts pins the profile group's three lines against the
 * profile grant's own listing, which catches the case that matters most; it is
 * a spot check, not a proof, and a general one would mean deriving these lines
 * from the registrations themselves.
 */
const SCOPE_LINES: Record<Scope, string[]> = {
  profile: [
    'get_availability: current working status and engagement timing.',
    'get_references: reference contacts and the context for each.',
    'get_compensation_expectations: compensation range and structure preferences.',
  ],
  documents: ['get_case_study_details: the unredacted layer of one case study, by slug.'],
  narrative: ["get_application_narrative: the narrative written for this token's audience."],
  fit: [], // Task 11 fills this in with `analyze_fit`.
};

/**
 * What one connection is told it has.
 *
 * Three states, and the first is the one with a test on it: NO token at all
 * gets `PUBLIC_INSTRUCTIONS` byte for byte, which is what
 * tests/mcp.smoke.test.ts asserts and what keeps the private tier absent from
 * an unauthenticated handshake. A REFUSED token gets one added sentence. A
 * grant gets the map of what its scopes opened.
 *
 * `SCOPES` orders the map rather than `grant.scopes` doing it, so two tokens
 * carrying the same scopes in a different order are told the same thing.
 */
export function buildInstructions(grant: Grant | null, refusal: GrantRefusal | null): string {
  if (grant === null) {
    return refusal === null ? PUBLIC_INSTRUCTIONS : `${PUBLIC_INSTRUCTIONS}\n\n${REFUSED_LINE}`;
  }
  const granted = SCOPES.filter((scope) => grant.scopes.includes(scope)).flatMap(
    (scope) => SCOPE_LINES[scope],
  );
  const header = `This connection carries a scoped token for the audience "${grant.audience}".`;
  // A grant that opens NO tool in this build still gets the header, and gets
  // it without the colon. `SCOPE_LINES.fit` is empty until Task 11 registers
  // `analyze_fit`, so a `fit`-only token minted before then would otherwise be
  // sent "It also has:" followed by nothing at all -- a dangling colon on the
  // one surface whose job is to tell a holder what their token is for, which
  // reads as a broken server rather than as an unfinished build. The header
  // itself is kept because it is true and useful: it confirms the token WAS
  // accepted, which is the other half of what the refusal line above says.
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
    { name: 'ryanlindsey-me', version: '1.5.0' }, // x-release-please-version
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
