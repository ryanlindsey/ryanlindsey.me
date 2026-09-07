import { McpServer } from '@modelcontextprotocol/server';
import { defineTool, type ToolContext } from './define';
import { registerTools } from './tools';

const INSTRUCTIONS = [
  "Ryan Lindsey's professional corpus, exposed as MCP tools.",
  'Public tools cover portfolio exploration. A private tier exists for scoped tokens;',
  'ask Ryan for access if you need it.',
].join(' ');

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

  return server;
}
