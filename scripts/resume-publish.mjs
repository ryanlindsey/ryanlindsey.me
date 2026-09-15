#!/usr/bin/env node
/**
 * Publishes the rendered résumé sheet to R2 (issue #185, epic #180).
 *
 * TWO VERBS, AND THE SPLIT IS THE POINT.
 *
 *   plan     compute the hash, ask R2 whether that object is already there,
 *            and say whether anything needs building. Costs two requests,
 *            one per key.
 *   publish  upload the sheet scripts/resume-sheet.mjs has just rendered.
 *
 * .github/workflows/resume-pdf.yml runs `plan` before it installs a browser or
 * builds the site, and gates every later step on its answer. That is what makes
 * the epic's claim true -- that running the job to discover the object already
 * exists is cheap -- rather than paying for a full render on every push to main
 * to discover the sheet did not change. The epic says "one request"; it is two,
 * because publishDecision below probes both keys, and the reason it has to is
 * recorded there. There is deliberately no
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
 * TWO WRITERS SHARE THIS KEY SPACE UNTIL 06. src/lib/resume-pdf.ts writes the
 * same `resume/<hash>.pdf` from the Worker, on a daily cron and on stale or
 * cold-miss requests to /resume.pdf, from a different route and without the
 * metadata stamp. publishDecision() below carries what that costs and how this
 * script survives it; `force` is the way out when it does not.
 *
 * WHY THE S3 API RATHER THAN WRANGLER, and this is the correction of a mistake
 * rather than a preference (issue #205). The first version of this script
 * copied its mechanism from scripts/private-doc.mjs, which shells out to
 * `wrangler r2 object`. That script works because it runs on the owner's
 * machine behind a wrangler OAuth login, which is an ACCOUNT-LEVEL credential.
 * The mechanism was copied; the credential it depended on was not. Every run of
 * this workflow failed, from the first.
 *
 * MEASURED 2026-09-15 by a read-only job inside the runner, against the stored
 * secret: `/user/tokens/verify` answered `1000 Invalid API Token`, and R2
 * answered `10000 Authentication error` for BOTH accounts on `r2/buckets` --
 * which merely LISTS buckets, a coarser permission than reading one object. A
 * credential that cannot list was never going to read, which is why widening
 * the bucket scope changed nothing across four failed runs and three tokens.
 *
 * WHY, in one line from developers.cloudflare.com/r2/api/tokens: `Object Read &
 * Write` and `Object Read only` are supported ONLY by the S3-compatible API,
 * not the Cloudflare REST API. `wrangler r2 object` speaks the REST API. A
 * permission-type mismatch answers 403 with `10000 Authentication error`, the
 * same shape a revoked or malformed token gives, which is why four runs were
 * spent hunting the token value, the bucket scope and the account instead.
 *
 * THE CHOICE THIS ENCODES. `Admin Read & Write` works over the REST API and
 * would have kept wrangler -- but it cannot be scoped to specific buckets,
 * and only object-level permissions can, so wrangler and least privilege are
 * not both available here. The same is true of a Custom API token carrying the
 * `Workers R2 Storage` permission groups: account-wide, and CI would then hold
 * a credential that can reach `ryanlindsey-me-private`. CLAUDE.md rests the
 * private tier on nobody being ABLE to, rather than on nobody writing the
 * request. S3 credentials really are restricted to one bucket, so this repair
 * is the one that keeps that sentence true.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  RESUME_PDF_HTTP_METADATA,
  resumePdfKey,
  resumeSourceHash,
} from '../src/lib/resume-pdf-contract.ts';

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
 * repo, and is recorded as public in 10 §2.6.
 *
 * It used to be passed to wrangler as CLOUDFLARE_ACCOUNT_ID, with a note about
 * wrangler possibly not reading the config for `r2 object` subcommands. Nothing
 * sets that variable now and wrangler is never invoked; the id addresses R2 by
 * being the endpoint's hostname instead.
 */
const ACCOUNT_ID = '1b764d090899bf1ee61a8d1e87c10710';

/**
 * R2's S3 endpoint for this account. The account id is the hostname here, which
 * is why it stays a public value rather than becoming a secret: it is already
 * committed in both wrangler.jsonc files and recorded as public in 10 §2.6.
 *
 * No jurisdiction prefix. The bucket is in the default jurisdiction; an EU or
 * FedRAMP bucket would need `<account>.eu.r2.cloudflarestorage.com` and would
 * fail loudly here rather than silently addressing the wrong place.
 */
export const RESUME_S3_ENDPOINT = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;

/* -------------------------------------------------------------------------- *
 * R2, over the S3 API
 * -------------------------------------------------------------------------- */

/**
 * The AWS CLI, which GitHub's ubuntu-latest runner image ships preinstalled
 * (v2), so this adds no dependency to the repository and no second spelling of
 * an S3 write. A node SDK would pull a large dependency tree into a repo with
 * one script's worth of S3 to do, and hand-rolling SigV4 would be signing code
 * written by hand to avoid a binary that is already on the machine.
 *
 * NEITHER CREDENTIAL IS NAMED HERE. Both arrive as AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY in the environment, set on the two workflow steps that
 * talk to R2 and nowhere else, so no secret appears in this file and no value
 * reaches an argument vector where `ps` could read it.
 *
 * `AWS_DEFAULT_REGION=auto` because R2 has no regions and the CLI refuses to
 * sign without one.
 *
 * THE TWO CHECKSUM VARIABLES ARE LOAD-BEARING, and an earlier version of this
 * comment called them "a precaution, not a measurement" and said removing them
 * was "a safe thing to try". That was wrong, and it is corrected here rather
 * than deleted because it is the kind of wrong that reads as cautious.
 *
 * AWS CLI v2.23 turned on S3 data-integrity protections by default: it sends a
 * CRC checksum trailer (`request_checksum_calculation=when_supported`) and
 * validates checksums on responses. R2's S3 API REJECTS the trailer with
 * `An error occurred (400) ... Bad Request`, and this bites read paths too,
 * because `aws s3 cp` issues a HeadObject first. `when_required` restores the
 * pre-2.23 behaviour. See github.com/aws/aws-cli/issues/9214. It does not
 * affect the Workers R2 binding, only this S3 path.
 *
 * THE COST, named because it is real: under `when_required` the CLI sends no
 * checksum and no Content-MD5, so an upload carries no integrity check beyond
 * TLS. That is the trade being made, and it is made knowingly -- without these
 * two the upload does not happen at all.
 */
function aws(arguments_, options = {}) {
  try {
    return execFileSync('aws', arguments_, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', options.captureStderr ? 'pipe' : 'inherit'],
      env: {
        ...process.env,
        AWS_DEFAULT_REGION: 'auto',
        AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
        AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
      },
    });
  } catch (error) {
    // A MISSING BINARY IS NOT A PROBE RESULT. `probeOutcome` reads this
    // function's failures and answers "absent" for one specific shape, so an
    // ENOENT arriving there as an unrecognised message would at least throw --
    // but it would throw saying "could not read R2", which is a lie that sends
    // the next reader to the bucket and the credentials. Named here instead.
    // This relies on the AWS CLI being preinstalled on the runner image, which
    // it is on ubuntu-latest, and is the one dependency this script does not
    // install for itself.
    if (error.code === 'ENOENT') {
      const missing = new Error(
        'the AWS CLI is not on PATH. It ships with the GitHub ubuntu-latest runner image; ' +
          'install it to run this script anywhere else.',
      );
      // The tag is what `objectExists` reads to rethrow this BEFORE probeOutcome
      // sees it. Without it the message still arrives, wearing a `could not read
      // R2:` prefix that sends the next reader to the bucket and the
      // credentials. The flag is the difference between a true message and a
      // true message behind a false heading.
      missing.notAProbeResult = true;
      throw missing;
    }
    throw error;
  }
}

/**
 * The three response values come from RESUME_PDF_HTTP_METADATA rather than from
 * literals here. They were literals in two places until #185, a duplicate
 * nothing would have caught: a sheet served as an attachment rather than
 * inline, or as the wrong media type, renders as a download prompt, and no test
 * in this repo sees the headers.
 *
 * THE BUCKET IS AN ARGUMENT NOW rather than a prefix on a path. That is the
 * shape tests/resume-publish.test.ts asserts against the private bucket's name:
 * nothing this script can construct addresses `ryanlindsey-me-private`.
 */
export function objectPutArguments(key, file) {
  return [
    's3api',
    'put-object',
    '--bucket',
    RESUME_ASSETS_BUCKET,
    '--key',
    key,
    '--body',
    file,
    '--endpoint-url',
    RESUME_S3_ENDPOINT,
    '--content-type',
    RESUME_PDF_HTTP_METADATA.contentType,
    '--cache-control',
    RESUME_PDF_HTTP_METADATA.cacheControl,
    '--content-disposition',
    RESUME_PDF_HTTP_METADATA.contentDisposition,
  ];
}

/**
 * A REAL HEAD, which the Cloudflare REST API had no verb for. The previous
 * version of this script downloaded the whole object into a temp file to ask
 * whether it existed -- 215 KB to learn a boolean -- and its comment blamed R2
 * for offering no `head` subcommand. That was a property of the API being
 * spoken, not of R2.
 *
 * A MISSING BUCKET IS INDISTINGUISHABLE FROM A MISSING OBJECT here, because a
 * HEAD response carries no body and so no `NoSuchBucket` code to read: both
 * arrive as a bare 404 and both read as absence. Benign in this design -- the
 * run goes on to render and then `put-object` fails loudly with the real code,
 * since a PUT response does have a body -- but it costs a full render first,
 * and the bucket name is a constant so it can only be wrong by an edit here.
 */
export function objectHeadArguments(key) {
  return [
    's3api',
    'head-object',
    '--bucket',
    RESUME_ASSETS_BUCKET,
    '--key',
    key,
    '--endpoint-url',
    RESUME_S3_ENDPOINT,
  ];
}

/**
 * Turns a failed `head-object` into an answer, or refuses to.
 *
 * THE MISS: `head-object` on a key that is not there exits non-zero with
 * `An error occurred (404) when calling the HeadObject operation: Not Found`.
 * Matched on the status AND the operation together, rather than on `Not Found`,
 * which is generic enough to appear in messages that are not this. Naming the
 * operation also keeps a future second caller from inheriting an answer that
 * was only ever measured for this one.
 *
 * The ANSI strip is kept from the wrangler version. The AWS CLI does not colour
 * this message, but stripping costs nothing and a future one might.
 *
 * EVERYTHING ELSE THROWS, and that direction is the one that matters. An auth
 * failure read as `absent` costs a needless upload of bytes that are already
 * there. An auth failure read as `present` skips the upload and reports
 * success, so the sheet quietly stops being republished -- the frozen file this
 * epic exists to fix, arriving through a new door. So this function only ever
 * returns one value, and the caller treats a return as absence.
 *
 * SigV4 makes that direction newly load-bearing: `SignatureDoesNotMatch` and
 * `InvalidAccessKeyId` are failures the wrangler path could not produce, and a
 * clock skew on the runner is enough to raise the first.
 */
export function probeOutcome(error) {
  const stderr = String(error.stderr ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  if (/An error occurred \(404\) when calling the HeadObject operation/i.test(stderr)) {
    return 'absent';
  }
  throw new Error(`could not read R2: ${stderr.trim() || error.message || 'no output'}`);
}

/**
 * Existence, in one request and no bytes. Exit 0 is the object; a 404 naming
 * HeadObject is its absence; anything else throws out of probeOutcome.
 */
function objectExists(key) {
  try {
    aws(objectHeadArguments(key), { captureStderr: true });
    return true;
  } catch (error) {
    // Anything that is not R2 answering is not an answer about R2. See the
    // ENOENT branch in aws() for the one case this currently covers.
    if (error.notAProbeResult) throw error;
    probeOutcome(error);
    return false;
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

/**
 * BOTH KEYS ARE PROBED, AND THE REASON IS THAT THIS WORKFLOW IS NOT THE ONLY
 * WRITER YET.
 *
 * `regenerateResumePdf` in src/lib/resume-pdf.ts still writes
 * `resume/<hash>.pdf` into this same bucket, from the 05:17 cron and from every
 * stale or cold-miss request to /resume.pdf, and it computes the same contract
 * version 4 hash as this script.
 *
 * MEASURED against the live bucket on 2026-09-15, before this ever ran in CI:
 * `resume/6457fef2...cfe3.pdf` was ALREADY THERE and `resume/latest.pdf` was
 * not. The object at that key reads `Pages: 9`, 215,154 bytes, no Author and no
 * Subject, `Producer: Skia/PDF m128` from a Linux HeadlessChrome -- the Browser
 * Rendering runtime, not this repo's renderer. #184 bumped the contract to 4
 * earlier the same day, which moved the Worker's hash and had it re-render
 * `/resume?print` under the new key hours before this workflow existed.
 *
 * So an earlier draft of this script, which probed the content-addressed key
 * alone, would have answered "unchanged" against a bucket that had never held
 * the alias. The first run would have gone green having published nothing, and
 * the 9-page sheet would have stayed live with no way to recover short of
 * editing the résumé. That is not a hypothetical this comment is guarding
 * against; it is what the bucket held when the probe was written.
 *
 * So the alias is probed too, and a missing alias is enough to publish. Two
 * requests rather than one on the no-op path.
 *
 * WHAT THIS STILL DOES NOT FIX, said out loud rather than left to be
 * discovered: the runtime path can overwrite a key this workflow has just
 * published, because CI writes R2 and does not write the KV manifest the
 * Worker gates on. On the next content change both writers target the new
 * hashed key, and whichever lands second wins. Nothing here can prevent that
 * without a KV credential, and widening the token is the one thing #185 rules
 * out. A dispatch with `force` is the repair.
 *
 * WHAT IS SAFE MEANWHILE, and it is the reason 05 is worth landing before 06:
 * nothing in src/lib/resume-pdf.ts writes RESUME_ALIAS_KEY. `regenerateResumePdf`
 * writes `resumePdfKey(currentHash)` and nothing else, so the alias is this
 * workflow's alone. Once written it holds the gated three-page sheet and stays
 * holding it, whatever the runtime path does to the hashed key beside it. The
 * interim state is therefore not a regression: /resume.pdf goes on serving what
 * it serves today, and the artifact 06 will read from is already in place and
 * correct when 06 arrives.
 */
export function publishDecision({ hashedPresent, aliasPresent, force }) {
  if (force) {
    return { publish: true, reason: 'force requested, republishing both keys' };
  }
  if (!hashedPresent) {
    return { publish: true, reason: 'the content-addressed key is not in the bucket' };
  }
  if (!aliasPresent) {
    return {
      publish: true,
      reason: `the content-addressed key is there and ${RESUME_ALIAS_KEY} is not`,
    };
  }
  return { publish: false, reason: 'both keys are already in the bucket' };
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
    const { hash, key, aliasKey } = await planFromDisk();
    const force = process.env.RESUME_PUBLISH_FORCE === 'true';
    // Short-circuited by `force`, so a repair dispatch costs no probe at all.
    const hashedPresent = force ? false : objectExists(key);
    const aliasPresent = force ? false : hashedPresent && objectExists(aliasKey);

    const { publish, reason } = publishDecision({ hashedPresent, aliasPresent, force });

    emit({ publish: String(publish), hash, key });
    process.stdout.write(
      `${publish ? 'publishing' : 'skipping'}: ${reason}\n` +
        `  bucket ${RESUME_ASSETS_BUCKET}\n  key    ${key}\n  alias  ${aliasKey}\n`,
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
    aws(objectPutArguments(aliasKey, file));
    process.stdout.write(`put ${aliasKey}\n`);

    aws(objectPutArguments(key, file));
    process.stdout.write(`put ${key}\n`);
  },
};

const command = process.argv[2];

/*
 * Guarded, because tests/resume-publish.test.ts imports this file for the pure
 * functions above and importing it must not reach for a credential.
 *
 * realpathSync on both sides, not a string compare of the raw values. Node
 * resolves the main entry through symlinks while `process.argv[1]` is only made
 * absolute, so a symlink anywhere in the invocation path makes a naive compare
 * false, and the failure is the silent kind: the script exits 0 having done
 * nothing, `plan` emits no output, every gated step in the workflow skips, and
 * the run is green. The workflow asserts the output arrived for the same
 * reason; a green run that published nothing is the frozen file this epic
 * exists to fix.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(import.meta.filename) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  if (!commands[command]) {
    process.stderr.write('usage: resume-publish.mjs <plan|publish>\n');
    process.exit(2);
  }
  await commands[command]();
}
