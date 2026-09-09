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
test('every SCAN_ROOTS entry actually matches a tracked file', () => {
  // Fix round 1, finding 4: `src` alone is 73 files, so a single
  // `toBeGreaterThan(50)` total stays green even if `prompts`, `evals`,
  // `scripts`, `public`, `migrations`, `README.md` or `CHANGELOG.md` were
  // renamed or deleted out from under this scan -- `git ls-files <pathspec>`
  // exits 0 with EMPTY output for a pathspec that matches nothing, not an
  // error, so a root going silent is invisible to a total-only guard. Checked
  // per root instead, so the scan going quiet on any one of them fails loudly
  // and names which one.
  for (const root of SCAN_ROOTS) {
    const files = execFileSync('git', ['ls-files', root], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(
      files.length,
      `${root} matched no tracked file -- has it moved or been renamed?`,
    ).toBeGreaterThan(0);
  }
});

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

test('the eval fixture mirrors BANNED_PATTERNS exactly, so the two cannot silently drift apart', async () => {
  // tests/candidacy-patterns.ts's own opening comment says BANNED_PATTERNS is
  // defined exactly once so every surface shares it rather than each hand-
  // typing a copy that could drift. evals/cases/tier/invisibility.json IS
  // such a copy -- an eval fixture is JSON and cannot import a TypeScript
  // module -- and until this test, nothing asserted the two stayed in step.
  // Fix round 1, finding 3: they had already drifted, on the very commit
  // that added a seventh pattern here -- the fixture still had six, silently
  // leaving the live `npm run evals -- --suite tier` checking a weaker list
  // than every unit test in this repo. A `RegExp`'s `.source` is the same
  // text `JSON.parse` hands back for an escaped string in the fixture (both
  // are the literal regex source, `\b...\b`, not a double-escaped copy of
  // it), so this compares like with like without re-deriving either side.
  const fixture = JSON.parse(await readFile('evals/cases/tier/invisibility.json', 'utf8')) as {
    banned_patterns: string[];
  };
  expect([...fixture.banned_patterns].sort()).toEqual(
    BANNED_PATTERNS.map((pattern) => pattern.source).sort(),
  );
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

test("src/pages/fit/run.ts's source never mentions setting a cookie", async () => {
  // NAMED for what this actually checks (Task 16 fix round 1, finding 5): a
  // grep of the SOURCE, not a response. It is cheap and catches an obvious
  // regression fast, but it cannot see a cookie set through a helper, a
  // framework default, or any code path this file's own text does not name.
  // The runtime property -- no `Set-Cookie` on a real, successful response --
  // is asserted for real in tests/fit-pages.test.ts's "a successful
  // /fit/run response sets no cookie", against the harness that already
  // exists there for exactly this route.
  const source = await readFile('src/pages/fit/run.ts', 'utf8');
  expect(source).not.toMatch(/set-cookie/i);
});
