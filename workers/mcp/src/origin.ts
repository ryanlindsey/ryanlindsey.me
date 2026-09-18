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
 *
 * THE TWO CONSUMERS DO NOT FAIL THE SAME WAY, AND THE SECOND ONE HARDLY FAILS
 * AT ALL. For the discovery documents, this constant IS the answer: a wrong
 * value publishes a wrong endpoint, and a client that reads it goes somewhere
 * else. For ./evals-client.ts the hostname is inert. That module passes this
 * URL to `env.SELF.fetch`, and a service binding routes by BINDING rather than
 * by hostname, and ./index.ts's `fetch` reads nothing out of the URL but the
 * pathname: a wrong constant there would misroute nothing and change no
 * result. It is written this way because a fetch needs an absolute URL and
 * this is the honest one to give it, not because anything downstream reads it.
 *
 * So the reason to keep this correct is still the first consumer's, entirely.
 * A reader tempted to reach for `request.url` on the scheduled path should know
 * they would be trading a value that does not matter for one that is wrong
 * under every test that boots this Worker.
 */
export const MCP_ORIGIN = 'https://mcp.ryanlindsey.me';
