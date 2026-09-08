import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { buildMcpDiscovery } from '../src/lib/mcp/discovery';
import { MCP_HARNESS_WORKERS, TEST_SITE_ORIGIN } from './workers';

// The exact instructions the server is expected to advertise. Asserting the
// whole string — rather than scanning it for a list of disallowed words — is
// what keeps the server's self-description under review: any edit to it fails
// this test and has to be made deliberately.
const EXPECTED_INSTRUCTIONS = [
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

// The MCP Worker first (so it stays the primary one that relative
// `server.fetch()` URLs address), plus the Workers AI stand-in its `ai` binding
// is overridden to, plus -- since issue #28 -- the SITE and its own mock-browser
// override. mock-ai is not optional here even though nothing in this file
// touches AI: the binding moved to this Worker with the corpus job, Workers AI
// has no local emulator, and an un-overridden `ai` binding makes booting this
// Worker open a real remote proxy session that fails without credentials. The
// site is not optional either, and for a harder reason: this Worker's `SITE`
// service binding names it, and workerd refuses to start a Worker whose service
// binding names an undefined service. Shared with the site suites via
// tests/workers.ts rather than restated, so the overrides cannot drift between
// the places this Worker is booted.
const server = createTestHarness({
  workers: MCP_HARNESS_WORKERS,
});

beforeAll(async () => {
  await server.listen();
  // The audit table. `defineTool` writes a row for every guarded call, and the
  // harness starts this Worker on empty storage -- see the same call in
  // tests/mcp-tools.test.ts for the measurement behind that. Needed here only
  // since this suite grew a real tool call below.
  await server.getWorker<{ DB: D1Database }>('ryanlindsey-me-mcp').applyD1Migrations('DB');
});

afterAll(async () => {
  await server.close();
});

async function rpc(body: unknown) {
  const response = await server.fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // Streamable HTTP may answer as JSON or as a single SSE frame.
  const payload =
    text.startsWith('event:') || text.startsWith('data:')
      ? text
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5)
          .trim()
      : text;
  return { status: response.status, json: JSON.parse(payload) };
}

function initialize(id: number) {
  return rpc({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  });
}

test('completes the initialize handshake', async () => {
  const { status, json } = await initialize(1);

  expect(status).toBe(200);
  expect(json.result.serverInfo.name).toBe('ryanlindsey-me');
  expect(json.result.protocolVersion).toBeTruthy();
});

test('advertises exactly the reviewed server instructions', async () => {
  const { json } = await initialize(2);

  // Top level of the result, per the spec — not nested inside serverInfo.
  expect(json.result.instructions).toBe(EXPECTED_INSTRUCTIONS);
});

test('the instructions name every registered tool', async () => {
  const { json: listed } = await rpc({ jsonrpc: '2.0', id: 300, method: 'tools/list', params: {} });
  const { json: init } = await initialize(301);
  for (const tool of listed.result.tools) {
    expect(init.result.instructions).toContain(tool.name);
  }
});

test('accepts a browser client on a third-party origin', async () => {
  const response = await server.fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: 'https://claude.ai',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'b', version: '0' },
      },
    }),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
});

test('answers the CORS preflight a browser client sends first', async () => {
  const response = await server.fetch('/mcp', {
    method: 'OPTIONS',
    headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  // Without this, a browser client cannot send the session header the
  // Streamable HTTP transport uses, and the preflight silently wins.
  expect(response.headers.get('access-control-allow-headers')).toContain('mcp-session-id');
});

// Day 4 Task 14 (roadmap "/.well-known + discovery"; 03 §5): the day-3 owner
// decision deferred this origin's own robots.txt to here -- robots.txt is
// per-origin (RFC 9309 §2.3), so the site's own file (which explicitly says
// so) has no effect on mcp.ryanlindsey.me. HANDLER_OPTIONS answers exactly
// `route: '/mcp'` and 404s everything else, so these two surfaces and the
// unrouted-404 case all have to be proven here, not assumed from the site
// suite's own coverage.
test('the MCP origin serves its own robots.txt, permissive and unrestricted', async () => {
  const response = await server.fetch('/robots.txt');
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toMatch(/User-agent:/);
  // The posture that actually matters for a published document, checked
  // directly rather than left to a `/User-agent:/` match that would pass
  // just as happily against a file that disallows everything: no
  // `Disallow` DIRECTIVE anywhere (line-anchored and case-insensitive, so a
  // mention of the word inside a `#` comment -- this file's own doc comment
  // has one -- can never trip this), and at least one `Allow: /` present. A
  // future edit that quietly added a real restriction here would cut agent
  // access to this origin; this is what makes that edit fail the suite
  // instead of only a human re-reading the file.
  expect(body).not.toMatch(/^Disallow:/im);
  expect(body).toMatch(/^Allow: \/$/m);
});

test('the MCP origin serves its own discovery document', async () => {
  const response = await server.fetch('/.well-known/mcp.json');
  expect(response.status).toBe(200);
  // Cast to the shape `buildMcpDiscovery` actually returns -- same
  // as-cast convention `response.json()` (typed `unknown`) already gets
  // elsewhere in this suite (tests/resume.test.ts's `as Resume`,
  // tests/pages.test.ts's `as JsonFeed`).
  const doc = (await response.json()) as ReturnType<typeof buildMcpDiscovery>;
  expect(doc.endpoint).toBe('https://mcp.ryanlindsey.me/mcp');
});

test('an unrouted path on the MCP origin is a 404, not the MCP handler', async () => {
  expect((await server.fetch('/anything-else')).status).toBe(404);
});

// --- Issue #28: documents are read over the SITE binding, not the network ---
//
// THE REGRESSION GUARD FOR #28, and the reason it is in THIS suite rather than
// tests/mcp-tools.test.ts is the one property that suite deliberately gives up:
// it overrides `SITE_ORIGIN` to the harness's own measured loopback address, so
// a document read there succeeds over real HTTP whether or not a service binding
// is involved. Here `SITE_ORIGIN` is still `TEST_SITE_ORIGIN`
// (`http://resume-pdf.test`), a host that RESOLVES NOWHERE. So this test can
// only pass if the read never leaves the runtime -- which is exactly the
// property that makes the production loop impossible.
//
// What #28 was: the MCP Worker read published documents with global `fetch()`
// against `SITE_ORIGIN` (`https://ryanlindsey.me`). That origin is a Cloudflare
// CUSTOM DOMAIN for the site Worker, and Cloudflare's own Error 522 page says a
// Worker on a custom domain fetching its own hostname gets a 522. Arriving via
// `mcp.ryanlindsey.me` the target was a different hostname and the subrequest
// was ordinary; arriving via `ryanlindsey.me/mcp` (which the site forwards over
// the `MCP` service binding WITH THE URL AND HOST UNTOUCHED) the fetch target
// was the hostname of the request being served, and every document read 522'd.
//
// Reverting `documentsEnv` (workers/mcp/src/tools.ts) to a global-`fetch`
// wrapper fails this test, because `http://resume-pdf.test` has no DNS.
//
// WHAT THIS STILL CANNOT PROVE, stated rather than implied: nothing here
// distinguishes the two production entry paths. Both Workers are local, neither
// custom domain exists, and there is no Cloudflare edge to loop through -- the
// harness answered #28's code green before the bug shipped and would do so
// again. The live round trip is what catches that class, and this test's job is
// narrower and still worth having: it pins the MECHANISM (a binding, not a
// network call) that makes the loop unreachable.
test('reads published documents over the SITE binding, with an unroutable SITE_ORIGIN', async () => {
  // Proven, not assumed -- the whole test rests on this origin being one no
  // network read could ever satisfy.
  const mcp = server.getWorker<{ SITE_ORIGIN: string }>('ryanlindsey-me-mcp');
  expect((await mcp.getEnv()).SITE_ORIGIN).toBe(TEST_SITE_ORIGIN);

  const { json } = await rpc({
    jsonrpc: '2.0',
    id: 400,
    method: 'tools/call',
    params: { name: 'list_case_studies', arguments: {} },
  });

  // `isError` is how a guarded tool reports a failed read, and it is asserted
  // FIRST: the content check below would also fail, but with a message about
  // JSON parsing rather than about the read.
  expect(json.result.isError).toBeUndefined();

  const studies = JSON.parse(json.result.content[0].text) as { slug: string; url: string }[];
  // The two published case studies in `dist/client/llms.txt` -- the same build
  // the site Worker in this harness serves. `shape-specimen` is a draft and is
  // absent from the index, which is what makes this a check on the real
  // published set rather than on a directory listing.
  expect(studies.map((s) => s.slug).sort()).toEqual(['delivery-forecasting', 'silent-failure']);
  // The citation URLs are still built from `SITE_ORIGIN`. That is correct and
  // worth pinning: the binding decides WHERE the bytes come from, the var
  // decides what URL a caller is told to visit, and #28's fix must not have
  // quietly merged those two jobs.
  for (const study of studies) expect(study.url.startsWith(TEST_SITE_ORIGIN)).toBe(true);
});

// The résumé travels a different path through the same layer -- `/resume.json`
// is fetched and parsed as JSON rather than as markdown, and `fetchResumeJson`
// is the only caller that does that -- so a binding that served `.md` assets but
// not this one would leave `get_resume` broken with the listing tools green.
test('reads /resume.json over the SITE binding too', async () => {
  const { json } = await rpc({
    jsonrpc: '2.0',
    id: 401,
    method: 'tools/call',
    params: { name: 'get_resume', arguments: { format: 'json' } },
  });

  expect(json.result.isError).toBeUndefined();
  const resume = JSON.parse(json.result.content[0].text) as { basics?: { name?: string } };
  expect(resume.basics?.name).toBe('Ryan Lindsey');
});
