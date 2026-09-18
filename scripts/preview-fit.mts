/**
 * A local, credential-free preview of /fit and /fit/r/<id>.
 *
 * It boots the SAME harness the test suite boots (tests/workers.ts), which is
 * the only thing in this repository that can forge a grant: the site Worker
 * from the adapter's build output, the MCP Worker beside it so the `MCP`
 * service binding resolves, and `RLME_TOKEN_KEY_SOURCE: 'test'` so a token
 * signed with TEST_SIGNING_KEY is honoured. Nothing here reaches Workers AI,
 * Cloudflare or a real secret.
 *
 *   npm run preview:fit
 *
 * WHY A SCRIPT THAT FORGES A GRANT IS SAFE IN A PUBLIC REPOSITORY, since that
 * is the first question this file should answer. `TEST_SIGNING_KEY` is already
 * public, in src/lib/tier/grant.ts, and a token signed with it is honoured
 * only where `RLME_TOKEN_KEY_SOURCE` is `test`. No deployed config sets that
 * variable, and tests/mcp-env.test.ts fails if one ever does. So what this
 * mints opens the harness and nothing else; against the deployed Worker it is
 * an invalid signature, which is served the public tier.
 *
 * WHAT IT CANNOT SHOW YOU. Submitting the form produces no report: `FIT_ENGINE`
 * is off in the harness and Turnstile is stubbed, which is the same wall every
 * test in this repository stops at, and lifting it would mean spending money
 * from a preview. The port is whatever the harness picks, so it moves between
 * runs.
 *
 * `.mts` AND `tsx`, WHERE EVERY OTHER SCRIPT HERE IS PLAIN `.mjs`. Those run
 * with no build step on purpose and this one cannot: it imports the worker
 * list from tests/workers.ts rather than restating it, because a second copy
 * of that list is a preview that boots something other than what the suite
 * boots. Plain `node` will not load it -- MEASURED 2026-09-18, and the reason
 * is not the TypeScript (node 24 strips types unasked) but the extensionless
 * relative imports inside src/lib/tier, which native ESM resolution rejects.
 * `tsx` is a devDependency rather than an `npx` invocation so the version is
 * pinned in the lockfile instead of being whatever the npx cache last fetched.
 */
import { createTestHarness } from 'wrangler';
import { MCP_WORKER, SITE_HARNESS_WORKERS } from '../tests/workers.ts';
import { mintToken, newJti } from '../src/lib/tier/token.ts';
import { recordIssue } from '../src/lib/tier/registry.ts';
import { TEST_SIGNING_KEY } from '../src/lib/tier/grant.ts';

const REPORT_ID = 'preview-report';

const REPORT = {
  overall_read:
    'The record covers the platform and delivery halves of this description directly, with shipped systems behind both. The gap is regulated-industry experience, which nothing published speaks to.',
  requirement_map: [
    {
      requirement: 'Leads a platform team of eight or more engineers',
      strength: 'strong',
      evidence: [
        {
          claim: 'Ran a platform group of eleven through two reorganizations.',
          citation_url: 'https://ryanlindsey.me/work/armature',
        },
      ],
    },
    {
      requirement: 'Ships production systems on serverless infrastructure',
      strength: 'strong',
      evidence: [
        {
          claim: 'This site and its MCP server run as two Cloudflare Workers.',
          citation_url: 'https://ryanlindsey.me/writing/agent-native-site',
        },
      ],
    },
    {
      requirement: 'Comfortable owning the forecasting conversation with leadership',
      strength: 'partial',
      evidence: [
        {
          claim:
            'Built a Monte Carlo forecast from observed throughput and shipped it to leadership.',
          citation_url: 'https://ryanlindsey.me/writing/armature',
        },
      ],
    },
    { requirement: 'Experience in a regulated industry', strength: 'none', evidence: [] },
  ],
  gaps: [
    {
      requirement: 'Experience in a regulated industry',
      why: 'Nothing published covers audited or regulated delivery, and the record should not be read as implying it.',
    },
  ],
  questions_to_ask: [
    'Which parts of the platform work were his own commits rather than his team’s?',
    'How did the forecasting tool change what leadership asked for?',
  ],
};

const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });
const { url } = await server.listen();

// The MCP Worker builds absolute citation URLs from SITE_ORIGIN, so it has to
// learn the port the harness just picked. Same update tests/fit-pages.test.ts
// performs in its own beforeAll.
await server.update({
  workers: SITE_HARNESS_WORKERS.map((worker) =>
    worker === MCP_WORKER
      ? { ...MCP_WORKER, vars: { ...MCP_WORKER.vars, SITE_ORIGIN: url.origin } }
      : worker,
  ),
});

const mcp = server.getWorker<{ DB: D1Database }>('ryanlindsey-me-mcp');
await mcp.applyD1Migrations('DB');
const db = (await mcp.getEnv()).DB;

const now = Math.floor(Date.now() / 1000);
const claims = {
  v: 1 as const,
  jti: newJti(),
  aud: 'preview-audience',
  scopes: ['fit' as const],
  iat: now,
  exp: now + 60 * 60 * 24 * 30,
};
await recordIssue(db, {
  jti: claims.jti,
  audience: claims.aud,
  scopes: claims.scopes,
  issuedAt: new Date(claims.iat * 1000).toISOString(),
  expiresAt: new Date(claims.exp * 1000).toISOString(),
  revokedAt: null,
  note: 'local preview',
});
const token = await mintToken(TEST_SIGNING_KEY, claims);

await db
  .prepare(
    `INSERT INTO fit_reports (id, created_at, audience, model, target_description, report_json, citations_checked, citations_dropped)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .bind(
    REPORT_ID,
    new Date().toISOString(),
    claims.aud,
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    'A description pasted by the preview fixture.',
    JSON.stringify(REPORT),
    5,
    1,
  )
  .run();

console.log('');
console.log('  Fit preview, serving the real site Worker with a forged grant.');
console.log('');
console.log(`  Form      ${url.origin}/fit?t=${token}`);
console.log(`  Report    ${url.origin}/fit/r/${REPORT_ID}`);
console.log(`  Refusal   ${url.origin}/fit          (the site 404, as a prober sees it)`);
console.log('');
console.log('  Ctrl-C to stop.');
console.log('');

process.on('SIGINT', () => {
  void server.close().then(() => process.exit(0));
});
await new Promise(() => {});
