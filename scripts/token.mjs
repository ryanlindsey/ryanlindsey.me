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
// THE SIGNING KEY CANNOT BE READ BY THIS SCRIPT, and the version of this
// comment that stood here until 2026-09-10 said the opposite. It said `mint`
// "reads it from the local Secrets Store through wrangler -- the one place
// 10 §3.4 permits a value to exist on the owner's machine". That was never
// true, and it is written out rather than quietly deleted because the mistake
// is instructive: the design was right and the mechanism was assumed.
//
// A CLOUDFLARE SECRETS STORE SECRET IS WRITE-ONLY. Values go in and never come
// back out of the API. MEASURED in wrangler 4.129.0's own source: the
// `secrets-store secret get` handler fetches
// `GET /accounts/{a}/secrets_store/stores/{s}/secrets/{id}` and renders a
// METADATA TABLE -- Name, ID, StoreID, Comment, Scopes, Status, Created,
// Modified. There is no value field, for `--secret-id`, for the older
// `getSecretByName`, or for the local `--persist-to` path (which hands back a
// name). The `create` command's own help says the rest of it out loud: `--value`
// is "Only for testing. Not secure as this will leave secret value in plain-text
// in terminal history."
//
// So the key is readable ONLY by a Worker, through its binding -- which is
// exactly the property 10 §3.4 wanted, arrived at more completely than intended.
// The consequence is that SIGNING MUST HAPPEN INSIDE A WORKER, and this script
// cannot do it alone.
//
// HOW THE OLD VERSION FAILED. It fed wrangler's stdout to `mintToken` as the
// key. Today that stdout is a usage error (`--name` was removed in favour of
// `--secret-id`), so it throws; before that it would have been a metadata table,
// and the script would have cheerfully signed a token with a box-drawing
// character as its HMAC key and printed it. Every such token would verify as
// `bad_signature` at the Worker, which reads as a key-rotation problem rather
// than a minting one. Two facts show it had never worked: `access_tokens` was
// empty, and no test covers this path -- every suite signs with
// `TEST_SIGNING_KEY` through the `RLME_TOKEN_KEY_SOURCE: 'test'` seam, so the
// seam that makes the tests possible is also what hid this.
//
// `--signer` IS THE SPLIT THAT RESULTS. This script still does everything it
// can do without a credential: parse arguments, validate scopes against
// `SCOPES`, build the claims, write the registry row, and keep the output
// discipline below. It delegates exactly one step -- turning claims into a
// signed token -- to a Worker reachable at `--signer`, which holds the binding.
// Without `--signer`, `mint` REFUSES rather than guessing.
//
// THE SIGNER IS A TEMPORARY, LOCAL ROUTE, added for a mint and deleted before
// committing -- the same shape as the day-6 stream-framing probe. It is not a
// deployed surface: an endpoint whose whole job is issuing credentials deserves
// its own threat model before it exists in production, and a mint happens a
// handful of times a year. Paste this into `workers/mcp/src/index.ts` above the
// `createMcpHandler` return, run `npx wrangler dev --config
// workers/mcp/wrangler.jsonc --remote --port 8799`, mint, then delete it:
//
//   // TEMPORARY -- token signer. DELETE BEFORE COMMITTING.
//   if (pathname === '/__sign' && request.method === 'POST') {
//     return (async () => {
//       const { mintToken } = await import('../../../src/lib/tier/token');
//       const { signingKey } = await import('../../../src/lib/tier/grant');
//       const claims = await request.json();
//       return new Response(await mintToken(await signingKey(env), claims));
//     })();
//   }
//
// Usage:
//   node scripts/token.mjs mint --audience <label> --scopes fit,profile --days 30 \
//     --signer http://127.0.0.1:8799/__sign [--note "..."]
//   node scripts/token.mjs list
//   node scripts/token.mjs revoke --jti <jti>
//
// `--remote` is implied for list/revoke: the registry that matters is the
// deployed one. `mint` writes to it too.

import { execFileSync } from 'node:child_process';
import { newJti, SCOPES, isScope, TOKEN_SCHEME } from '../src/lib/tier/token.ts';

// The Secrets Store id and the signing key's name are GONE from this file, and
// their absence is the point: this script no longer reaches for a value it
// cannot have. Both still live in the two wrangler.jsonc files, which is where
// a binding is declared and the only place either belongs.
const DB = 'ryanlindsey-me-db';
// Public (already committed in both wrangler.jsonc files); hardcoded because this login resolves two accounts and wrangler cannot pick one non-interactively.
const ACCOUNT_ID = '1b764d090899bf1ee61a8d1e87c10710';

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
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

/**
 * Turns claims into a signed token, via a Worker that holds the binding.
 *
 * VALIDATED ON THE WAY BACK, because the failure this replaces was a silent
 * one. A signer that answers with an error page, a wrangler banner or an empty
 * body would otherwise become a "token" that fails as `bad_signature` at the
 * far end -- indistinguishable from a rotated key, and the exact confusion that
 * cost this script its correctness for a week. `TOKEN_SCHEME` is the cheapest
 * thing to check that only a real mint produces.
 */
async function sign(signer, claims) {
  let response;
  try {
    response = await fetch(signer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(claims),
    });
  } catch (cause) {
    throw new Error(
      `the signer at ${signer} could not be reached; is \`wrangler dev --remote\` running?`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(`the signer at ${signer} answered ${response.status}`);
  }
  const token = (await response.text()).trim();
  if (!token.startsWith(`${TOKEN_SCHEME}.`)) {
    throw new Error(
      `the signer at ${signer} did not return a ${TOKEN_SCHEME} token; ` +
        'it answered something else, and signing it into the registry would have ' +
        'produced a credential that fails as bad_signature at the Worker.',
    );
  }
  return token;
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
  const unknown = scopes.filter((s) => !isScope(s));
  if (unknown.length > 0) throw new Error(`unknown scopes: ${unknown.join(', ')}`);

  const signer = arg('signer');
  if (!signer) {
    throw new Error(
      '--signer is required: the signing key lives in Secrets Store and is readable only ' +
        'by a Worker through its binding, so this script cannot sign on its own. See the ' +
        'header of this file for the temporary /__sign route to run under `wrangler dev`.',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    jti: newJti(),
    aud: audience,
    scopes,
    iat: now,
    exp: now + Math.round(days * 86400),
  };
  const token = await sign(signer, claims);

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
