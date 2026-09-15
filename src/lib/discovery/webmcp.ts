/**
 * WebMCP tool definitions for the homepage.
 *
 * The names are the MCP server's own, deliberately: one vocabulary, so an agent
 * that read /.well-known/mcp/server-card.json and an agent that found these in
 * the page are talking about the same tools. tests/discovery-webmcp.test.ts
 * asserts the names against the server's registry rather than trusting this.
 *
 * Every `execute` POSTs to /mcp. No tool logic lives here -- the Worker is the
 * only implementation, and this file is a second frontend to it, the same
 * arrangement src/pages/chat/send.ts describes for the chat engine.
 *
 * Only PUBLIC tools. A browser agent holds no scoped token, and a gated name
 * registered here would both advertise something the caller cannot reach and
 * hand out a name that an unauthenticated `tools/list` withholds on purpose.
 */
export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const WEBMCP_TOOLS: readonly WebMcpTool[] = [
  {
    name: 'search_writing',
    description: "Search Ryan Lindsey's published writing and case studies.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for.' } },
      required: ['query'],
    },
  },
  {
    name: 'get_resume',
    description: "Fetch Ryan Lindsey's resume as JSON Resume data, markdown, or a short summary.",
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['json', 'markdown', 'summary'],
          description: 'Which representation to return.',
        },
      },
    },
  },
  {
    name: 'list_case_studies',
    description: 'List the published case studies with their titles and summaries.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const satisfies readonly WebMcpTool[];

/**
 * Runs one public tool through the site's own `/mcp` endpoint, over the same
 * relative path the browser already trusts -- no origin to get wrong, no
 * token to carry, because every WEBMCP_TOOLS entry is public. Called from
 * src/pages/index.astro's registration script, one `execute` per tool.
 *
 * The Worker's streamable-HTTP handler (agents/mcp, wrapped by
 * workers/mcp/src/index.ts) answers every `tools/call` as one SSE frame --
 * MEASURED against node_modules/agents/dist/mcp/index.js, which sets
 * `Content-Type: text/event-stream` unconditionally on this path even though
 * the request accepts JSON too -- so this unwraps that frame exactly the way
 * tests/mcp-tools.test.ts's `rpc` and src/lib/fit/client.ts's `rpc` already do.
 */
export async function callMcp(name: string, args: Record<string, unknown>) {
  const response = await fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  const payload =
    text.startsWith('event:') || text.startsWith('data:')
      ? (text.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5).trim()
      : text;
  const body = JSON.parse(payload) as {
    result?: { content?: unknown };
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? `${name} failed`);
  return body.result?.content;
}
