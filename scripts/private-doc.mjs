#!/usr/bin/env node
// Put one document into the private tier's R2 bucket (09 §3 item 3: "doc
// authored in this repo, pushed to R2/D1 by the local script, and confirmed
// absent from the public repo's history").
//
// THIS SCRIPT LIVES IN THE PUBLIC REPO AND THE DOCUMENTS DO NOT. That is the
// whole shape: the mechanism is generic and carries no audience-specific
// semantics -- it puts a file at a key -- while every document it deploys is
// authored in the private planning repo and is passed in by path. Nothing it
// writes ever enters this repo's history, and 10 §2.3 is satisfied by WHERE
// it is invoked from rather than by where it is stored.
//
// Usage, from the private repo:
//   node ../ryanlindsey.me/scripts/private-doc.mjs put \
//     --key profile/availability.md --file docs/private/availability.md
//   node ../ryanlindsey.me/scripts/private-doc.mjs check --key profile/availability.md
//   node ../ryanlindsey.me/scripts/private-doc.mjs delete --key narrative/foo.md
//
// Keys must match what src/lib/tier/private-docs.ts builds. The script
// re-checks the shape rather than trusting the caller, because a typo here
// produces a document no tool will ever find and no error anyone will ever
// see.
//
// NO `list` VERB. MEASURED against the installed wrangler (4.129, `npx
// wrangler r2 object --help`): its only subcommands are `get`, `put` and
// `delete` -- there is no object listing without S3-compatible credentials,
// which the provisioning split for this bucket deliberately does not create
// (10 §2.3 again: the owner's machine holds a `wrangler` OAuth login and
// nothing else). `check` is the replacement rather than a listing worked
// around some other way, because a listing over a private-document store
// would enumerate every gated key -- including every narrative audience --
// where a per-key probe only ever answers the one question a caller
// actually has: is THIS key there.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUCKET = 'ryanlindsey-me-private';

const KEY_PATTERN = /^(profile|case-study|narrative)\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
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
      `key must be <profile|case-study|narrative>/<name>.md -- got ${JSON.stringify(key)}`,
    );
  }
  return key;
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
    const key = requireKey();
    // `wrangler r2 object get` writes the object body to STDOUT unless
    // `--file` is given (measured: `-f, --file` and `-p, --pipe` are its only
    // output options). These are gated documents, so the body-catching form
    // is not stylistic -- it is what keeps the text out of this process's
    // stdout and out of whatever captures it next (a terminal scrollback, a
    // CI log). This command never reads the file it writes; only the exit
    // code is inspected, and the file is removed before returning either way.
    const dir = mkdtempSync(join(tmpdir(), 'rlme-private-doc-'));
    const file = join(dir, 'object');
    try {
      execFileSync(
        'npx',
        ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--file', file],
        {
          stdio: ['ignore', 'ignore', 'inherit'],
        },
      );
      process.stdout.write('present\n');
    } catch {
      process.stdout.write('absent\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  delete() {
    const key = requireKey();
    wrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote']);
    process.stdout.write(`deleted ${key}\n`);
  },
};

const command = process.argv[2];
if (!commands[command]) {
  process.stderr.write('usage: private-doc.mjs <put|check|delete> [--key ...] [--file ...]\n');
  process.exit(2);
}
commands[command]();
