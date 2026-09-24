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

/**
 * A rendered page, as text. One helper rather than the `const html = await
 * (await server.fetch(path)).text()` line this file repeated in every case:
 * issue #111 added seven more page tests, and seven more copies of one
 * expression is where a file stops being readable.
 */
const html = (path: string): Promise<string> => server.fetch(path).then((res) => res.text());

/** The rail, which several cases below scope themselves to. */
const railOf = (page: string): string => {
  const rail = /data-chat-rail[\s\S]*?<\/aside>/.exec(page);
  expect(rail, 'no rail on the chat page').not.toBeNull();
  return rail![0];
};

describe('GET /chat', () => {
  test('renders, and carries the Turnstile widget and the sitekey', async () => {
    const page = await html('/chat');
    expect(page).toContain('cf-turnstile');
    expect(page).toContain('0x4AAAAAAElhnY8ov3OYHN8m');
  });

  test('says what it does with what you type, on the page rather than only in the policy', async () => {
    const page = await html('/chat');
    expect(page).toContain('/ai-policy');
    expect(page).toMatch(/30 days/);
  });

  test('a visitor without JavaScript is pointed at the corpus, not left with a dead form', async () => {
    const page = await html('/chat');
    const noscript = page.slice(page.indexOf('<noscript>'), page.lastIndexOf('</noscript>'));
    expect(noscript).toContain('/llms.txt');
    expect(noscript).toContain('href="/connect"');
  });

  test('no copy on the page matches a banned pattern', async () => {
    const page = await html('/chat');
    for (const pattern of BANNED_PATTERNS) expect(page).not.toMatch(pattern);
  });

  test('the header offers it from every page, including the home page', async () => {
    // Promoted out of the footer into the primary nav by the 2026-09 redesign:
    // /chat is the one agent-facing surface a person can use without knowing
    // what an MCP endpoint is, which is why it stopped being filed beside
    // llms.txt. The footer no longer links it and this test moved rather than
    // being deleted -- the invariant is "reachable from every page", and only
    // where it is reachable from changed.
    for (const path of ['/', '/writing', '/resume']) {
      const page = await html(path);
      const nav = /<nav[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/.exec(page)![1];
      expect(nav).toContain('href="/chat"');
    }
  });

  test('the chat page is a transcript beside a rail', async () => {
    const page = await html('/chat');
    expect(page).toContain('data-chat-transcript');
    expect(page).toContain('data-chat-rail');
  });

  test('an agent turn is a rule, not a bubble, and carries its citations', async () => {
    // The asymmetry is the design's argument: citations are part of the
    // answer. A symmetric chat-bubble transcript loses that.
    //
    // WHAT PUTS THIS MARKUP IN A RENDERED PAGE AT ALL is worth stating,
    // because the transcript is empty until somebody types. The two turn
    // shapes are <template> elements the client clones, so the design lives
    // in the .astro file where Tailwind scans it and this test can read it,
    // rather than in class strings concatenated inside the <script>.
    const page = await html('/chat');
    expect(page).toContain('data-turn="agent"');
    const agent = /data-turn="agent"[\s\S]*?<\/div>/.exec(page);
    if (agent) {
      expect(agent[0]).toMatch(/border-l-2[^"]*border-accent/);
      expect(agent[0]).not.toMatch(/bg-surface-raised/);
    }
  });

  test('an agent turn shows typing dots while it waits, with words for a screen reader', async () => {
    const page = await html('/chat');
    const agent = /<template data-turn-template="agent">[\s\S]*?<\/template>/.exec(page)?.[0] ?? '';
    const pending = /<p[^>]*data-turn-pending[\s\S]*?<\/p>/.exec(agent)?.[0] ?? '';
    expect(pending, 'no pending element in the agent template').not.toBe('');
    expect(pending).toMatch(/class="sr-only"[^>]*>\s*Thinking\s*</);
    expect(
      pending.match(
        /aria-hidden="true"[^>]*chat-typing-dot|chat-typing-dot[^>]*aria-hidden="true"/g,
      ),
    ).toHaveLength(3);
  });

  test('the answer container can hold paragraphs and lists', async () => {
    // A <p> cannot legally contain <p>, <ul> or <ol>, so the rendered answer
    // needs a <div> around it (#403).
    const page = await html('/chat');
    const agent = /<template data-turn-template="agent">[\s\S]*?<\/template>/.exec(page)?.[0] ?? '';
    expect(agent).toMatch(/<div[^>]*data-turn-text/);
  });

  test('the typing dots hold still for a reader who asked for less motion', async () => {
    const page = await html('/chat');
    const hrefs = [...page.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);
    const inline = [...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    const linked = await Promise.all(
      hrefs.map((href) => server.fetch(href).then((res) => res.text())),
    );
    const css = [...inline, ...linked].join('\n');
    expect(css).toMatch(
      /prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.chat-typing-dot[^}]*animation:\s*none/,
    );
  });

  test('the composer still works without JavaScript', async () => {
    // Rendered markup is the no-JS state. This page is the likeliest in the
    // site to ship a dead form.
    const page = await html('/chat');
    expect(page).toMatch(/<form[^>]*data-chat-form/);
    expect(page).toContain('llms.txt');
  });

  test('it says what it does with what you type, before the composer', async () => {
    const page = await html('/chat');
    const composerAt = page.indexOf('data-chat-form');
    const railAt = page.indexOf('data-chat-rail');
    expect(composerAt).toBeGreaterThan(-1);
    // Asserted explicitly, because `indexOf` returns -1 for a rail that is not
    // there at all and -1 is less than every real offset: without this line a
    // deleted rail passes the ordering check below rather than failing it.
    expect(railAt).toBeGreaterThan(-1);
    // Rendered before the composer in the DOM, so a reader meets the statement
    // on the way to the box rather than after using it.
    expect(railAt).toBeLessThan(composerAt);
  });

  test('the retention figure is the one the cron enforces', async () => {
    // chat_turns is the row this page is making a claim about. Read from the
    // table-driven constant rather than typed, so the sentence a reader sees
    // above the box and the job that deletes their transcript are one number.
    const { RETENTION, formatWindow } = await import('../src/lib/retention');
    const rail = railOf(await html('/chat'));
    const transcripts = RETENTION.find((row) => row.table === 'chat_turns');
    expect(transcripts, 'no retention window for chat_turns').toBeDefined();
    expect(rail).toContain(formatWindow(transcripts!.days));
  });

  test('the message cap is the one the limiter enforces', async () => {
    // The other half of THIS SESSION, and the same rule as the retention row
    // beside it: 30 is `LIMITS.conversation.limit`, which workers/mcp/src/chat.ts
    // spends through `checkLimit` before it answers. A hand-typed denominator
    // here would be a published number with nothing holding it to the bucket.
    const { LIMITS } = await import('../src/lib/mcp/limits');
    const rail = railOf(await html('/chat'));
    expect(rail).toContain(`/ ${LIMITS.conversation.limit}`);
  });

  test('the protocol block points a person at /connect, in the same tab', async () => {
    // #395: a browser GET on the MCP endpoint answers 405 with JSON (measured
    // 2026-09-24), so the rail links the page that explains how to connect.
    const rail = railOf(await html('/chat'));
    expect(rail).toMatch(/<a[^>]*href="\/connect"[^>]*>\s*Connect over MCP\s*<\/a>/);
    expect(rail).not.toMatch(/href="\/connect"[^>]*target="_blank"/);
    expect(rail).not.toContain('https://mcp.ryanlindsey.me/mcp');
  });

  test('a query handed over from /search arrives in the composer', async () => {
    // `/search` ends every one of its states with a link to `/chat?q=<query>`
    // (issue #147), and a link that carried a parameter nothing read would not
    // be carrying the query at all.
    const form = /<form[^>]*data-chat-form[\s\S]*?<\/form>/.exec(await html('/chat?q=turnstile'));
    expect(form, 'no chat form on the page').not.toBeNull();
    expect(form![0]).toContain('>turnstile</textarea>');
  });

  test('a handed-over query is text, never markup', async () => {
    const page = await html('/chat?q=%3Cscript%3E');
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('&lt;script&gt;</textarea>');
  });

  test('the Turnstile widget and sitekey survive the restyle', async () => {
    // Unchanged assertion. Restated here because a layout rewrite is exactly
    // when a widget gets moved out of the form it belongs to -- so this one
    // checks the containment the first case does not.
    const page = await html('/chat');
    expect(page).toContain('cf-turnstile');
    const form = /<form[^>]*data-chat-form[\s\S]*?<\/form>/.exec(page);
    expect(form, 'no chat form on the page').not.toBeNull();
    expect(form![0]).toContain('cf-turnstile');
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
