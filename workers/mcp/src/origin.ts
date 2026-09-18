/**
 * This Worker's own vanity domain (workers/mcp/wrangler.jsonc's `routes`
 * entry), a literal for the same reason src/pages/llms.txt.ts's own
 * `MCP_ENDPOINT` is one: this Worker has no var naming its own hostname
 * (`SITE_ORIGIN` in McpEnv names the SITE's origin, for the corpus job's
 * fetches, not this one), and `request.url` reads as the test harness's
 * loopback address under `createTestHarness` rather than the real custom
 * domain (tests/workers.ts's own note on `inferOriginFromRoutes`) -- deriving
 * this from the request would silently answer with the wrong endpoint under
 * every suite that boots this Worker.
 *
 * IT LIVES IN ITS OWN MODULE, rather than in ./index.ts where it was defined
 * until issue #291, because ./evals-client.ts needs the same constant and
 * ./index.ts re-exports the workflow class that module's runner belongs to.
 * Importing it back from the entrypoint would be a cycle through that export.
 * Nothing else about it changed in the move.
 */
export const MCP_ORIGIN = 'https://mcp.ryanlindsey.me';
