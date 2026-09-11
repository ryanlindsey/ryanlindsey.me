import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';

/**
 * The site Worker's binding-drift pin, and the counterpart to
 * tests/mcp-env.test.ts's `McpEnv` check.
 *
 * It exists because the MCP Worker's binding list was fenced and this one was
 * not (final-review Important 4), and the asymmetry mattered in exactly the
 * wrong direction: the site Worker is the one that serves anonymous traffic,
 * and it is the one holding two private-tier capabilities it must never use.
 *
 * WHAT THIS PROVES: the set of bindings `wrangler.jsonc` grants this Worker is
 * the set listed below, so a new one cannot appear without a test saying so.
 * WHAT IT DOES NOT PROVE: that the code never reaches for `R2_PRIVATE` or
 * `RLME_TOKEN_SIGNING_KEY`. That is asserted structurally, one layer in --
 * `DocumentsEnv` (src/lib/mcp/documents.ts) names no R2 binding at all, and
 * tests/tier-private-docs.test.ts pins it with a `@ts-expect-error`. The two
 * checks answer different questions and neither substitutes for the other.
 *
 * A file of its own rather than an addition to tests/pages.test.ts, for the
 * reason tests/candidacy-patterns.ts records: that suite boots the site
 * harness in `beforeAll`, and this test needs no Worker at all. `wrangler
 * types` reads the config with wrangler's own parser and never contacts the
 * account, so this stays credential-free like the rest of the suite.
 */

const dir = mkdtempSync(join(tmpdir(), 'site-types-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Every binding the site Worker is granted, and why the two surprising ones
 * are here.
 *
 * `R2_PRIVATE` and `RLME_TOKEN_SIGNING_KEY` are DECLARED AND UNUSED --
 * see the comments beside each in wrangler.jsonc. The signing key's presence
 * is a locked decision of the day-5 plan (the token is verified in exactly one
 * place, the MCP Worker); the bucket predates day 5 and is bound on both
 * Workers and read by neither. Listing them here rather than excluding them is
 * the point: the pin should show what this Worker actually holds, so that
 * removing either is a deliberate edit to this array rather than a silent
 * config change nobody notices.
 */
const SITE_BINDING_NAMES = [
  'KV_CONFIG',
  'KV_CACHE',
  'R2_ASSETS',
  'R2_PRIVATE',
  'DB',
  'EMAIL',
  'AE',
  'EVENTS',
  'RLME_TOKEN_SIGNING_KEY',
  'RLME_TURNSTILE_SECRET_KEY',
  'BROWSER',
  'ASSETS',
  'RLME_AI_GATEWAY_ID',
  // Day 6 Task 2 (06 §3): a PUBLIC identifier, not a secret -- the account the
  // Analytics Engine dataset and AI Gateway live in, which /ops needs at
  // request time because wrangler's own `account_id` is build-time config and
  // is not exposed to the Worker.
  'RLME_ACCOUNT_ID',
  'SITE_ORIGIN',
  'RLME_TURNSTILE_SITEKEY',
  'MCP',
] as const;

test('the site Worker is granted exactly the bindings wrangler.jsonc declares', () => {
  const out = join(dir, 'site-types.d.ts');
  execFileSync(
    'npx',
    [
      'wrangler',
      'types',
      '--config',
      'wrangler.jsonc',
      '--env-interface',
      'SiteBindings',
      '--include-runtime=false',
      out,
    ],
    { stdio: 'pipe' },
  );

  const body = readFileSync(out, 'utf8');
  const block = /interface __BaseEnv_SiteBindings \{([^}]*)\}/.exec(body);
  expect(block, 'wrangler types emitted no SiteBindings interface').not.toBeNull();

  const declared = [...block![1]!.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!).sort();
  expect(declared).toEqual([...SITE_BINDING_NAMES].sort());
});

test('the two declared-and-unused private-tier bindings carry a comment saying so', async () => {
  // The plan's locked decision is *"the binding it already declares stays
  // declared and unused, with a comment saying so"*, and the comment was the
  // half that went missing. A grep-shaped test, because the property being
  // pinned is that a reader of the config learns this -- there is no runtime
  // behaviour to assert, and the previous state of the world was a config
  // that looked exactly like one where the site verified tokens itself.
  const { readFile } = await import('node:fs/promises');
  const config = await readFile('wrangler.jsonc', 'utf8');
  for (const binding of ['R2_PRIVATE', 'RLME_TOKEN_SIGNING_KEY']) {
    const at = config.indexOf(`"binding": "${binding}"`);
    expect(at, `${binding} is not declared in wrangler.jsonc`).toBeGreaterThan(-1);
    // The comment sits above the declaration; take the block before it and
    // require the phrase both comments are written around.
    const preceding = config.slice(0, at);
    expect(
      /DECLARED AND UNUSED ON THIS WORKER[\s\S]*$/.test(preceding.slice(-1200)),
      `${binding} must carry the "declared and unused" comment the plan requires`,
    ).toBe(true);
  }
});
