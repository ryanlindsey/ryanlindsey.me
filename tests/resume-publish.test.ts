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
   * speaks to api.cloudflare.com with a Bearer token, and an R2 API token is
   * not one of those -- it is an S3 credential pair. Measured 2026-09-15 in the
   * runner, against the stored secret: `/user/tokens/verify` answered
   * `1000 Invalid API Token` and R2 answered `10000 Authentication error` for
   * BOTH accounts, including on `r2/buckets`, which merely lists. A credential
   * that cannot list buckets was never going to read an object, which is why
   * widening the bucket scope changed nothing across five failed runs.
   *
   * The account id is PUBLIC (10 §2.6) and already committed in both
   * wrangler.jsonc files; in the S3 form it is the endpoint's hostname.
   */
  test('addresses R2 by account id, over https', () => {
    expect(RESUME_S3_ENDPOINT).toMatch(/^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/);
  });
});

describe('objectPutArguments', () => {
  /*
   * ONE COPY OF THESE VALUES, in src/lib/resume-pdf-contract.ts, read by the
   * flags here and by the `httpMetadata` the Worker passed to R2.put before
   * #186 deleted that path. An earlier draft of this test compared literals to
   * literals, which would have gone on passing while the two copies drifted
   * apart. A PDF served with the wrong content type, or as an attachment rather
   * than inline, is a regression no other test in this repo would see.
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
   * Matched on the parenthesised status rather than on `Not Found`, because
   * that phrase is generic enough to appear in messages that are not a miss.
   */
  test('reads the AWS not-found status as absent', () => {
    const stderr = 'An error occurred (404) when calling the HeadObject operation: Not Found';

    expect(probeOutcome({ stderr })).toBe('absent');
  });

  /*
   * THE DANGEROUS DIRECTION, and the reason this function returns exactly one
   * value. Reading an auth failure as `present` skips the upload and reports
   * success, so the sheet silently stops being republished -- the frozen-file
   * failure this epic exists to fix. Anything that is not the measured miss has
   * to throw.
   *
   * All four shapes below are auth failures rather than misses, and the last
   * two are the ones this change makes newly reachable: SigV4 signing did not
   * exist on the wrangler path, so a clock skew or a mistyped secret could not
   * produce these before.
   */
  test.each([
    ['403', 'An error occurred (403) when calling the HeadObject operation: Forbidden'],
    ['AccessDenied', 'An error occurred (AccessDenied) when calling the HeadObject operation'],
    [
      'InvalidAccessKeyId',
      'An error occurred (InvalidAccessKeyId) when calling the HeadObject operation',
    ],
    [
      'SignatureDoesNotMatch',
      'An error occurred (SignatureDoesNotMatch) when calling the HeadObject operation',
    ],
  ])('refuses to read %s as an answer', (_label, stderr) => {
    expect(() => probeOutcome({ stderr })).toThrow(/could not read R2/);
  });

  test('refuses to read an empty stderr as an answer', () => {
    expect(() => probeOutcome({ stderr: '', message: 'Command failed' })).toThrow(/Command failed/);
  });

  /*
   * A 404 that names a DIFFERENT operation is still a miss, because head-object
   * is the only call that reaches this function. Pinned so that a future caller
   * cannot quietly widen what counts as absence.
   */
  test('does not treat a 404 on some other operation as this object being absent', () => {
    const stderr = 'An error occurred (404) when calling the ListBuckets operation: Not Found';

    expect(() => probeOutcome({ stderr })).toThrow(/could not read R2/);
  });
});
