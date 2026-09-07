import { McpServer } from '@modelcontextprotocol/server';
import { defineTool, type ToolContext } from './define';
import { registerResources } from './resources';
import { registerTools } from './tools';

/**
 * Sent on every `initialize` (03 §1), so this is a tool MAP rather than
 * prose on purpose: tests/mcp.smoke.test.ts's "the instructions name every
 * registered tool" enumerates `tools/list` at runtime and fails the moment a
 * later task adds a tool without a matching line here. Under ~1200
 * characters, per that same spec section.
 *
 * Candidacy-language discipline (09 §2/§4) applies to this string exactly as
 * it does to `request_private_access`'s copy in ./tools.ts: never `hire`,
 * `candidate`, `job-search`, `recruiter`. The vocabulary here is *audience
 * tiers*, *private tier*, *scoped tokens*.
 */
const INSTRUCTIONS = [
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
  'A private tier exists beyond these public tools, for scoped tokens; call request_private_access to learn how to request one.',
].join('\n');

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
 */
export function createServer(tc: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'ryanlindsey-me', version: '1.4.1' }, // x-release-please-version
    { instructions: INSTRUCTIONS },
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
  // The same documents, for clients that prefer resource attachment over tool
  // calls (03 §2). Registered through `defineResource`, which limits and
  // audits a read exactly as `defineTool` does a call.
  registerResources(server, tc);

  return server;
}
