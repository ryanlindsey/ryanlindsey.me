import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import {
  PUBLISHED_SKILLS,
  buildSkillsIndex,
  digestFor,
  type SkillsIndex,
} from '../src/lib/discovery/skills';
import { SITE_HARNESS_WORKERS } from './workers';

test('the index carries the fields the discovery RFC requires', async () => {
  const index = await buildSkillsIndex('https://ryanlindsey.me');
  expect(index.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  for (const skill of index.skills) {
    expect(skill.name).toMatch(/^[a-z0-9-]+$/);
    expect(skill.type).toBe('skill-md');
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.url).toMatch(/^\/\.well-known\/agent-skills\/[a-z0-9-]+\/SKILL\.md$/);
    expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  }
});

// The assertion this issue exists for: a digest over the bytes actually served,
// not over a copy. Edit a SKILL.md without rebuilding and this fails.
test('every digest matches the markdown it describes', async () => {
  const index = await buildSkillsIndex('https://ryanlindsey.me');
  for (const entry of index.skills) {
    const skill = PUBLISHED_SKILLS.find((s) => s.name === entry.name);
    expect(skill, entry.name).toBeDefined();
    const expected = `sha256:${createHash('sha256').update(skill!.source, 'utf8').digest('hex')}`;
    expect(entry.digest, entry.name).toBe(expected);
  }
});

test('digestFor is stable and actually hashes its input', async () => {
  expect(await digestFor('a')).toBe(await digestFor('a'));
  expect(await digestFor('a')).not.toBe(await digestFor('b'));
});

// /fit is unlisted by requirement. No published skill may teach an agent to
// reach it -- see the epic's global constraints.
test('no skill mentions an unlisted route', () => {
  for (const skill of PUBLISHED_SKILLS) {
    expect(skill.source, skill.name).not.toMatch(/\/fit\b/);
  }
});

// Served-response coverage, the same discipline tests/discovery-catalog.test.ts
// and tests/discovery-auth.test.ts apply to their own routes: a public/_headers
// RULE with no assertion against a real response is the half most likely to be
// wrong. This is the assertion Step 8 exists for -- it hashes the BODY Astro's
// static build actually wrote to disk and compares that against the digest the
// index published, which is the one check that would catch a build writing
// different bytes than `?raw` returned (a trailing-newline or line-ending
// transform, say). A unit test of buildSkillsIndex alone, against
// PUBLISHED_SKILLS's own in-memory `source`, cannot see that kind of drift --
// both sides of that comparison would still agree even if the served file on
// disk had changed underneath them.
//
// See ./workers.ts for why the site Worker is booted from the build output and
// why the MCP Worker is always listed with it.
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

test('the deployed index ships the declared Content-Type', async () => {
  const response = await server.fetch('/.well-known/agent-skills/index.json');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  const doc = (await response.json()) as SkillsIndex;
  expect(doc.skills).toHaveLength(PUBLISHED_SKILLS.length);
});

test('every served SKILL.md ships the declared Content-Type and hashes to its published digest', async () => {
  const index = await buildSkillsIndex('https://ryanlindsey.me');
  expect(index.skills.length).toBeGreaterThan(0);

  for (const entry of index.skills) {
    const response = await server.fetch(`/.well-known/agent-skills/${entry.name}/SKILL.md`);
    expect(response.status, entry.name).toBe(200);
    expect(response.headers.get('content-type'), entry.name).toBe('text/markdown; charset=utf-8');

    const body = await response.text();
    expect(await digestFor(body), entry.name).toBe(entry.digest);
  }
});
