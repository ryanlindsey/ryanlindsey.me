import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_ENDPOINT } from '../src/lib/nav';
import { GATED_TOOL_NAMES } from '../workers/mcp/src/gated';
import { PUBLIC_TOOL_NAMES } from '../workers/mcp/src/tools';
import { BANNED_PATTERNS } from './candidacy-patterns';
import { SITE_HARNESS_WORKERS } from './workers';

/**
 * /connect (#395). Static, so nothing here needs the MCP Worker to answer
 * anything; it is listed because the site Worker will not boot without it
 * (tests/workers.ts). The handshake runs only on a click and nothing here
 * clicks, so no test reaches the network.
 */
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

const html = (path: string): Promise<string> => server.fetch(path).then((res) => res.text());

/** The page and every script it loads, as one string: a tool name in a bundle is still published. */
async function pageAndScripts(): Promise<string> {
  const page = await html('/connect/');
  const scripts = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  return [page, ...(await Promise.all(scripts.map(html)))].join('\n');
}

describe('GET /connect/', () => {
  test('renders one main, with its heading inside it', async () => {
    const page = await html('/connect/');
    expect(page.match(/<main[\s>]/g)).toHaveLength(1);
    const main = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
    expect(main).toMatch(/<h1[^>]*>Connect<\/h1>/);
  });

  test('names no tool, public or gated, in the page or its scripts', async () => {
    const everything = await pageAndScripts();
    for (const name of [...PUBLIC_TOOL_NAMES, ...GATED_TOOL_NAMES]) {
      expect(everything, name).not.toContain(name);
    }
  });

  test('publishes the endpoint exactly as nav.ts spells it', async () => {
    const page = await html('/connect/');
    expect(page).toContain(MCP_ENDPOINT);
    expect(page).not.toContain('https://mcp.ryanlindsey.me/"');
    expect(page).not.toContain('https://mcp.ryanlindsey.me/mcp/');
  });

  test('carries all three setup blocks, each with its token variant', async () => {
    const page = await html('/connect/');
    for (const id of ['claude', 'claude-code', 'http']) {
      expect(page).toContain(`data-setup="${id}"`);
    }
    expect(page.match(/With a token/g)).toHaveLength(3);
    expect(page).toContain('Bearer &lt;token&gt;');
  });

  // The rail's private-tier copy is its own, not PRIVATE_ACCESS_TEXT (see the
  // page's PRIVATE_TIER comment), so this asserts what a reader must be able to
  // act on rather than the wording: where to ask. The banned-pattern test
  // below holds the wording to the same rule as the reviewed sentence.
  test('the private tier says where to ask for access', async () => {
    const rail = await html('/connect/').then((page) =>
      page.slice(page.indexOf('data-connect-rail'), page.indexOf('</aside>')),
    );
    expect(rail).toContain('A private tier');
    expect(rail).toContain('hello@ryanlindsey.me');
  });

  test('both turns are templates with /chat’s shapes, and the request is rendered without JavaScript', async () => {
    const page = await html('/connect/');
    // The request is /chat's user turn, a box; the answer is its agent turn, an
    // accent rule and no box. Asserted on the markup so neither needs a click.
    const handshake = page.slice(page.indexOf('data-handshake'), page.indexOf('data-hello-slot'));
    expect(handshake).toContain('border border-rule bg-surface-raised');
    expect(page).toMatch(
      /<template data-hello-template>\s*<div class="[^"]*border-l-2 border-accent/,
    );
    expect(page).toContain('&quot;method&quot;: &quot;initialize&quot;');
  });

  test('a visitor without JavaScript gets the same request as a curl', async () => {
    const page = await html('/connect/');
    const noscript = page.slice(page.indexOf('<noscript>'), page.lastIndexOf('</noscript>'));
    expect(noscript).toContain(`curl ${MCP_ENDPOINT}`);
  });

  test('links the documents that describe the endpoint', async () => {
    const page = await html('/connect/');
    for (const href of [
      '/.well-known/mcp/server-card.json',
      '/auth.md',
      '/.well-known/oauth-protected-resource',
    ]) {
      expect(page).toContain(`href="${href}"`);
    }
  });

  test('no copy on the page matches a banned pattern', async () => {
    const page = await html('/connect/');
    for (const pattern of BANNED_PATTERNS) expect(page).not.toMatch(pattern);
  });
});
