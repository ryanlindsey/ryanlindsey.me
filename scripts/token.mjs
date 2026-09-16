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
// it or copy it; there is no recovery. A mint whose verification FAILS prints
// nothing to stdout at all and exits 1, so the value is gone and the row is
// the only trace -- which is why that branch prints the jti and the revoke
// command. `list` and `revoke` print no secret material at all and are safe to
// run in any session -- which is the point of splitting them from `mint`.
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
// DEPLOYED Worker at `POST /grant` and refusing to report success unless it
// comes back honored, with the audience just written. `/grant` rather than
// `tools/list` for a reason measured on 2026-09-15 and written out at
// `verify()` below: the public tools answer every caller, so `tools/list`
// cannot tell a refused token from a good one.
//
// WHAT THIS REPLACED, so it is not rebuilt by accident: a `--signer` flag
// pointing at a temporary `/__sign` route, pasted into the MCP Worker for a
// mint and deleted before committing. It worked, and it cost a `wrangler dev
// --remote` session and an uncommitted edit to the Worker every time a token
// was needed. An endpoint whose whole job is issuing credentials is also a
// thing to not have, even briefly.
//
// Usage (`op run` substitutes `op://` references that are ALREADY in the
// environment, so export RLME_TOKEN_SIGNING_KEY as one first, or point
// `--env-file` at a file holding it; bare `op run` injects nothing):
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
// The deployed MCP Worker, which `mint` presents each fresh token to.
// Public, and hardcoded for the same reason the account id below is: there
// is no config for this script to read. workers/mcp/src/index.ts and
// src/pages/llms.txt.ts each already carry their own copy of this origin.
const MCP_ORIGIN = 'https://mcp.ryanlindsey.me';
// Public (already committed in both wrangler.jsonc files); hardcoded because this login resolves two accounts and wrangler cannot pick one non-interactively.
const ACCOUNT_ID = '1b764d090899bf1ee61a8d1e87c10710';

function wrangler(args) {
  // THE SIGNING KEY IS WITHHELD FROM THE CHILD, and that is not decoration:
  // this spread otherwise hands RLME_TOKEN_SIGNING_KEY to `npx`, to `wrangler`,
  // and to anything either of them spawns -- a process tree whose whole job is
  // talking to the Cloudflare API. `signingKey()` below says the value goes
  // from the injector to this process and nowhere else, and this line is what
  // makes that sentence true rather than aspirational. Nothing under `npx`
  // has any use for it: wrangler authenticates with its own OAuth login.
  const { RLME_TOKEN_SIGNING_KEY: _withheld, ...childEnv } = process.env;
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...childEnv, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
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
        'password manager so the value reaches this process without ever being ' +
        'typed, stored on disk or printed. NOTE THAT `op run` ALONE IS NOT ENOUGH: ' +
        'it substitutes `op://` references already present in the environment, so ' +
        'either export RLME_TOKEN_SIGNING_KEY as an `op://vault/item/field` ' +
        'reference first, or point `op run --env-file=<file>` at a file holding ' +
        'one. Without that this command runs with nothing injected and fails here.',
    );
  }
  return key;
}

/**
 * Proves the freshly minted token against the DEPLOYED Worker.
 *
 * ASKS `POST /grant`, NOT `tools/list`, and that difference is the whole value
 * of this function. Task 4's spec said `tools/list`; MEASURED against the code
 * on 2026-09-15, that check cannot fail. `registerTools` registers the eight
 * public tools for EVERY caller (workers/mcp/src/tools.ts), and a refused
 * token is not rejected -- workers/mcp/src/index.ts logs `mcp/grant: refused a
 * presented token` and serves the public tier anyway. So a diverged key would
 * have answered with eight names, `names.length === 0` would never have fired,
 * and `mint` would have printed a confident success line over the exact
 * misdiagnosis this file's header warns about twice.
 *
 * `/grant` answers the question this function is actually asking. It returns a
 * body only when `resolveGrant` produced a live grant, and falls through to the
 * genuine unrouted 404 for every refusal (workers/mcp/src/grant-context.ts),
 * so `response.ok` IS "the Worker honored this token". Its `tools` field is
 * `grantedToolNames(grant)`, the GATED tools this token opens and nothing else,
 * which is what makes the line printed below worth reading -- and what the
 * spec's own expected output for this step, `analyze_fit` alone, describes.
 * `tools/list` could not have produced that line either.
 *
 * THE AUDIENCE IS COMPARED TOO, which `tools/list` could not have done at all:
 * it proves the registry row written a moment ago is the row the Worker read
 * back, so a row that did not land fails here rather than on first use.
 *
 * A REFUSAL IS NOT FATAL TO THE ROW. The token is already recorded by the time
 * this runs, deliberately: a mint that verified before writing would be a
 * credential nobody can revoke if the write then failed. A failed verification
 * prints the jti so the operator can revoke it.
 */
async function verify(token, audience) {
  let response;
  try {
    response = await fetch(`${MCP_ORIGIN}/grant`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'ryanlindsey-me-token/1' },
    });
  } catch (cause) {
    // UNREACHABLE IS NOT REFUSED, and the two are worth separating because only
    // the second is evidence about the token. Node's fetch rejects with a bare
    // "fetch failed" and puts the real reason in `cause`, so it is unwrapped
    // here rather than dropped -- the signer-based version this replaces named
    // its likely reason too, and losing that would be a regression.
    throw new Error(
      'the deployed Worker could not be reached, so this token is UNVERIFIED rather than ' +
        `bad: ${cause?.cause?.message ?? cause?.message ?? cause}`,
    );
  }
  if (response.status === 404) {
    throw new Error(
      'the deployed Worker REFUSED this token: `POST /grant` fell through to the 404 that ' +
        'every refusal returns. The likeliest cause is that RLME_TOKEN_SIGNING_KEY no longer ' +
        'matches the Secrets Store copy the Worker reads -- reconcile the two before minting ' +
        'anything else. A registry row that did not land reads identically from out here.',
    );
  }
  if (!response.ok) {
    throw new Error(
      `the deployed Worker answered ${response.status} on /grant, which is neither a grant ` +
        'nor the 404 a refusal returns; this token is UNVERIFIED rather than known bad.',
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('the deployed Worker answered 200 on /grant with a body that is not JSON');
  }
  if (body.audience !== audience) {
    throw new Error(
      `the deployed Worker resolved this token to audience ${JSON.stringify(body.audience)}, ` +
        `not ${JSON.stringify(audience)} -- the registry row this mint just wrote is not the ` +
        'row it read back.',
    );
  }
  return { tools: body.tools ?? [], expiresAt: body.expiresAt };
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
    honored = await verify(token, audience);
  } catch (error) {
    process.stderr.write(
      `MINTED BUT NOT VERIFIED: ${claims.jti}. ${error?.message ?? error}\n` +
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
  process.stderr.write(
    `verified against the deployed Worker: ${honored.tools.join(', ') || 'no gated tools'}` +
      `, audience ${audience}, expires ${honored.expiresAt}\n`,
  );
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
