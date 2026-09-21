import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/**
 * `calls` takes exactly one of `--jti` and `--audience`, and refuses before it
 * touches wrangler. The refusal is the only half of the command a test can
 * reach: there is no D1 double in this repository, so the SQL and the output
 * are proven by the owner running it (the epic's 01 does the same for
 * `roster`). What this file guards is that a bad invocation never becomes a
 * query.
 *
 * The technique is tests/token-mint-scopes.test.ts's: `PATH: ''` so the
 * script's own `execFileSync('npx', ...)` cannot resolve a binary, the signing
 * key stripped, and `process.execPath` rather than `'node'` because libuv
 * resolves the child against the CHILD's PATH.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/token.mjs', import.meta.url));

function callsStderr(args: string[]): string {
  const { RLME_TOKEN_SIGNING_KEY: _withheld, ...env } = process.env;
  try {
    execFileSync(process.execPath, [SCRIPT, 'calls', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, PATH: '' },
    });
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? '');
  }
  throw new Error(`calls ${args.join(' ')} succeeded, which no test may let it do`);
}

test('calls with neither flag refuses with a usage line', () => {
  const stderr = callsStderr([]);
  expect(stderr).toContain('usage: token.mjs calls');
  expect(stderr).not.toContain('ENOENT');
});

test('calls with both flags refuses with a usage line', () => {
  const stderr = callsStderr(['--jti', 'abc', '--audience', 'a-test-audience']);
  expect(stderr).toContain('usage: token.mjs calls');
  expect(stderr).not.toContain('ENOENT');
});

test('calls with one flag gets past the check and reaches for wrangler', () => {
  // The other half of the contract: a well-formed invocation is stopped only
  // by the missing binary, which is as far as any test may take it.
  for (const args of [
    ['--jti', 'abc'],
    ['--audience', 'a-test-audience'],
  ]) {
    const stderr = callsStderr(args);
    expect(stderr, args.join(' ')).toContain('ENOENT');
    expect(stderr, args.join(' ')).not.toContain('usage: token.mjs calls');
  }
});
