import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS, MCP_WORKER } from './workers';
import { mintToken, newJti, type Scope } from '../src/lib/tier/token';
import { recordIssue } from '../src/lib/tier/registry';
import { TEST_SIGNING_KEY } from '../src/lib/tier/grant';
import type { McpEnv } from '../workers/mcp/src/env';

/**
 * The deferred fit run, as a Workflow instance (#349).
 *
 * WHY THIS SUITE EXISTS AT ALL, AND WHY IT COULD NOT HAVE EXISTED BEFORE.
 * Epic #270 finished the run in `ctx.waitUntil`, which for an HTTP-triggered
 * Worker is capped at 30 seconds and cancels anything still unsettled.
 * `analyze_fit` was MEASURED at 78,222 ms on 2026-09-18, so every real run was
 * killed mid-engine. CONFIRMED IN PRODUCTION 2026-09-22: `POST /fit/start`
 * answered `200 {"id":"QIdjP22q7RAJi1No8Ckjag"}` in 0.98 s and the row read
 * `pending` with `model`, `report_json` and `citations_checked` all null at
 * t+25, 40, 60, 85, 110 and 150 seconds. The `UPDATE` never ran and no
 * notification arrived.
 *
 * Nothing in this repository could see that. A `waitUntil` promise has no
 * handle, no status and no name, and the harness's own budget is not the
 * runtime's -- tests/fit-start.test.ts watches the row transition and passes
 * either way. A Workflow instance is the opposite: it is ADDRESSABLE, it has a
 * terminal status, and `workers/mcp/src/evals-workflow.ts` records the
 * measurement that makes it usable here -- MEASURED 2026-09-18, the `workflows`
 * binding boots and creates real instances under this harness, unlike `ai` and
 * `ai_search`.
 *
 * WHAT THIS STILL CANNOT SEE, said plainly: the eighty seconds. No test here
 * may spend inference, so the 78,222 ms call is unreachable and the 30-second
 * budget cannot be crossed under the harness. What is pinned instead is the
 * SHAPE that budget applied to -- that the engine call is no longer something
 * the request's execution context is holding open, and that the thing holding
 * it now is an instance with a status a test can read.
 *
 * `FIT_ENGINE: 'off-after-delay'` for the same reason tests/fit-start.test.ts
 * overrides it: under `'off'` the run closes its own row before a test can
 * read the row it opened (MEASURED 2026-09-21). It spends no neuron, opens no
 * subrequest and touches no binding.
 */

const server = createTestHarness({
  workers: MCP_HARNESS_WORKERS.map((worker) =>
    worker === MCP_WORKER
      ? { ...MCP_WORKER, vars: { ...MCP_WORKER.vars, FIT_ENGINE: 'off-after-delay' } }
      : worker,
  ),
});

let env: McpEnv;
let db: D1Database;
let origin = '';

const AUDIENCE = 'fixture-workflow';

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  const mcp = server.getWorker<McpEnv>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  env = await mcp.getEnv();
  db = env.DB;
});
afterAll(async () => {
  await server.close();
});

/** A live grant, registered so `resolveGrant` honours it. A fresh `jti` every time. */
async function grant(
  audience = AUDIENCE,
  scopes: Scope[] = ['fit'],
): Promise<{ token: string; jti: string }> {
  const now = Math.floor(Date.now() / 1000);
  const claims = { v: 1 as const, jti: newJti(), aud: audience, scopes, iat: now, exp: now + 3600 };
  await recordIssue(db, {
    jti: claims.jti,
    audience,
    scopes,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    revokedAt: null,
    note: 'fit workflow suite',
  });
  return { token: await mintToken(TEST_SIGNING_KEY, claims), jti: claims.jti };
}

/** 203 characters after the trim, which clears `FIT_INPUT`'s 200-character floor. */
const A_ROLE = 'A generic description of a role, long enough to satisfy the schema. '
  .repeat(3)
  .trim();

async function start(token: string): Promise<string> {
  const response = await fetch(`${origin}/fit/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ target_description: A_ROLE }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

/** What `instance.status()` answers with, narrowed to the two fields read here. */
interface InstanceStatus {
  status: string;
  error?: { message?: string } | null;
}

/**
 * The status of an instance once it stops moving.
 *
 * Copied in shape from tests/evals-schedule.test.ts's own `settled`, and for
 * the same reason: an instance is asynchronous, so the status the moment after
 * `create` is `queued` whatever it is about to do, and the error text is what
 * distinguishes a refusal this branch wrote from a `TypeError` that merely
 * happened.
 */
async function settled(instance: {
  status: () => Promise<InstanceStatus>;
}): Promise<InstanceStatus> {
  const deadline = Date.now() + 20_000;
  let seen = await instance.status();
  while (seen.status !== 'errored' && seen.status !== 'complete' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    seen = await instance.status();
  }
  return seen;
}

test('the deferred run is a workflow instance named by the permalink id', async () => {
  // THE WHOLE FIX, IN ONE READING. Under the shape this replaces there was
  // nothing here to address: `ctx.waitUntil(completeRun(...))` hands the
  // runtime an anonymous promise, and the only way to ask whether it survived
  // was to watch the row and wait. An instance carries its own status, and it
  // is named by the report id ON PURPOSE -- so an operator holding a permalink
  // can run `wrangler workflows instances describe rlme-fit <id>` and a test
  // can do this.
  const { token } = await grant();
  const id = await start(token);

  const instance = await env.FIT_WORKFLOW.get(id);
  const seen = await settled(instance);

  // `complete` rather than `errored`, and the difference is the point: the
  // engine REFUSED at the seam, which is a run that finished and closed its
  // row as failed. An instance that errored would mean the run itself broke.
  expect(seen.status, `the instance for ${id} did not complete: ${seen.error?.message}`).toBe(
    'complete',
  );

  const closed = await db
    .prepare('SELECT status, failure_code, audience FROM fit_reports WHERE id = ?')
    .bind(id)
    .first<{ status: string; failure_code: string | null; audience: string }>();
  expect(closed?.status).toBe('failed');
  expect(closed?.failure_code).toBe('refused');
  // Read back off the ROW rather than carried in the params, which is the
  // decision recorded in workers/mcp/src/fit-workflow.ts.
  expect(closed?.audience).toBe(AUDIENCE);
});

test('a run whose row is gone refuses before it spends anything', async () => {
  // THE CASE THE OLD SHAPE HAD NO ANSWER FOR. `fit_reports` is swept at 365
  // days (src/lib/retention.ts), and `wrangler workflows trigger rlme-fit` can
  // be handed any id by a person. Either way the run has nothing to write to,
  // and `analyze_fit` is the one `expensive` tool in this server -- so the row
  // read is what the run is anchored to and it happens BEFORE the engine call.
  //
  // IT THROWS RATHER THAN RETURNING QUIETLY, following `suitesOf` in
  // workers/mcp/src/evals-workflow.ts: there is no row to record the outcome
  // on, so the instance's own error is the only place an operator can read
  // what happened, and it is where `wrangler workflows instances describe`
  // already looks.
  const instance = await env.FIT_WORKFLOW.create({
    params: { id: 'a-report-that-does-not-exist' },
  });
  const seen = await settled(instance);

  expect(seen.status).toBe('errored');
  expect(seen.error?.message, 'the instance errored without naming the report').toContain(
    'a-report-that-does-not-exist',
  );
});

test('the audit trail records the accepted call exactly once', async () => {
  // THE SECOND FINDING (#349). The production run on 2026-09-22 wrote
  // `analyze_fit / tier=private / outcome=ok / duration_ms=487` for a run that
  // produced nothing, because `limitAndAudit` audits the moment the guarded
  // body returns. That row is kept as it is and now means ACCEPTED: the call
  // the limiter metered really did succeed in 487 ms, and what the run came to
  // is recorded where the run ends, on `fit_reports`.
  //
  // WHAT THIS PINS is the half of that decision a comment cannot hold. The
  // tempting repair is a SECOND `mcp_tool_calls` row written when the run
  // closes, and it would quietly break two things: `scripts/token.mjs` answers
  // "what did this token read" by counting rows per `grant_jti`, and
  // tests/fit-start.test.ts finds its own row with `.first()` on that same
  // column and would start reading whichever of two rows came back. One
  // accepted call is one row.
  const { token, jti } = await grant('fixture-audited');
  const id = await start(token);

  // Settled first, so the count below is taken after everything this run will
  // ever write has been written. `recordToolCall` is handed to
  // `ctx.waitUntil`, so the row lands after the response does.
  await settled(await env.FIT_WORKFLOW.get(id));
  const closed = await db
    .prepare('SELECT status FROM fit_reports WHERE id = ?')
    .bind(id)
    .first<{ status: string }>();
  expect(closed?.status, 'the run has not closed its row yet').toBe('failed');

  const rows = await db
    .prepare(
      'SELECT outcome, COUNT(*) AS n FROM mcp_tool_calls WHERE grant_jti = ? GROUP BY outcome',
    )
    .bind(jti)
    .all<{ outcome: string; n: number }>();
  expect(rows.results).toEqual([{ outcome: 'ok', n: 1 }]);
});

/**
 * The CODE of a TypeScript source, with its comments removed.
 *
 * The same device tests/evals-schedule.test.ts uses, and for the same reason:
 * the comments below deliberately WRITE OUT the shapes they forbid, so a scan
 * that counted prose would be permanently red against a comment doing its job.
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

test('the route hands the run to the workflow and nothing else', async () => {
  // THE DRIFT GUARD, NOT THE CODE AS WRITTEN. The defect was invisible because
  // nothing said the engine call must not sit on the request's `waitUntil`
  // budget, and the tempting re-edit -- "just await it here, it is only a
  // second in the tests" -- restores it with every other assertion green.
  //
  // `ctx.waitUntil` IS STILL USED ON THIS PATH and must be: creating an
  // instance settles in milliseconds, which is three orders of magnitude
  // inside the budget. What may not be there is the ENGINE.
  const route = codeOf(await readFile('workers/mcp/src/fit-start.ts', 'utf8'));
  expect(route, 'the route calls the fit engine again').not.toContain('analyzeFit');

  // AND THE PARAMS CARRY THE REPORT ID ALONE. A workflow instance's payload is
  // durable state that Cloudflare retains for up to 30 days, and
  // src/lib/retention.ts -- the table-driven job that makes the published
  // policy true -- cannot trim it. `target_description` is prose a caller
  // pasted and is already on the row under a 365-day window that IS published;
  // a second copy in a store this repository cannot sweep is the leak
  // src/lib/agent-intel/intent.ts's rule exists to prevent. The token is not
  // there for the stronger reason that it is consumed at this route and never
  // needed again.
  expect(route).toContain('params: { id }');
});

test('every step.do in the fit workflow carries a named step config', async () => {
  // WHAT THIS PREVENTS. A `step.do` with no config gets Cloudflare's default
  // policy -- five retries, ten seconds apart, exponential backoff (read from
  // the Workflows documentation, `defaultConfig` at
  // workflows/build/sleeping-and-retrying). `analyze_fit` is the only
  // `expensive` tool in this server, and it was measured at 78,222 ms of
  // frontier-model time, so an unconfigured engine step is five more of those
  // per failure -- spent by a run the limiter metered exactly once.
  //
  // The same shape as tests/evals-schedule.test.ts's scan over
  // workers/mcp/src/evals-workflow.ts, deliberately: this is the second
  // Workflow class in this Worker and the hazard is identical.
  const code = codeOf(await readFile('workers/mcp/src/fit-workflow.ts', 'utf8'));

  const opens: number[] = [];
  for (const match of code.matchAll(/\bstep\.do\(/g)) {
    opens.push(match.index + match[0].length - 1);
  }
  expect(opens.length, 'no step.do call sites found').toBeGreaterThan(0);

  for (const open of opens) {
    const args = argumentsAt(code, open);
    expect(
      args[1]?.trim(),
      `a step.do near "${args[0]?.trim()}" does not pass ENGINE_STEP or ROW_STEP`,
    ).toMatch(/^(ENGINE_STEP|ROW_STEP)$/);
  }
});

/**
 * The top-level arguments of the call whose opening `(` sits at `open`.
 *
 * A bracket matcher rather than a regex, for the reason
 * tests/evals-schedule.test.ts gives: the call sites span lines and pass arrow
 * functions whose bodies contain commas and parentheses. Only a comma at depth
 * 1 splits, and a matcher that loses track yields garbage, which is not one of
 * the two constant names the test demands.
 */
function argumentsAt(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(source.slice(start, index));
        return args;
      }
    } else if (char === ',' && depth === 1) {
      args.push(source.slice(start, index));
      start = index + 1;
    }
  }
  return args;
}

test('the pasted description never enters the workflow payload', async () => {
  // THE STRUCTURAL HALF OF THE TOKEN AND DESCRIPTION RULE. What a workflow
  // instance persists is its params and every `step.do` return value, and
  // neither is readable from this harness -- so what can be asserted is the
  // shape of what goes in. `FitRunParams` has exactly one field.
  //
  // The other half, that the ROW READ sits outside every step so the
  // description is never a persisted return value either, is enforced by the
  // scan above: a read inside a step would have to be a `step.do`, and the
  // only two configs it could carry are named for what they guard.
  const workflow = codeOf(await readFile('workers/mcp/src/fit-workflow.ts', 'utf8'));
  const declaration = /export interface FitRunParams \{([^}]*)\}/.exec(workflow);
  expect(declaration, 'FitRunParams is not declared where the scan expects it').not.toBeNull();
  const fields = [...declaration![1]!.matchAll(/(\w+)\s*:/g)].map((match) => match[1]!);
  expect(fields).toEqual(['id']);
});
