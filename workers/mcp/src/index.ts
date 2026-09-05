import { createMcpHandler } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';

const INSTRUCTIONS = [
  "Ryan Lindsey's professional corpus, exposed as MCP tools.",
  'Public tools cover portfolio exploration. A private tier exists for scoped tokens;',
  'ask Ryan for access if you need it.',
].join(' ');

function createServer() {
  // `instructions` belongs to ServerOptions (the second argument), not to the
  // Implementation identity. Passing it here is also what puts it at the top
  // level of the initialize result, where the spec and clients look for it.
  // The `x-release-please-version` marker is load-bearing: release-please's `generic` updater
  // rewrites the semver on any line carrying it, which is what keeps the version this server
  // advertises over MCP in step with package.json. Moving the version off this line, or letting
  // a formatter split it across lines, silently strands it at whatever it says today.
  const server = new McpServer(
    { name: 'ryanlindsey-me', version: '1.0.0' }, // x-release-please-version
    { instructions: INSTRUCTIONS },
  );

  // No `inputSchema`: this tool takes no arguments, and the empty-object form
  // resolves to the deprecated raw-shape overload. Day 4 adds zod schemas with
  // the first tool that takes arguments.
  server.registerTool(
    'get_contact',
    {
      description: 'How to reach Ryan Lindsey, and his working timezone.',
    },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              email: 'hello@ryanlindsey.me',
              site: 'https://ryanlindsey.me',
              timezone: 'America/Los_Angeles',
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(createServer, { route: '/mcp' })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
