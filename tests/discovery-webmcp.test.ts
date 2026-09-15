import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { WEBMCP_TOOLS } from '../src/lib/discovery/webmcp';
import { GATED_TOOL_NAMES } from '../workers/mcp/src/gated';
import { SITE_HARNESS_WORKERS } from './workers';

// The MCP server's own public tool names (workers/mcp/src/tools.ts), copied
// rather than imported: importing that module would pull in the MCP Worker's
// tool-registration graph, and the point of this suite is to catch drift
// between the page and the server with an independent list, the same
// reasoning tests/mcp.smoke.test.ts's EXPECTED_INSTRUCTIONS follows.
const PUBLIC_TOOLS = ['search_writing', 'get_resume', 'list_case_studies'];

// Same harness setup as tests/pages.test.ts, and for the same reason: the
// site Worker is booted from the adapter's build output so this suite
// exercises the artifact that ships, and the MCP Worker comes with it both
// because the site's `MCP` service binding names it and because this file
// compares WEBMCP_TOOLS against workers/mcp/src/gated.ts's own registry.
const server = createTestHarness({
  workers: SITE_HARNESS_WORKERS,
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

test('every registered tool names a real public MCP tool', () => {
  for (const tool of WEBMCP_TOOLS) {
    expect(PUBLIC_TOOLS, tool.name).toContain(tool.name);
  }
});

// A browser agent holds no scoped token. Registering a gated name in the page
// would advertise a tool the caller cannot reach and would leak a name that
// tools/list deliberately withholds from an unauthenticated caller.
test('no gated tool is exposed to the browser', () => {
  for (const tool of WEBMCP_TOOLS) {
    expect(GATED_TOOL_NAMES, tool.name).not.toContain(tool.name);
  }
});

test('every tool carries a description and an object input schema', () => {
  for (const tool of WEBMCP_TOOLS) {
    expect(tool.description.length, tool.name).toBeGreaterThan(0);
    expect(tool.inputSchema.type, tool.name).toBe('object');
  }
});

// MEASURED against dist/client/index.html (2026-09-14), not assumed: this
// build inlines every non-`is:inline` page <script> (ThemeToggle's,
// MobileNav's, and this one) directly into the HTML rather than emitting a
// hashed external chunk -- the only external file under dist/client/_astro is
// Expressive Code's runtime, which opts out on its own. So the raw response
// text is where `modelContext` actually lands, and the plain substring
// assertion below is correct as written rather than a simplification of a
// "find the bundle, then fetch it" version this task's brief also
// considered. If a future Astro or Vite upgrade starts externalizing this
// script (crossing whatever size threshold keeps it inline today), this test
// fails here first, which is the intended tripwire.
test('the homepage ships the module and every other page does not', async () => {
  const home = await server.fetch('/');
  expect(await home.text()).toContain('modelContext');
  const other = await server.fetch('/ops');
  expect(await other.text()).not.toContain('modelContext');
});
