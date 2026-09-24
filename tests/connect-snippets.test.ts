import { expect, test } from 'vitest';
import { buildInitialize } from '../src/lib/connect/handshake';
import { SETUP_CLIENTS, TOKEN_PLACEHOLDER } from '../src/lib/connect/snippets';
import { MCP_ENDPOINT } from '../src/lib/nav';

const variants = SETUP_CLIENTS.flatMap((client) => [client.anonymous, client.withToken]);
const text = (variant: { steps: readonly string[]; command?: string }) =>
  [...variant.steps, variant.command ?? ''].join('\n');

test('three clients, in the order the page shows them', () => {
  expect(SETUP_CLIENTS.map((client) => client.id)).toEqual(['claude', 'claude-code', 'http']);
});

test('every URL in every snippet is the endpoint, spelled once', () => {
  for (const variant of variants) {
    for (const url of text(variant).match(/https?:\/\/[^\s'"]+/g) ?? []) {
      expect(url).toBe(MCP_ENDPOINT);
    }
  }
});

test('a token appears only as the placeholder, only in the token variant, and always as a bearer', () => {
  for (const client of SETUP_CLIENTS) {
    expect(text(client.anonymous)).not.toMatch(/bearer|<token>/i);
    expect(text(client.withToken)).toContain(`Bearer ${TOKEN_PLACEHOLDER}`);
  }
});

test('the raw HTTP snippet sends exactly the handshake the button sends', () => {
  const curl = SETUP_CLIENTS.find((client) => client.id === 'http')!.anonymous.command!;
  const body = /-d '(.+)'$/m.exec(curl)?.[1];
  expect(JSON.parse(body!)).toEqual(buildInitialize());
});

test('Claude Code adds the server over HTTP', () => {
  const add = SETUP_CLIENTS.find((client) => client.id === 'claude-code')!.anonymous.command;
  expect(add).toBe(`claude mcp add --transport http ryanlindsey-me ${MCP_ENDPOINT}`);
});
