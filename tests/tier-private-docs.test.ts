import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS } from './workers';
import {
  caseStudyDetailKey,
  narrativeKey,
  PROFILE_KEYS,
  readPrivateDoc,
} from '../src/lib/tier/private-docs';
import type { DocumentsEnv } from '../src/lib/mcp/documents';

const server = createTestHarness({ workers: MCP_HARNESS_WORKERS });
let env: { R2_PRIVATE: R2Bucket };

beforeAll(async () => {
  await server.listen();
  env = await server.getWorker<typeof env>('ryanlindsey-me-mcp').getEnv();
});
afterAll(async () => {
  await server.close();
});

test('a stored document reads back verbatim', async () => {
  await env.R2_PRIVATE.put(PROFILE_KEYS.availability, '# Availability\n\nfixture body\n');
  expect(await readPrivateDoc(env, PROFILE_KEYS.availability)).toBe(
    '# Availability\n\nfixture body\n',
  );
});

test('a missing document is null, not a throw', async () => {
  expect(await readPrivateDoc(env, 'profile/does-not-exist.md')).toBeNull();
});

test('every key lives under a known prefix', () => {
  // The prefixes ARE the partition's vocabulary. A key outside them means a
  // caller invented a namespace, which is how a bucket stops being auditable.
  expect(Object.values(PROFILE_KEYS).every((key) => key.startsWith('profile/'))).toBe(true);
  expect(caseStudyDetailKey('silent-failure')).toBe('case-study/silent-failure.md');
  expect(narrativeKey('fixture-audience')).toBe('narrative/fixture-audience.md');
});

test('a slug or audience that could escape its prefix is refused', () => {
  // Both values reach these functions from OUTSIDE: the slug from a tool
  // argument a stranger's agent supplies, the audience from a signed claim.
  // The claim cannot be forged, but a mistyped audience in a mint command can
  // still contain a slash, and the failure mode of a traversal here is
  // reading a document meant for a different audience.
  for (const bad of ['../secrets', 'a/b', './x', '', '.', '..', 'a\\b', 'a%2Fb']) {
    expect(caseStudyDetailKey(bad), `${JSON.stringify(bad)} must not build a key`).toBeNull();
    expect(narrativeKey(bad), `${JSON.stringify(bad)} must not build a key`).toBeNull();
  }
});

test('the public document layer cannot name the private bucket', () => {
  // A TYPE-LEVEL assertion of 09 §3's "partition, not filter". `DocumentsEnv`
  // is what every public tool is handed (workers/mcp/src/tools.ts's
  // `documentsEnv`), and it declares `SITE` and `SITE_ORIGIN` only. A public
  // tool therefore cannot reach `R2_PRIVATE` by forgetting a filter -- it has
  // no reference to the binding at all, and adding one would be an edit to
  // this interface that this test fails on.
  const keys: (keyof DocumentsEnv)[] = ['SITE', 'SITE_ORIGIN'];
  expect(keys).toHaveLength(2);
  // @ts-expect-error -- R2_PRIVATE is not a member of DocumentsEnv, and this
  // line is the assertion. If it ever compiles, the partition has a hole.
  const leak: keyof DocumentsEnv = 'R2_PRIVATE';
  expect(leak).toBe('R2_PRIVATE');
});
