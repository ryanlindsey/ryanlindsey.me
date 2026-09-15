import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { callMcp, WEBMCP_TOOLS } from '../src/lib/discovery/webmcp';
import { GATED_TOOL_NAMES } from '../workers/mcp/src/gated';
import { PUBLIC_TOOL_NAMES } from '../workers/mcp/src/tools';
import { SITE_HARNESS_WORKERS } from './workers';

// Same harness setup as tests/pages.test.ts, and for the same reason: the
// site Worker is booted from the adapter's build output so this suite
// exercises the artifact that ships, and the MCP Worker comes with it both
// because the site's `MCP` service binding names it and because this file
// compares WEBMCP_TOOLS against workers/mcp/src/gated.ts's and
// workers/mcp/src/tools.ts's own registries.
const server = createTestHarness({
  workers: SITE_HARNESS_WORKERS,
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

// PUBLIC_TOOL_NAMES is DERIVED from workers/mcp/src/tools.ts's own
// registration table (controller review, task 7 fix round) rather than a
// second, hand-typed list here: a hand-typed copy checks WEBMCP_TOOLS against
// itself in every way that matters, since renaming a tool in tools.ts and
// forgetting to update a literal here would leave both this test and the page
// green while the page advertised a name the server no longer implements --
// exactly the drift this issue exists to catch. GATED_TOOL_NAMES below is the
// same discipline for the private tier's own list.
test('every registered tool names a real public MCP tool', () => {
  for (const tool of WEBMCP_TOOLS) {
    expect(PUBLIC_TOOL_NAMES, tool.name).toContain(tool.name);
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

/**
 * `callMcp` itself, not through `navigator.modelContext` -- workerd has none,
 * per the module's own header -- but by pointing the global `fetch` it calls
 * at this same harness for the duration of one call. Controller review, task
 * 7 fix round (Finding 1): `defineTool` (workers/mcp/src/define.ts) answers
 * BOTH a limiter refusal and a thrown, non-`ToolError` failure as an ordinary
 * `result` with `isError: true`, not a transport-level `error`, so a
 * `callMcp` that only threw on `body.error` would resolve with a refusal as
 * if it were real tool output.
 *
 * `search_writing` is used here rather than the rate limiter it was the
 * motivating example for, because it throws inside its OWN handler under this
 * harness regardless of the limiter -- `env.VECTORIZE` has no local
 * simulation (tests/workers.ts's MCP_WORKER note) -- which lands on
 * `defineTool`'s `fail` path deterministically, every run, with no need to
 * race eleven calls against the inference bucket's 60-second window.
 */
test('callMcp rejects an isError result instead of resolving with it', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    server.fetch(input as never, init as never)) as unknown as typeof fetch;
  try {
    await expect(callMcp('search_writing', { query: 'agent-native sites' })).rejects.toThrow(
      'search_writing failed. The error was logged.',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** The happy path, same mechanism, so the fix above is not shown against a call that always fails. */
test('callMcp resolves with the real content on an ordinary call', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    server.fetch(input as never, init as never)) as unknown as typeof fetch;
  try {
    const content = (await callMcp('list_case_studies', {})) as { type: string; text: string }[];
    expect(content[0]?.type).toBe('text');
    // Real content from the harness's own published case studies, not a stub.
    expect(JSON.parse(content[0]!.text)).toBeInstanceOf(Array);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
