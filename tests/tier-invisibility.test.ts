import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { BANNED_PATTERNS, SCAN_EXCEPTIONS, SCAN_ROOTS } from './candidacy-patterns';
import { buildMcpDiscovery } from '../src/lib/mcp/discovery';

/**
 * The static half of the candidate-mode audit (09 §2, day 5's build-track
 * item). The RUNTIME half -- what the server actually says -- is in
 * tests/mcp-tools.test.ts, tests/mcp-gated.test.ts and tests/fit-pages.test.ts,
 * each scanning real responses. This suite reads the source tree instead,
 * because a string can leak the day it is written, long before any route
 * serves it.
 */
test('no shipped source file carries search language, outside the registered exceptions', async () => {
  const tracked = execFileSync('git', ['ls-files', ...SCAN_ROOTS], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  expect(tracked.length, 'the scan must actually be looking at files').toBeGreaterThan(50);

  const hits: string[] = [];
  for (const path of tracked) {
    const source = await readFile(path, 'utf8');
    if (BANNED_PATTERNS.some((pattern) => pattern.test(source))) hits.push(path);
  }

  // EQUALITY, not a subset. A new hit fails, and so does removing a file from
  // the exception register without removing its cause -- an exception that has
  // stopped being needed should not sit here pretending it is.
  expect(hits.sort()).toEqual(Object.keys(SCAN_EXCEPTIONS).sort());
});

test('every exception carries a reason', () => {
  for (const [path, reason] of Object.entries(SCAN_EXCEPTIONS)) {
    expect(reason.length, `${path} needs a real reason, not a placeholder`).toBeGreaterThan(40);
  }
});

test('the discovery document still says the advertised endpoint needs no auth', () => {
  // src/lib/mcp/discovery.ts asked day 5 to revisit this field "rather than
  // leave it lying". Revisited: the field describes what the ADVERTISED
  // endpoint requires, and the advertised endpoint requires nothing -- the
  // private tier is reached by presenting a token to the same endpoint, and
  // its existence is already public and neutral through
  // `request_private_access`. Pinned here so a future change is deliberate.
  expect(buildMcpDiscovery('https://mcp.ryanlindsey.me')).toMatchObject({
    authentication: 'none',
  });
});

test('the MCP Worker never accepts a token from a cookie', async () => {
  // The invariant that keeps `allowedOriginHostnames: '*'` safe
  // (workers/mcp/src/index.ts): a token is presented EXPLICITLY on every call.
  // A cookie would be ambient, and a hostile page could then borrow it --
  // which is the exact attack Origin validation exists to stop and which this
  // server has deliberately opted out of.
  for (const path of [
    'workers/mcp/src/index.ts',
    'src/lib/tier/grant.ts',
    'workers/mcp/src/define.ts',
  ]) {
    const source = await readFile(path, 'utf8');
    // Comments are allowed to discuss cookies; code is not to read them.
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code, `${path} must not read a cookie`).not.toMatch(/\bcookie\b/i);
  }
});

test('the site never sets a cookie on a /fit response', async () => {
  const source = await readFile('src/pages/fit/run.ts', 'utf8');
  expect(source).not.toMatch(/set-cookie/i);
});
