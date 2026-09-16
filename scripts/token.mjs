#!/usr/bin/env node
// Mint, list and revoke scoped tokens (03 §3). OWNER-RUN, from a terminal
// where `wrangler` is already OAuth-authenticated.
//
// WHY THIS SHELLS OUT TO WRANGLER rather than talking to D1 over the API:
// there is then no credential for this script to hold, read or leak. It has no
// configuration and no token file, and wrangler's own login is the only
// authority involved in reaching the registry, exactly as 10 §2.3 specifies for
// every provisioning path.
//
// UNTIL 2026-09-15 that sentence also said "no environment variable of its
// own", and `mint` now reads one: RLME_TOKEN_SIGNING_KEY. The distinction it
// was reaching for survives, and is worth stating precisely rather than
// deleting. This script still SOURCES no credential: it does not know where
// the key is kept, cannot fetch it, and holds nothing that would let it. The
// value is injected by whatever runs the command and exists only in this
// process's environment. What changed is that the script can now be HANDED a
// credential, which is not the same as holding one.
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
// So THE CLOUDFLARE COPY of the key is readable ONLY by a Worker, through its
// binding -- which is exactly the property 10 §3.4 wanted, arrived at more
// completely than intended.
//
// THAT MEASUREMENT STANDS; the conclusion drawn from it did not. Until
// 2026-09-15 this paragraph ended "the consequence is that SIGNING MUST HAPPEN
// INSIDE A WORKER, and this script cannot do it alone", and the `--signer`
// mechanism below was built on it. The step it skipped is that Cloudflare's
// copy was never the only copy -- see HOW SIGNING WORKS NOW, below. The error
// is recorded rather than deleted for the same reason as the one above it: a
// write-only store makes a value unreadable, not unpossessed, and that is an
// easy inference to make twice.
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
// HOW SIGNING WORKS NOW, and why the Worker is gone from this path. The key
// has always had two copies: Cloudflare's, in write-only Secrets Store, and the
// one in the owner's password manager, which has to exist because a value that
// cannot be read back cannot be re-provisioned. This script signs from the
// second, injected as RLME_TOKEN_SIGNING_KEY by whatever runs it, and never
// reads it from anywhere itself.
//
// The cost of that is divergence -- two copies can drift apart, and the failure
// reads as a bad token rather than a stale key, which is the misdiagnosis
// recorded above. `mint` therefore ends by presenting the fresh token to the
// DEPLOYED Worker and refusing to report success unless it is honored.
//
// WHAT THIS REPLACED, so it is not rebuilt by accident: a `--signer` flag
// pointing at a temporary `/__sign` route, pasted into the MCP Worker for a
// mint and deleted before committing. It worked, and it cost a `wrangler dev
// --remote` session and an uncommitted edit to the Worker every time a token
// was needed. An endpoint whose whole job is issuing credentials is also a
// thing to not have, even briefly.
//
// Usage:
//   op run -- node scripts/token.mjs mint --audience <label> --scopes fit,profile --days 30 [--note "..."]
//   node scripts/token.mjs list
//   node scripts/token.mjs revoke --jti <jti>
//   node scripts/token.mjs revoke --audience <label>
//
// `--remote` is implied for list/revoke: the registry that matters is the
// deployed one. `mint` writes to it too.

import { execFileSync } from 'node:child_process';
import { newJti, SCOPES, isScope, mintToken } from '../src/lib/tier/token.ts';

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
 * The signing key, from the environment.
 *
 * NOT READ FROM ANYWHERE. This script still holds no credential of its own and
 * knows nothing about where the value comes from -- it is injected by whatever
 * runs the command, which for the owner is `op run` against the copy in the
 * password manager. That keeps the 1Password dependency out of this file, out
 * of the test surface, and out of any agent's context: the value goes from the
 * injector to this process and nowhere else.
 *
 * WHY THIS CAN SIGN AT ALL, when the version before it could not. The
 * Cloudflare copy of this key lives in Secrets Store, which is write-only --
 * measured, and written out in the header above. There is a second copy,
 * because there has to be: a value that cannot be read back cannot be
 * re-provisioned or rotated into a second environment without one. Signing
 * from that copy is what removes the Worker from this path.
 *
 * WHAT IT MAKES POSSIBLE FOR THE FIRST TIME, and why `mint` verifies below:
 * the two copies can DIVERGE. Rotate in Secrets Store and miss the other, and
 * every token minted here fails as `bad_signature` at the Worker -- which is
 * indistinguishable from a bad mint, and is exactly the misdiagnosis recorded
 * in this file's header.
 */
function signingKey() {
  const key = process.env.RLME_TOKEN_SIGNING_KEY;
  if (typeof key !== 'string' || key === '') {
    throw new Error(
      'RLME_TOKEN_SIGNING_KEY is not in the environment. Run this under your ' +
        'password manager, for example `op run -- npm run token -- mint ...`, so ' +
        'the value reaches this process without ever being typed, stored on disk ' +
        'or printed.',
    );
  }
  return key;
}

/**
 * Proves the freshly minted token against the DEPLOYED Worker.
 *
 * The check that the old signer-based `sign()` performed on the way back was
 * that the response looked like a token. This is strictly stronger: it asks the
 * Worker that will actually receive this credential whether it honors it, so
 * a diverged key, a registry row that did not land and a scope typo all fail
 * here, loudly, at the moment they are cheap to fix.
 *
 * A REFUSAL IS NOT FATAL TO THE ROW. The token is already recorded by the time
 * this runs, deliberately: a mint that verified before writing would be a
 * credential nobody can revoke if the write then failed. A failed verification
 * prints the jti so the operator can revoke it.
 */
async function verify(token) {
  const response = await fetch('https://mcp.ryanlindsey.me/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'user-agent': 'ryanlindsey-me-token/1',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const text = await response.text();
  const payload =
    text.startsWith('event:') || text.startsWith('data:')
      ? (text.split('\n').find((line) => line.startsWith('data:')) ?? '{}').slice(5).trim()
      : text;
  let names = [];
  try {
    const body = JSON.parse(payload);
    names = (body.result?.tools ?? []).map((tool) => tool.name).filter(Boolean);
  } catch {
    throw new Error(`the deployed Worker answered something unparseable (${response.status})`);
  }
  if (names.length === 0) {
    throw new Error(
      'the deployed Worker honored no tools for this token. The likeliest cause is that ' +
        'RLME_TOKEN_SIGNING_KEY no longer matches the Secrets Store copy the Worker reads: ' +
        'reconcile the two before minting anything else.',
    );
  }
  return names;
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

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    jti: newJti(),
    aud: audience,
    scopes,
    iat: now,
    exp: now + Math.round(days * 86400),
  };
  const token = await mintToken(signingKey(), claims);

  d1(
    `INSERT INTO access_tokens (jti, audience, scopes, issued_at, expires_at, revoked_at, note)
     VALUES (${quote(claims.jti)}, ${quote(audience)}, ${quote(JSON.stringify(scopes))},
             ${quote(new Date(claims.iat * 1000).toISOString())},
             ${quote(new Date(claims.exp * 1000).toISOString())}, NULL, ${quote(note)})`,
  );

  let honored;
  try {
    honored = await verify(token);
  } catch (error) {
    process.stderr.write(
      `MINTED BUT NOT VERIFIED: ${claims.jti}. ${error.message}\n` +
        `Revoke it with: node scripts/token.mjs revoke --jti ${claims.jti}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write(
    `minted ${claims.jti} for audience ${audience}, scopes ${scopes.join(',')}, expires ${new Date(
      claims.exp * 1000,
    ).toISOString()}\n`,
  );
  process.stderr.write(`verified against the deployed Worker: ${honored.join(', ')}\n`);
  // The token, and only the token, on stdout -- so `> token.txt` captures
  // exactly the thing to hand over and none of the commentary. Everything
  // above is on stderr for that reason, the verification line included.
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

/**
 * Revoke one token, or every live token for an audience.
 *
 * `--audience` IS THE KILL SWITCH FOR A CAMPAIGN, and it exists because the
 * campaign's own `status` is not one: authorization reads the signature and
 * this registry, never KV, so flipping an entry to `retired` stops nothing
 * that is already in someone's inbox. Revocation is a registry fact, and this
 * makes it one command instead of one per token.
 *
 * `revoked_at IS NULL` in the UPDATE is what keeps a second run from
 * overwriting the original revocation timestamp with today's.
 */
function revoke() {
  const jti = arg('jti');
  const audience = arg('audience');
  if (!jti && !audience) throw new Error('--jti or --audience is required');
  if (jti && audience) throw new Error('--jti and --audience are mutually exclusive');
  const at = new Date().toISOString();

  if (audience) {
    const live = d1(
      `SELECT jti FROM access_tokens WHERE audience = ${quote(audience)} AND revoked_at IS NULL`,
    );
    if (live.length === 0) {
      // An empty result has two causes and they are not equally safe: every
      // token for this audience is already revoked, or the label is wrong and
      // the real tokens are still live. The prescribed message said "no live
      // tokens" for both, which reads as reassurance in the second case --
      // and `id` and `tokenAudience` are separate fields on a campaign entry
      // (src/lib/tier/campaigns.ts), so reaching for the wrong one is an
      // ordinary mistake rather than a typo. On the KILL SWITCH, the path
      // that revoked nothing is the one that must not sound calm. Costs one
      // COUNT, on the branch that was already the cheap one.
      const [all] = d1(
        `SELECT COUNT(*) AS n FROM access_tokens WHERE audience = ${quote(audience)}`,
      );
      process.stdout.write(
        all.n === 0
          ? `audience ${audience} has no tokens at all; check the label\n`
          : `all ${all.n} token(s) for audience ${audience} were already revoked\n`,
      );
      return;
    }
    d1(
      `UPDATE access_tokens SET revoked_at = ${quote(at)}
         WHERE audience = ${quote(audience)} AND revoked_at IS NULL`,
    );
    for (const row of live) process.stdout.write(`revoked ${row.jti} at ${at}\n`);
    process.stdout.write(`revoked ${live.length} token(s) for audience ${audience}\n`);
    return;
  }

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
