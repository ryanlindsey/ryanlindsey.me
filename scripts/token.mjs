#!/usr/bin/env node
// Mint, list and revoke scoped tokens (03 §3). OWNER-RUN, from a terminal
// where `wrangler` is already OAuth-authenticated.
//
// WHY THIS SHELLS OUT TO WRANGLER rather than talking to D1 over the API:
// there is then no credential for this script to hold, read or leak. It has
// no configuration, no token file and no environment variable of its own --
// wrangler's own login is the only authority involved, exactly as 10 §2.3
// specifies for every provisioning path.
//
// WHAT IT PRINTS. `mint` prints the token once, to stdout, and nothing else
// ever prints it again: the registry stores claims, not the value. Redirect
// it or copy it; there is no recovery. `list` and `revoke` print no secret
// material at all and are safe to run in any session -- which is the point of
// splitting them from `mint`.
//
// THE SIGNING KEY IS NEVER SEEN BY THIS SCRIPT EITHER, in the sense that
// matters: `mint` reads it from the local Secrets Store through wrangler --
// the one place 10 §3.4 permits a value to exist on the owner's machine --
// into a variable that is never logged, never passed as an argument to
// another process, and never written to disk.
//
// Usage:
//   node scripts/token.mjs mint --audience <label> --scopes fit,profile --days 30 [--note "..."]
//   node scripts/token.mjs list
//   node scripts/token.mjs revoke --jti <jti>
//
// `--remote` is implied for list/revoke: the registry that matters is the
// deployed one. `mint` writes to it too.

import { execFileSync } from 'node:child_process';
import { mintToken, newJti, SCOPES } from '../src/lib/tier/token.ts';

const STORE_ID = '3b06d2a92de642d999509352cfd3ebed';
const SECRET_NAME = 'RLME_TOKEN_SIGNING_KEY';
const DB = 'ryanlindsey-me-db';
// Public (already committed in both wrangler.jsonc files); hardcoded because this login resolves two accounts and wrangler cannot pick one non-interactively.
const ACCOUNT_ID = '1b764d090899bf1ee61a8d1e87c10710';

function wrangler(args, { capture = true } = {}) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  });
}

function d1(sql) {
  const out = wrangler(['d1', 'execute', DB, '--remote', '--json', '--command', sql]);
  return JSON.parse(out)[0].results;
}

/**
 * SQL string literal.
 *
 * Applied UNIFORMLY to every value this script interpolates, which is what
 * makes the distinction below not matter for correctness -- but the comment
 * that used to sit here said "every value this script binds is
 * operator-supplied", and that is simply false (deferred minor L304): `jti`
 * comes from the CSPRNG and the `issued_at`/`expires_at` timestamps are
 * `toISOString()` output. Both are script-generated. Recorded accurately
 * because the false version read as a justification for quoting less
 * carefully somewhere, which is the edit it would have licensed.
 */
function quote(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

async function mint() {
  const audience = arg('audience');
  const days = Number(arg('days', '30'));
  const note = arg('note', null);
  const scopes = String(arg('scopes', SCOPES.join(',')))
    .split(',')
    .map((s) => s.trim());

  if (!audience) throw new Error('--audience is required');
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
  const unknown = scopes.filter((s) => !SCOPES.includes(s));
  if (unknown.length > 0) throw new Error(`unknown scopes: ${unknown.join(', ')}`);

  // Read into a local only. Never logged, never passed as an argument to
  // another process, never written to disk.
  const key = wrangler([
    'secrets-store',
    'secret',
    'get',
    STORE_ID,
    '--name',
    SECRET_NAME,
    '--remote',
  ]).trim();

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    jti: newJti(),
    aud: audience,
    scopes,
    iat: now,
    exp: now + Math.round(days * 86400),
  };
  const token = await mintToken(key, claims);

  d1(
    `INSERT INTO access_tokens (jti, audience, scopes, issued_at, expires_at, revoked_at, note)
     VALUES (${quote(claims.jti)}, ${quote(audience)}, ${quote(JSON.stringify(scopes))},
             ${quote(new Date(claims.iat * 1000).toISOString())},
             ${quote(new Date(claims.exp * 1000).toISOString())}, NULL, ${quote(note)})`,
  );

  process.stderr.write(
    `minted ${claims.jti} for audience ${audience}, scopes ${scopes.join(',')}, expires ${new Date(
      claims.exp * 1000,
    ).toISOString()}\n`,
  );
  // The token, and only the token, on stdout -- so `> token.txt` captures
  // exactly the thing to hand over and none of the commentary.
  process.stdout.write(`${token}\n`);
}

function list() {
  const rows = d1('SELECT * FROM access_tokens ORDER BY issued_at DESC');
  if (rows.length === 0) {
    process.stdout.write('no tokens issued\n');
    return;
  }
  for (const row of rows) {
    const state = row.revoked_at ? `revoked ${row.revoked_at}` : `expires ${row.expires_at}`;
    // `row.scopes` arrives from `wrangler d1 execute --json` as JSON TEXT
    // (`["fit","profile"]`), so wrapping it in another pair of brackets
    // printed `[["fit","profile"]]` (deferred minor L301). Parsed and
    // re-joined instead, which is also what makes the column readable at a
    // glance. Falls back to the raw value rather than throwing: this is
    // owner tooling, and a listing that dies on one odd row is worse than
    // one that shows it verbatim.
    let scopes = row.scopes;
    try {
      const parsed = JSON.parse(row.scopes);
      if (Array.isArray(parsed)) scopes = parsed.join(', ');
    } catch {
      // keep the raw value
    }
    process.stdout.write(`${row.jti}  ${row.audience}  [${scopes}]  ${state}\n`);
  }
}

function revoke() {
  const jti = arg('jti');
  if (!jti) throw new Error('--jti is required');
  const at = new Date().toISOString();
  d1(
    `UPDATE access_tokens SET revoked_at = ${quote(at)} WHERE jti = ${quote(jti)} AND revoked_at IS NULL`,
  );
  const [row] = d1(`SELECT revoked_at FROM access_tokens WHERE jti = ${quote(jti)}`);
  if (!row) process.stdout.write(`no such token: ${jti}\n`);
  else if (row.revoked_at === at) process.stdout.write(`revoked ${jti} at ${at}\n`);
  else process.stdout.write(`${jti} was already revoked at ${row.revoked_at}; nothing changed\n`);
}

const command = process.argv[2];
const commands = { mint, list, revoke };
if (!commands[command]) {
  process.stderr.write('usage: token.mjs <mint|list|revoke> [...]\n');
  process.exit(2);
}
await commands[command]();
