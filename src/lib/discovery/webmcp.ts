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
 * tests/mcp-tools.test.ts's `rpc` does. src/lib/fit/client.ts's `rpc` was the
 * other precedent named here; it had moved on to a frame walk that matches on
 * the JSON-RPC id, and #351 moved that walk to `payloadOf` in
 * workers/mcp/src/evals-client.ts and deleted the site's copy. This one still
 * carries both defects that walk was written against: it decides SSE by the
 * first bytes, so a leading `: keepalive` sends the whole stream to
 * `JSON.parse`, and it takes the first `data:` line, which a notification
 * frame ahead of the answer would defeat.
 *
 * The `?? '{}'` fallback was meant to make a `data:` line that never arrives
 * fail as "the server answered nothing usable" rather than as a bare
 * `JSON.parse('')` `SyntaxError`. It does not: `'{}'.slice(5)` is `''`, so
 * that is exactly the error it throws (found in the review of #351).
 *
 * `defineTool` (workers/mcp/src/define.ts) answers BOTH a limiter refusal and
 * a thrown `ToolError` as an ordinary JSON-RPC `result` with `isError: true`
 * -- not a transport-level `error` -- so a caller that only checked
 * `body.error` would hand a refusal back to `execute`'s caller as if it were
 * real tool output. `search_writing` is the one `cost: 'inference'` tool and
 * sits in the tightest limiter bucket, so this is the realistic failure: a
 * rate-limited call answers with a sentence like "Rate limit reached for
 * search_writing. Try again in Xs." through the exact same shape as a real
 * result. This rejects instead, carrying that sentence as the error message --
 * the same read of `result.content[0].text` that src/lib/fit/client.ts's
 * `callAnalyzeFit` did for its own `isError` branch until #269 deleted it --
 * so the `Promise` `execute` returns is rejected precisely when the tool
 * refused, and a WebMCP host reading the rejection reason sees the refusal's
 * own sentence rather than a result that merely looks like an answer.
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
      ? (text.split('\n').find((line) => line.startsWith('data:')) ?? '{}').slice(5).trim()
      : text;
  const body = JSON.parse(payload) as {
    result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? `${name} failed`);
  if (body.result?.isError) {
    throw new Error(body.result.content?.[0]?.text ?? `${name} refused the request`);
  }
  return body.result?.content;
}
