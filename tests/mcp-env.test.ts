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

test('no wrangler config declares the signing-key seam', async () => {
  // The seam's first safety property (src/lib/tier/grant.ts's `signingKey`):
  // the deployed behaviour comes from the var being ABSENT. This is the test
  // that keeps it absent -- a `vars` entry added to either config, for any
  // reason, would make production sign with a constant committed to a public
  // repo.
  for (const path of ['wrangler.jsonc', 'workers/mcp/wrangler.jsonc']) {
    const source = await readFile(path, 'utf8');
    expect(source, `${path} must not declare RLME_TOKEN_KEY_SOURCE`).not.toContain(
      'RLME_TOKEN_KEY_SOURCE',
    );
  }
});
