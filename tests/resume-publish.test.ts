import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import {
  RESUME_PDF_CONTRACT_VERSION,
  RESUME_PDF_HTTP_METADATA,
  resumePdfKey,
  resumeSourceHash,
} from '../src/lib/resume-pdf-contract';
import { resumeSourceHash as workerSourceHash } from '../src/lib/resume-pdf';
import {
  RESUME_ALIAS_KEY,
  RESUME_ASSETS_BUCKET,
  RESUME_S3_ENDPOINT,
  objectHeadArguments,
  objectPutArguments,
  probeOutcome,
  publishDecision,
  publishPlan,
} from '../scripts/resume-publish.mjs';

const resumeYaml = new URL('../src/content/resume/ryan-lindsey.yaml', import.meta.url);

/*
 * THE TEST THIS FILE EXISTS FOR. The workflow addresses the object from a plain
 * node process that reads the YAML with fs; the Worker addresses it from a
 * bundle that imports the same file through Vite's `?raw`. Two readers, one
 * key, and nothing outside this assertion makes them agree -- a BOM, a line
 * ending rewrite, or a `?raw` loader that trimmed would move one hash and not
 * the other, and the workflow would upload to a key the Worker never asks for.
 * /resume.pdf would then 404 against a bucket holding the file.
 */
test('the hash a script reads off disk matches the hash the Worker bundles', async () => {
  const fromDisk = await resumeSourceHash(await readFile(resumeYaml, 'utf8'));
  expect(fromDisk).toBe(await workerSourceHash());
});

test('the contract version is part of the hash input', async () => {
  const source = 'basics:\n  name: Someone\n';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`resume-pdf/v${RESUME_PDF_CONTRACT_VERSION}\n${source}`),
  );
  const expected = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  expect(await resumeSourceHash(source)).toBe(expected);
});

describe('publishPlan', () => {
  test('addresses the content-addressed key through resumePdfKey', async () => {
    const source = await readFile(resumeYaml, 'utf8');
    const plan = await publishPlan(source);

    expect(plan.hash).toBe(await resumeSourceHash(source));
    expect(plan.key).toBe(resumePdfKey(plan.hash));
    expect(plan.key).toMatch(/^resume\/[0-9a-f]{64}\.pdf$/);
  });

  test('names the alias alongside it', async () => {
    const plan = await publishPlan(await readFile(resumeYaml, 'utf8'));

    expect(plan.aliasKey).toBe(RESUME_ALIAS_KEY);
    expect(RESUME_ALIAS_KEY).toBe('resume/latest.pdf');
  });
});

/*
 * TWO WRITERS, ONE KEY SPACE, UNTIL 06. src/lib/resume-pdf.ts still writes
 * `resume/<hash>.pdf` to this same bucket, from the 05:17 cron and from every
 * stale or cold-miss request to /resume.pdf. So the content-addressed key can
 * already be there when this workflow first runs, and probing it alone would
 * answer "unchanged" on a bucket that has never held `resume/latest.pdf`. The
 * alias is probed for exactly that reason.
 */
describe('publishDecision', () => {
  test('publishes nothing when both keys are already there', () => {
    const decision = publishDecision({ hashedPresent: true, aliasPresent: true, force: false });

    expect(decision.publish).toBe(false);
    expect(decision.reason).toMatch(/already/i);
  });

  test('publishes when the content-addressed key is missing', () => {
    const decision = publishDecision({ hashedPresent: false, aliasPresent: true, force: false });

    expect(decision.publish).toBe(true);
  });

  /* The case a single probe misses, and the one that fails acceptance item 1. */
  test('publishes when only the alias is missing', () => {
    const decision = publishDecision({ hashedPresent: true, aliasPresent: false, force: false });

    expect(decision.publish).toBe(true);
    expect(decision.reason).toMatch(/latest\.pdf/);
  });

  test('force overrides a bucket that holds both', () => {
    const decision = publishDecision({ hashedPresent: true, aliasPresent: true, force: true });

    expect(decision.publish).toBe(true);
    expect(decision.reason).toMatch(/force/i);
  });
});

describe('the S3 endpoint', () => {
  /*
   * WHY S3 AND NOT THE CLOUDFLARE REST API (issue #205). `wrangler r2 object`
   * speaks to api.cloudflare.com with a Bearer token. Measured 2026-09-15 in
   * the runner, against the stored secret: `/user/tokens/verify` answered
   * `1000 Invalid API Token` and R2 answered `10000 Authentication error` for
   * BOTH accounts, including on `r2/buckets`, which merely lists. A credential
   * that cannot list buckets was never going to read an object, which is why
   * widening the bucket scope changed nothing across four failed runs.
   *
   * That proves the stored value was not a valid Cloudflare API token, and no
   * more than that -- the R2 token screen issues several values at once. S3 is
   * the form chosen because it is the only one restricted to a single bucket,
   * which is what keeps CI unable to reach `ryanlindsey-me-private`.
   *
   * The account id is PUBLIC (10 §2.6) and already committed in both
   * wrangler.jsonc files; in the S3 form it is the endpoint's hostname.
   */
  test('addresses R2 by account id, over https', () => {
    expect(RESUME_S3_ENDPOINT).toMatch(/^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/);
  });

  /*
   * THE SHAPE IS NOT ENOUGH. A typo'd account id passes the regex above and
   * fails only in CI, as a 403 that looks exactly like the credential problem
   * this whole change exists to fix -- so the id is compared against the one
   * committed in wrangler.jsonc, which is the same fact spelled in two files.
   *
   * Read with a regex rather than by parsing: wrangler.jsonc is JSONC, and
   * `JSON.parse` chokes on the comments that are most of that file.
   */
  test('the account id in the endpoint is the one wrangler.jsonc declares', async () => {
    const config = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const declared = /"account_id"\s*:\s*"([0-9a-f]{32})"/.exec(config)?.[1];

    expect(declared, 'no account_id in wrangler.jsonc').toBeTruthy();
    expect(RESUME_S3_ENDPOINT).toBe(`https://${declared}.r2.cloudflarestorage.com`);
  });
});

describe('objectPutArguments', () => {
  /*
   * ONE COPY OF THESE VALUES, in src/lib/resume-pdf-contract.ts, read by the
   * flags here and by the `httpMetadata` the Worker passes to R2.put. There are
   * still two readers: #186 retires the second, and has not merged.
   *
   * An earlier draft of this test compared literals to literals, which would
   * have gone on passing while the two copies drifted apart. A PDF served with
   * the wrong content type, or as an attachment rather than inline, is a
   * regression no other test in this repo would see.
   */
  test('carries the response metadata from the shared contract', () => {
    const arguments_ = objectPutArguments('resume/abc.pdf', 'tests/fixtures/resume-sheet.pdf');
    const flag = (name: string) => arguments_[arguments_.indexOf(name) + 1];

    expect(arguments_.slice(0, 2)).toEqual(['s3api', 'put-object']);
    expect(flag('--bucket')).toBe(RESUME_ASSETS_BUCKET);
    expect(flag('--key')).toBe('resume/abc.pdf');
    expect(flag('--body')).toBe('tests/fixtures/resume-sheet.pdf');
    expect(flag('--endpoint-url')).toBe(RESUME_S3_ENDPOINT);
    expect(flag('--content-type')).toBe(RESUME_PDF_HTTP_METADATA.contentType);
    expect(flag('--cache-control')).toBe(RESUME_PDF_HTTP_METADATA.cacheControl);
    expect(flag('--content-disposition')).toBe(RESUME_PDF_HTTP_METADATA.contentDisposition);
  });

  test('the shared metadata still says inline PDF', () => {
    expect(RESUME_PDF_HTTP_METADATA.contentType).toBe('application/pdf');
    expect(RESUME_PDF_HTTP_METADATA.contentDisposition).toMatch(/^inline;/);
  });

  /*
   * THE BUCKET IS A SEPARATE ARGUMENT NOW, not a prefix on a path, so this
   * assertion has to look at the whole line rather than at one token: the point
   * is that nothing in this script can address the private bucket, whatever the
   * credential would allow. That is the property CLAUDE.md rests the private
   * tier on, and issue #205 keeps it only because it chose bucket-scoped S3
   * credentials over an account-wide API token.
   */
  test('writes to the public assets bucket and never to the private one', () => {
    const line = objectPutArguments('resume/abc.pdf', 'file.pdf').join(' ');

    expect(line).toContain('ryanlindsey-me-assets');
    expect(line).not.toContain('ryanlindsey-me-private');
  });
});

describe('objectHeadArguments', () => {
  /*
   * A REAL HEAD, which the REST API had no verb for. The old probe downloaded
   * the object to a temp file to ask whether it existed, and its comment said
   * so; that was a property of the wrong API rather than of R2. Asking for
   * 215 KB to learn a boolean was the cost.
   */
  test('asks for the object without fetching its body', () => {
    const arguments_ = objectHeadArguments('resume/abc.pdf');
    const flag = (name: string) => arguments_[arguments_.indexOf(name) + 1];

    expect(arguments_.slice(0, 2)).toEqual(['s3api', 'head-object']);
    expect(flag('--bucket')).toBe(RESUME_ASSETS_BUCKET);
    expect(flag('--key')).toBe('resume/abc.pdf');
    expect(flag('--endpoint-url')).toBe(RESUME_S3_ENDPOINT);
    expect(arguments_).not.toContain('--body');
    expect(arguments_.join(' ')).not.toContain('ryanlindsey-me-private');
  });
});

describe('probeOutcome', () => {
  /*
   * THE AWS CLI'S MISS, which replaced wrangler's. `head-object` on a key that
   * is not there exits non-zero with
   * `An error occurred (404) when calling the HeadObject operation: Not Found`.
   * Matched on the status AND the operation, not on `Not Found`, which is
   * generic enough to appear in messages that are not this.
   *
   * The ESC codes are here so the ANSI strip in probeOutcome keeps its
   * coverage. The AWS CLI does not colour this message; wrangler did, the strip
   * is inherited from that version, and a fixture of plain text would let the
   * strip rot silently until some future CLI started colouring again.
   */
  test('reads the AWS not-found status as absent, through ANSI colour', () => {
    // MEASURED 2026-09-15 against the real endpoint from the runner, aws-cli
    // 2.36.40 on ubuntu-24.04, asking for a key that did not exist:
    //
    //   aws: [ERROR]: An error occurred (404) when calling the HeadObject operation: Not Found
    //
    // The `aws: [ERROR]: ` prefix is the CLI's own and is why the regex in
    // probeOutcome is unanchored. The ESC codes are added on top so the ANSI
    // strip keeps its coverage: the AWS CLI does not colour this message,
    // wrangler did, the strip is inherited from that version, and a plain
    // fixture would let it rot until some future CLI started colouring again.
    const stderr =
      '\u001b[31maws: [ERROR]: An error occurred (404) when calling the HeadObject operation: Not Found\u001b[0m';

    expect(probeOutcome({ stderr })).toBe('absent');
  });

  /*
   * THE DANGEROUS DIRECTION, and the reason this function returns exactly one
   * value. Reading an auth failure as `present` skips the upload and reports
   * success, so the sheet silently stops being republished -- the frozen-file
   * failure this epic exists to fix. Anything that is not the measured miss has
   * to throw.
   *
   * ONLY NUMERIC CODES APPEAR HERE, and that is a property of HEAD rather than
   * an omission. A HEAD response carries no body, so botocore has no XML
   * `<Code>` to read and synthesises the error from the HTTP status; named S3
   * codes like `SignatureDoesNotMatch` cannot reach this function through
   * `head-object` at all. 401 is what R2 answered when a reviewer ran this
   * against the real endpoint with invalid credentials on 2026-09-15.
   *
   * Each case asserts the ORIGINATING TEXT survives into the thrown message,
   * not just the constant prefix. An earlier draft matched `/could not read R2/`
   * alone, which a probeOutcome that discarded stderr entirely would have
   * passed -- and the whole job of that message is to say what R2 actually said.
   */
  test.each([
    ['401', 'An error occurred (401) when calling the HeadObject operation: Unauthorized'],
    ['403', 'An error occurred (403) when calling the HeadObject operation: Forbidden'],
  ])('refuses to read %s as an answer, and repeats what R2 said', (status, stderr) => {
    expect(() => probeOutcome({ stderr })).toThrow(/could not read R2/);
    expect(() => probeOutcome({ stderr })).toThrow(new RegExp(`\\(${status}\\)`));
    expect(() => probeOutcome({ stderr })).toThrow(/HeadObject/);
  });

  test('refuses to read a missing credential as an answer', () => {
    // What an unset or empty AWS_ACCESS_KEY_ID produces. Worth its own case
    // because it is the shape a misconfigured repo secret takes, and reading it
    // as absence would publish on every run instead of never.
    const stderr =
      'Unable to locate credentials. You can configure credentials by running "aws configure".';

    expect(() => probeOutcome({ stderr })).toThrow(/Unable to locate credentials/);
  });

  test('refuses to read an empty stderr as an answer', () => {
    expect(() => probeOutcome({ stderr: '', message: 'Command failed' })).toThrow(/Command failed/);
  });

  /*
   * A 404 that names a DIFFERENT operation is not this object's absence.
   * head-object is the only call that reaches this function, and pinning the
   * operation keeps a future second caller from inheriting an answer that was
   * only ever measured for this one.
   */
  test('does not treat a 404 on some other operation as this object being absent', () => {
    const stderr = 'An error occurred (404) when calling the ListBuckets operation: Not Found';

    expect(() => probeOutcome({ stderr })).toThrow(/could not read R2/);
  });
});
