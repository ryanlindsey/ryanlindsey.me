#!/usr/bin/env node
/**
 * Publishes the rendered résumé sheet to R2 (issue #185, epic #180).
 *
 * TWO VERBS, AND THE SPLIT IS THE POINT.
 *
 *   plan     compute the hash, ask R2 whether that object is already there,
 *            and say whether anything needs building. Costs one request.
 *   publish  upload the sheet scripts/resume-sheet.mjs has just rendered.
 *
 * .github/workflows/resume-pdf.yml runs `plan` before it installs a browser or
 * builds the site, and gates every later step on its answer. That is what makes
 * the epic's claim true -- "running the job to discover the object already
 * exists costs one request" -- rather than paying for a full render on every
 * push to main to discover the sheet did not change. There is deliberately no
 * `paths:` filter on the workflow: a filter listing the YAML and the route is
 * exactly how a stylesheet change silently fails to republish, and the hash
 * gate here is the correctness mechanism instead.
 *
 * WHAT THE HASH COVERS, AND WHAT IT DOES NOT. The résumé YAML and
 * RESUME_PDF_CONTRACT_VERSION, and nothing else -- not the route, not the
 * stylesheet, not the fonts. An edit to the sheet's own source therefore moves
 * the output without moving the hash, and this script would skip the upload.
 * That hole is not closed here; it is closed by the `contract` check in
 * scripts/resume-gate.mjs, which fails any pull request that moves the golden
 * without moving the constant. The two are one mechanism in two files.
 *
 * WHY WRANGLER RATHER THAN THE S3 API. scripts/private-doc.mjs already talks to
 * R2 this way and wrangler is already in the lockfile, so this adds no
 * dependency and no second spelling of an R2 write. The difference is only
 * where the credential comes from: that script runs on the owner's machine
 * behind a wrangler OAuth login, and this one runs in Actions behind
 * CLOUDFLARE_API_TOKEN. See CLAUDE.md for the token's scope and why it is
 * scoped that way.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resumePdfKey, resumeSourceHash } from '../src/lib/resume-pdf-contract.ts';

const root = new URL('../', import.meta.url);

/** The public bucket. The private one is `ryanlindsey-me-private` and is not reachable from here. */
export const RESUME_ASSETS_BUCKET = 'ryanlindsey-me-assets';

/**
 * The stable name, written with the same bytes as the content-addressed key.
 * An alias rather than a redirect because R2 has no such thing, and because a
 * reader that wants "the current sheet" should not have to learn a hash first.
 */
export const RESUME_ALIAS_KEY = 'resume/latest.pdf';

/** What scripts/resume-sheet.mjs writes. Gitignored: the PDF belongs in R2. */
const PDF = new URL('tests/fixtures/resume-sheet.pdf', root);

const RESUME_YAML = new URL('src/content/resume/ryan-lindsey.yaml', root);

/*
 * A PUBLIC identifier, not a secret: the same value sits in both
 * ./wrangler.jsonc and workers/mcp/wrangler.jsonc, committed in this public
 * repo, and is recorded as public in 10 §2.6. Hardcoded for the reason
 * scripts/private-doc.mjs gives at length -- a bucket-scoped token cannot list
 * accounts, so wrangler has no way to discover it and would refuse to guess.
 */
const ACCOUNT_ID = '1b764d090899bf1ee61a8d1e87c10710';

/**
 * The response metadata the object carries. These are the three values
 * src/lib/resume-pdf.ts puts on the object when the Worker writes it, repeated
 * rather than imported because they are wrangler flags here and an
 * `R2PutOptions` there. Issue 06 retires that path, and when it does this
 * becomes the only place they are set.
 */
const CONTENT_TYPE = 'application/pdf';
const CACHE_CONTROL = 'public, max-age=300';
const CONTENT_DISPOSITION = 'inline; filename="ryan-lindsey-resume.pdf"';

/* -------------------------------------------------------------------------- *
 * wrangler
 * -------------------------------------------------------------------------- */

/**
 * MEASURED against wrangler 4.131.1 on 2026-09-15 via `npx wrangler r2 object
 * put --help`: `--content-type`, `--cache-control` and `--content-disposition`
 * are all flags it accepts, and `--remote` is what makes the write hit the real
 * bucket rather than a local simulation.
 */
export function objectPutArguments(key, file) {
  return [
    'r2',
    'object',
    'put',
    `${RESUME_ASSETS_BUCKET}/${key}`,
    '--file',
    file,
    '--remote',
    '--content-type',
    CONTENT_TYPE,
    '--cache-control',
    CACHE_CONTROL,
    '--content-disposition',
    CONTENT_DISPOSITION,
  ];
}

function wrangler(arguments_, options = {}) {
  return execFileSync('npx', ['wrangler', ...arguments_], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.captureStderr ? 'pipe' : 'inherit'],
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  });
}

/**
 * Turns a failed `r2 object get` into an answer, or refuses to.
 *
 * MEASURED for scripts/private-doc.mjs on 2026-09-08 against a key confirmed
 * not to exist: wrangler's miss is `[ERROR] The specified key does not exist.`
 * wrapped in ANSI colour codes that never split that phrase. Stripped below so
 * a plain terminal, or a future wrangler that drops colour, still matches.
 *
 * EVERYTHING ELSE THROWS, and that direction is the one that matters. An auth
 * failure read as `absent` costs a needless upload of bytes that are already
 * there. An auth failure read as `present` skips the upload and reports
 * success, so the sheet quietly stops being republished -- which is the frozen
 * file this epic exists to fix, arriving through a new door. So this function
 * only ever returns one value, and the caller treats a return as absence.
 */
export function probeOutcome(error) {
  const stderr = String(error.stderr ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  if (/specified key does not exist/i.test(stderr)) return 'absent';
  throw new Error(`could not read R2: ${stderr.trim() || error.message || 'no output'}`);
}

/**
 * `wrangler r2 object get` writes the body to stdout unless `--file` is given,
 * so it goes to a temp file that is removed either way. There is no `head`
 * subcommand and no object listing without S3 credentials this account
 * deliberately does not issue, so a download is how existence is asked.
 */
function objectExists(key) {
  const directory = mkdtempSync(join(tmpdir(), 'rlme-resume-publish-'));
  try {
    wrangler(
      [
        'r2',
        'object',
        'get',
        `${RESUME_ASSETS_BUCKET}/${key}`,
        '--remote',
        '--file',
        join(directory, 'object'),
      ],
      {
        captureStderr: true,
      },
    );
    return true;
  } catch (error) {
    probeOutcome(error);
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- *
 * The plan
 * -------------------------------------------------------------------------- */

/** Where this commit's sheet belongs. Pure, so the test can assert on it. */
export async function publishPlan(source) {
  const hash = await resumeSourceHash(source);
  return { hash, key: resumePdfKey(hash), aliasKey: RESUME_ALIAS_KEY };
}

async function planFromDisk() {
  return await publishPlan(await readFile(RESUME_YAML, 'utf8'));
}

/** Step outputs, so the workflow can gate its expensive steps on the answer. */
function emit(pairs) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(
    file,
    Object.entries(pairs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
  );
}

/* -------------------------------------------------------------------------- *
 * Verbs
 * -------------------------------------------------------------------------- */

const commands = {
  async plan() {
    const { hash, key } = await planFromDisk();
    const present = objectExists(key);

    emit({ publish: String(!present), hash, key });
    process.stdout.write(
      present
        ? `unchanged: ${key} is already in ${RESUME_ASSETS_BUCKET}, nothing to render or upload\n`
        : `changed: ${key} is not in ${RESUME_ASSETS_BUCKET}, rendering and uploading\n`,
    );
  },

  async publish() {
    const { key, aliasKey } = await planFromDisk();
    const file = fileURLToPath(PDF);
    if (!existsSync(file)) {
      throw new Error(`no rendered sheet at ${file}. Run scripts/resume-sheet.mjs first.`);
    }

    /*
     * THE ALIAS IS WRITTEN FIRST, AND THE CONTENT-ADDRESSED KEY LAST. The same
     * commit-point ordering src/lib/resume-pdf.ts uses for the KV manifest, and
     * for the same reason: `plan` asks about the hashed key alone, so that key
     * must not exist until everything else has been written. Reverse these two
     * and a run that uploads the hashed object and then fails leaves `plan`
     * answering "unchanged" forever against an alias holding the old sheet --
     * a frozen /resume.pdf that no later push would repair.
     *
     * Both writes are idempotent: identical bytes at a content-addressed key,
     * so a re-run after a failure costs an upload and changes nothing else.
     */
    wrangler(objectPutArguments(aliasKey, file));
    process.stdout.write(`put ${aliasKey}\n`);

    wrangler(objectPutArguments(key, file));
    process.stdout.write(`put ${key}\n`);
  },
};

const command = process.argv[2];

/*
 * Guarded, because tests/resume-publish.test.ts imports this file for the pure
 * functions above and importing it must not reach for a credential.
 */
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  if (!commands[command]) {
    process.stderr.write('usage: resume-publish.mjs <plan|publish>\n');
    process.exit(2);
  }
  await commands[command]();
}
