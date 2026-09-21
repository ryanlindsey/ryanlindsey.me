#!/usr/bin/env node
// Put one document into the private tier's R2 bucket (09 §3 item 3: "doc
// authored outside every repository, pushed to R2/D1 by the local script, and
// confirmed absent from the history of both").
//
// THIS SCRIPT LIVES IN THE PUBLIC REPO AND THE DOCUMENTS DO NOT. That is the
// whole shape: the mechanism is generic and carries no audience-specific
// semantics -- it puts a file at a key -- while every document it deploys is
// authored outside every repository and is passed in by path. Nothing it
// writes enters ANY repo's history, and 10 §2.3 is satisfied by WHERE it is
// invoked from rather than by where it is stored.
//
// CORRECTED when the authoring moved out, in the epic that also added the
// `authoring/` namespace below. The quotation above used to read "doc authored
// in this repo", and the paragraph after it said the documents were authored
// in the private planning repo and that nothing written here entered THIS
// repo's history -- which undersold it, because absence from one history is
// now absence from both. 09 §3 item 3 was rewritten on 2026-09-17 and is
// quoted here in its current words; that plan item is the authority and this
// script is its implementation, so a paraphrase here is how the two drift.
//
// Usage, from the directory holding the document:
//   node /path/to/ryanlindsey.me/scripts/private-doc.mjs put \
//     --key profile/availability.md --file availability.md
//   node /path/to/ryanlindsey.me/scripts/private-doc.mjs check --key profile/availability.md
//   node /path/to/ryanlindsey.me/scripts/private-doc.mjs delete --key narrative/foo.md
//   node /path/to/ryanlindsey.me/scripts/private-doc.mjs roster
//
// Keys must match what src/lib/tier/private-docs.ts builds. The script
// re-checks the shape rather than trusting the caller, because a typo here
// produces a document no tool will ever find and no error anyone will ever
// see.
//
// NO `list` VERB. MEASURED against the installed wrangler on 2026-09-08, via
// `npx wrangler --version` and `npx wrangler r2 object --help`: its only
// subcommands are `get`, `put` and `delete`. (A first pass the same day read
// 4.128.0 -- this repo's `node_modules` had drifted from the lockfile's
// 4.129.0 pin -- and cited the pinned number rather than the one actually
// installed, which is exactly the mistake this comment now avoids. After
// `npm ci` restored the pinned install, `--version` read 4.129.0 and the
// subcommand list re-measured identical.) There is no object listing
// without S3-compatible credentials, which the provisioning split for this
// bucket deliberately does not create (10 §2.3 again: the owner's machine
// holds a `wrangler` OAuth login and nothing else). `check` is the
// replacement rather than a listing worked around some other way, because a
// listing over a private-document store would enumerate every gated key --
// including every narrative audience -- where a per-key probe only ever
// answers the one question a caller actually has: is THIS key there.
//
// `roster` is not a listing either. It probes the four FIXED keys in
// ./private-doc-keys.mjs one at a time, the keys every grant is promised,
// and names no audience. Added 2026-09-20 after all three profile keys were
// found absent with four reader tokens live and nothing here able to say so.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXED_KEYS } from './private-doc-keys.mjs';

const BUCKET = 'ryanlindsey-me-private';

// A PUBLIC identifier, not a secret: the same value already sits in both
// ./wrangler.jsonc and workers/mcp/wrangler.jsonc's `account_id`, committed
// in this public repo. It is hardcoded rather than left for wrangler to
// discover because this login resolves two Cloudflare accounts and wrangler
// then refuses to guess non-interactively ("More than one account
// available"), and because this script's documented invocation runs from a cwd
// outside this repo -- so neither `--config` nor cwd-relative config discovery
// would reach this file's account_id anyway. That second reason got STRONGER
// when the authoring moved out and this line was corrected with the header
// above: it used to say "a DIFFERENT repo's cwd", and the cwd is now reliably
// not a repo at all, so there is certainly no wrangler.jsonc beside it. Set into every child
// process's own environment below, so the caller's shell need not export it.
const ACCOUNT_ID = '1b764d090899bf1ee61a8d1e87c10710';

const KEY_PATTERN = /^(profile|case-study|narrative|authoring)\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  });
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || index === process.argv.length - 1 ? undefined : process.argv[index + 1];
}

function requireKey() {
  const key = arg('key');
  if (!key) throw new Error('--key is required');
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `key must be <profile|case-study|narrative|authoring>/<name>.md -- got ${JSON.stringify(key)}`,
    );
  }
  return key;
}

/**
 * Whether one key is in the bucket: `'present'`, `'absent'`, or an object
 * carrying wrangler's stderr when the answer is neither.
 *
 * `wrangler r2 object get` writes the object body to STDOUT unless `--file`
 * is given (measured: `-f, --file` and `-p, --pipe` are its only output
 * options). These are gated documents, so the body-catching form is not
 * stylistic -- it is what keeps the text out of this process's stdout and out
 * of whatever captures it next (a terminal scrollback, a CI log). The file is
 * never read; only the outcome is inspected, and it is removed before
 * returning either way.
 *
 * `absent` must mean the object is not there -- an auth failure, a network
 * error, or an unresolved account are NOT absence, and reporting them as
 * `absent` would tell a caller a deployed document does not exist, which is
 * worse than no answer.
 *
 * MEASURED 2026-09-08 by running this same `get --file` against a key
 * confirmed not to exist, with stderr captured instead of inherited:
 * wrangler's not-found error is
 *   [ERROR] The specified key does not exist.
 * wrapped in ANSI colour codes that never split that phrase -- stripped below
 * so a plain terminal, or a future wrangler version that drops colour, still
 * matches the same substring. Anything else is returned as an error for the
 * caller to print and fail on, instead of being read as a miss.
 */
function probe(key) {
  const dir = mkdtempSync(join(tmpdir(), 'rlme-private-doc-'));
  const file = join(dir, 'object');
  try {
    execFileSync(
      'npx',
      ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--file', file],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      },
    );
    return 'present';
  } catch (error) {
    const stderr = String(error.stderr ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    if (/specified key does not exist/i.test(stderr)) return 'absent';
    return { error: stderr || `${error.message}\n` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Print one probe's verdict the way `check` always has, optionally naming the key. */
function report(verdict, key) {
  if (typeof verdict === 'string') {
    process.stdout.write(key ? `${verdict.padEnd(7)}  ${key}\n` : `${verdict}\n`);
    return;
  }
  process.stderr.write(key ? `${key}: ${verdict.error}` : verdict.error);
  process.exitCode = 1;
}

const commands = {
  put() {
    const key = requireKey();
    const file = arg('file');
    if (!file) throw new Error('--file is required');
    if (!existsSync(file)) throw new Error(`no such file: ${file}`);
    wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--remote']);
    process.stdout.write(`put ${key}\n`);
  },
  check() {
    report(probe(requireKey()));
  },
  delete() {
    const key = requireKey();
    wrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote']);
    process.stdout.write(`deleted ${key}\n`);
  },
  roster() {
    // The four fixed keys, and nothing else: see ./private-doc-keys.mjs for
    // why this is not a listing and must never become one. One probe per key,
    // every key probed even after an absence, so one run answers the whole
    // question.
    let absent = 0;
    for (const key of FIXED_KEYS) {
      const verdict = probe(key);
      if (verdict === 'absent') absent += 1;
      report(verdict, key);
    }
    if (absent > 0) {
      process.stderr.write(
        `${absent} fixed key(s) absent; every grant that unlocks one gets an error from its tool\n`,
      );
      process.exitCode = 1;
    }
  },
};

const command = process.argv[2];
if (!commands[command]) {
  process.stderr.write(
    'usage: private-doc.mjs <put|check|delete|roster> [--key ...] [--file ...]\n',
  );
  process.exit(2);
}
commands[command]();
