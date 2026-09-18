import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/**
 * THE DEFAULT THIS FILE EXISTS TO KEEP GONE. `mint` used to resolve `--scopes`
 * against `SCOPES.join(',')`, so a mint that forgot the flag issued every scope
 * there is, the two withheld ones included. That was silent in the only
 * direction that matters: an unknown scope is refused by `isScope` and a typo
 * is therefore loud, while an omitted flag produced a working token, an honored
 * `POST /grant`, and a `minted` line an operator had already decided was a
 * success.
 *
 * The skill document had told the operator to pass the flag on every mint since
 * `evals` landed, and the default was not changed then. That is the pattern the
 * test is here for rather than the single mistake: the set a forgotten flag
 * hands over grows every time `SCOPES` does, and a rule resting on nobody
 * forgetting is the inversion `src/lib/tier/private-docs.ts` argues against
 * everywhere else in this repository.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/token.mjs', import.meta.url));

/**
 * The script's stderr, with the mint kept away from every credential it would
 * otherwise reach.
 *
 * Three separate things make that true, because the refusal under test is
 * supposed to happen before any of them and a test that assumed so would prove
 * nothing if it stopped happening. `PATH: ''` leaves the script's own
 * `execFileSync('npx', ...)` unable to resolve a binary at all, so wrangler and
 * therefore D1 are unreachable whatever the argument checks do (the technique
 * and its measurement are `tests/private-doc-keys.test.ts`'s). The signing key
 * is stripped from the child, so `signingKey()` throws rather than signing.
 * And `process.execPath` rather than `'node'` because libuv resolves the
 * spawned binary against the CHILD's PATH, where a bare name with no PATH is
 * itself ENOENT.
 */
function mintStderr(args: string[]): string {
  const { RLME_TOKEN_SIGNING_KEY: _withheld, ...env } = process.env;
  try {
    execFileSync(process.execPath, [SCRIPT, 'mint', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, PATH: '' },
    });
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? '');
  }
  throw new Error(`mint ${args.join(' ')} succeeded, which no test may let it do`);
}

test('a mint with no --scopes refuses instead of issuing the whole set', () => {
  const stderr = mintStderr(['--audience', 'a-test-audience', '--days', '30']);

  expect(stderr).toContain('--scopes is required');

  // The refusal has to land BEFORE the signing key is read, and this is the
  // assertion that says so. `signingKey()` is the next thing `mint` touches,
  // so its message appearing here would mean the argument checks had let the
  // mint through and only the missing credential stopped it -- which is
  // precisely what happened before this change, measured 2026-09-17.
  expect(stderr).not.toContain('RLME_TOKEN_SIGNING_KEY');
});

test('a mint that names its scopes gets past the check', () => {
  // The other half of the contract, and the reason the test above is not
  // satisfied by a `mint` that refuses everything. `--scopes fit` reaches
  // `signingKey()`, which is as far as any test may take a mint.
  const stderr = mintStderr(['--audience', 'a-test-audience', '--scopes', 'fit', '--days', '30']);

  expect(stderr).toContain('RLME_TOKEN_SIGNING_KEY');
  expect(stderr).not.toContain('--scopes is required');
});

test('the withheld scopes are still mintable when they are asked for by name', () => {
  // `evals` belongs to the eval harness and `authoring` to the owner's
  // drafting client, and both are ordinary mints when named. What changed is
  // what SILENCE means, not what the flag can say.
  for (const scopes of ['evals,fit', 'fit,authoring']) {
    const stderr = mintStderr([
      '--audience',
      'a-test-audience',
      '--scopes',
      scopes,
      '--days',
      '30',
    ]);
    expect(stderr, scopes).toContain('RLME_TOKEN_SIGNING_KEY');
    expect(stderr, scopes).not.toContain('unknown scopes');
  }
});
