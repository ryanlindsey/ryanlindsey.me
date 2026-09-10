import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_WORKER, SITE_HARNESS_WORKERS } from './workers';
import { BANNED_PATTERNS } from './candidacy-patterns';

/**
 * The `/chat` page and its send route (04 §1).
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. `CHAT_ENGINE` is `'off'` on the MCP
 * Worker under the harness, so nothing here sees a real answer -- what the
 * send-route tests establish is that the HOP HAPPENED: the frame that comes back
 * is the far side's own, produced by code on the other end of the `MCP` service
 * binding. The page tests are about the surface: the widget, the disclosure, the
 * JS-less path, and the candidacy scan.
 *
 * `Origin` is sent on every POST because Astro's `security.checkOrigin` is on by
 * default and answers a POST without it before routing -- see
 * tests/fit-pages.test.ts, which measured that and the harness keep-alive
 * artifact that goes with it.
 */
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });
let origin = '';

beforeAll(async () => {
  const { url } = await server.listen();
  origin = url.origin;
  await server.update({
    workers: SITE_HARNESS_WORKERS.map((worker) =>
      worker === MCP_WORKER
        ? { ...MCP_WORKER, vars: { ...MCP_WORKER.vars, SITE_ORIGIN: url.origin } }
        : worker,
    ),
  });
  await server.getWorker<{ DB: D1Database }>('ryanlindsey-me-mcp').applyD1Migrations('DB');
});

afterAll(async () => {
  await server.close();
});

describe('GET /chat', () => {
  test('renders, and carries the Turnstile widget and the sitekey', async () => {
    const html = await (await server.fetch('/chat')).text();
    expect(html).toContain('cf-turnstile');
    expect(html).toContain('0x4AAAAAAElhnY8ov3OYHN8m');
  });

  test('says what it does with what you type, on the page rather than only in the policy', async () => {
    const html = await (await server.fetch('/chat')).text();
    expect(html).toContain('/ai-policy');
    expect(html).toMatch(/30 days/);
  });

  test('a visitor without JavaScript is pointed at the corpus, not left with a dead form', async () => {
    const html = await (await server.fetch('/chat')).text();
    const noscript = html.slice(html.indexOf('<noscript>'), html.lastIndexOf('</noscript>'));
    expect(noscript).toContain('/llms.txt');
    expect(noscript).toContain('mcp');
  });

  test('no copy on the page matches a banned pattern', async () => {
    const html = await (await server.fetch('/chat')).text();
    for (const pattern of BANNED_PATTERNS) expect(html).not.toMatch(pattern);
  });

  test('the footer offers it from every page, including the home page', async () => {
    // Discoverability lives in the footer's agent-resources nav rather than in
    // the primary nav: /chat is a way to READ this site, like llms.txt and the
    // MCP endpoint beside it, not a section of it. `Shell` puts that footer on
    // every page, which is why asserting it on `/` is enough.
    const home = await (await server.fetch('/')).text();
    expect(home).toContain('href="/chat"');
    expect(home).toContain('Ask my agent');
  });
});

describe('POST /chat/send', () => {
  const send = (body: unknown) =>
    server.fetch('/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    });

  test('a missing bot-check token is refused — by the far side, which is where the check lives', async () => {
    const text = await (await send({ question: 'hello' })).text();
    expect(text).toContain('event: error');
    expect(text).toContain('"code":"bot-check"');
  });

  test('this route does not consume the token — it forwards it verbatim', async () => {
    // The single-use property is the whole reason this route does not verify.
    // Two sends with the SAME token would both be refused as duplicates if this
    // route were consuming them before the hop; under the harness stub both
    // pass admission and reach the (off) engine, which is what proves the token
    // arrived intact rather than spent.
    const first = await (await send({ question: 'one', turnstileResponse: 'x' })).text();
    const second = await (await send({ question: 'two', turnstileResponse: 'x' })).text();
    expect(first).toContain('"code":"unreachable"');
    expect(second).toContain('"code":"unreachable"');
  });

  test('a passing bot check reaches the MCP Worker and its frames come back', async () => {
    // RLME_TURNSTILE_MODE is 'stub' on the MCP Worker, so any non-empty token
    // passes there; CHAT_ENGINE is 'off', so what comes back is that Worker's
    // own error frame -- which is the proof the hop happened.
    const response = await send({ question: 'hello', turnstileResponse: 'x' });
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await response.text()).toContain('"code":"unreachable"');
  });

  test('an empty question is refused at the edge, before the hop', async () => {
    const text = await (await send({ question: '   ', turnstileResponse: 'x' })).text();
    expect(text).toContain('"code":"empty"');
  });

  test('a question over the cap is refused at the edge, before the hop', async () => {
    const text = await (await send({ question: 'x'.repeat(2000), turnstileResponse: 'x' })).text();
    expect(text).toContain('"code":"too-long"');
  });

  test('GET is not the route', async () => {
    expect((await server.fetch('/chat/send')).status).toBe(405);
  });
});
