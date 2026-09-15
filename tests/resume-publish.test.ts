import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import {
  RESUME_PDF_CONTRACT_VERSION,
  resumePdfKey,
  resumeSourceHash,
} from '../src/lib/resume-pdf-contract';
import { resumeSourceHash as workerSourceHash } from '../src/lib/resume-pdf';
import {
  RESUME_ALIAS_KEY,
  RESUME_ASSETS_BUCKET,
  objectPutArguments,
  probeOutcome,
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

describe('objectPutArguments', () => {
  /*
   * The same three values src/lib/resume-pdf.ts puts on the object it writes
   * from the Worker. 06 retires that path, and when it does these become the
   * only place they are set -- a PDF served with the wrong content type, or as
   * an attachment rather than inline, is a regression no other test would see.
   */
  test('carries the response metadata the Worker path sets', () => {
    const arguments_ = objectPutArguments('resume/abc.pdf', 'tests/fixtures/resume-sheet.pdf');

    expect(arguments_).toContain('--remote');
    expect(arguments_.join(' ')).toContain(`${RESUME_ASSETS_BUCKET}/resume/abc.pdf`);
    expect(arguments_[arguments_.indexOf('--content-type') + 1]).toBe('application/pdf');
    expect(arguments_[arguments_.indexOf('--cache-control') + 1]).toBe('public, max-age=300');
    expect(arguments_[arguments_.indexOf('--content-disposition') + 1]).toBe(
      'inline; filename="ryan-lindsey-resume.pdf"',
    );
  });

  test('writes to the public assets bucket and never to the private one', () => {
    const line = objectPutArguments('resume/abc.pdf', 'file.pdf').join(' ');

    expect(line).toContain('ryanlindsey-me-assets');
    expect(line).not.toContain('ryanlindsey-me-private');
  });
});

describe('probeOutcome', () => {
  /*
   * MEASURED for scripts/private-doc.mjs on 2026-09-08 and reused here: a miss
   * is `[ERROR] The specified key does not exist.` wrapped in ANSI colour.
   */
  test('reads wrangler’s not-found message as absent', () => {
    const stderr = '[31m[ERROR][0m The specified key does not exist.';

    expect(probeOutcome({ stderr })).toBe('absent');
  });

  /*
   * THE DANGEROUS DIRECTION. Reading an auth failure as `present` skips the
   * upload and reports success, so the sheet silently stops being republished
   * -- the frozen-file failure this epic exists to fix. Anything that is not
   * the measured miss has to throw.
   */
  test('refuses to read an auth failure as an answer', () => {
    const stderr = '[ERROR] A request to the Cloudflare API failed. Authentication error [10000]';

    expect(() => probeOutcome({ stderr })).toThrow(/Authentication error/);
  });

  test('refuses to read an empty stderr as an answer', () => {
    expect(() => probeOutcome({ stderr: '', message: 'Command failed' })).toThrow(/Command failed/);
  });
});
