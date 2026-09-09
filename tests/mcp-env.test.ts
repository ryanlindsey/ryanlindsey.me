import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { MCP_BINDING_NAMES } from '../workers/mcp/src/env';

const dir = mkdtempSync(join(tmpdir(), 'mcp-types-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// `wrangler types` reads the config with wrangler's own parser and needs no
// credentials -- it never contacts the account. `--include-runtime=false` is
// what makes this cheap and what makes the output safe to parse: without it
// the file is tens of thousands of lines of workerd globals.
test('McpEnv lists exactly the bindings workers/mcp/wrangler.jsonc declares', () => {
  const out = join(dir, 'mcp-types.d.ts');
  execFileSync(
    'npx',
    [
      'wrangler',
      'types',
      '--config',
      'workers/mcp/wrangler.jsonc',
      '--env-interface',
      'McpBindings',
      '--include-runtime=false',
      out,
    ],
    { stdio: 'pipe' },
  );

  const body = readFileSync(out, 'utf8');
  const block = /interface __BaseEnv_McpBindings \{([^}]*)\}/.exec(body);
  expect(block, 'wrangler types emitted no McpBindings interface').not.toBeNull();

  const declared = [...block![1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!).sort();
  expect(declared).toEqual([...MCP_BINDING_NAMES].sort());
});

test('no wrangler config declares a day-5 test-only seam', async () => {
  // Each of these seams has the same first safety property: the deployed
  // behaviour comes from the var being ABSENT, so nothing has to remember to
  // set it correctly in production. This is the test that keeps them absent.
  //
  // `RLME_TOKEN_KEY_SOURCE` (src/lib/tier/grant.ts's `signingKey`): a `vars`
  // entry added to either config, for any reason, would make production sign
  // tokens with a constant committed to a public repo.
  //
  // `FIT_ENGINE` (src/lib/fit/engine.ts's `analyzeFit`): the only value it
  // accepts is `'off'`, so a `vars` entry could only ever turn the fit engine
  // off in production -- silently, since the tool would keep answering a
  // polite sentence about being unavailable and every test would stay green.
  for (const name of ['RLME_TOKEN_KEY_SOURCE', 'FIT_ENGINE']) {
    for (const path of ['wrangler.jsonc', 'workers/mcp/wrangler.jsonc']) {
      const source = await readFile(path, 'utf8');
      expect(source, `${path} must not declare ${name}`).not.toContain(name);
    }
  }
});
