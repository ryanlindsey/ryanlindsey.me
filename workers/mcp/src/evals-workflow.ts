// The scheduled eval run (issue #291), as a Cloudflare Workflow.
//
// WHY A WORKFLOW AND NOT A CRON HANDLER DOING THE WORK. A full weekly run is
// `fit`, `chat` and `leak` -- fifteen cases, each an inference call, paced
// twenty-five seconds apart (PACE_MS, src/lib/evals/plan.ts). That is minutes
// of wall clock spent mostly waiting, which no single Worker invocation should
// hold open. A workflow's `step.sleep` SUSPENDS the instance rather than
// blocking one, and its `step.do` persists each case's result, so an instance
// that is evicted or restarted replays the cases it already finished rather
// than paying for them twice.
//
// WORKFLOWS UNDER THIS REPO'S TEST HARNESS, MEASURED 2026-09-18. A probe
// `workflows` binding was declared in workers/mcp/wrangler.jsonc, a trivial
// `WorkflowEntrypoint` subclass exported from ./index.ts, and the suite run:
// the harness booted cleanly and `env.PROBE_WORKFLOW.create({ params: {} })`
// returned a real instance id locally. That is UNLIKE `ai` and `ai_search`,
// which wrangler classifies as never having a local simulator and which make
// booting this Worker open a remote proxy session that fails at startup (#144,
// recorded in tests/workers.ts). The full suite with the probe present was 86
// of 87 files green, and the single failure was tests/mcp-env.test.ts catching
// the undeclared binding -- that drift test doing its job.
//
// WHAT STILL CANNOT RUN HERE is the work itself. `AI` is overridden to a
// service Worker under the harness, so `env.AI.run()` is a TypeError, and
// `CHAT_ENGINE`, `FIT_ENGINE` and `JUDGE_ENGINE` are all `'off'` besides. The
// `EVALS_RUNNER` seam keeps `scheduled()` from starting an instance at all
// (tests/workers.ts), for that reason and because a run spends frontier-model
// calls through AI Gateway. tests/evals-schedule.test.ts drives the one
// instance this harness can complete: `suites: []`, which mints, iterates
// nothing and revokes.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { PACE_MS, type SuiteName } from '../../../src/lib/evals/plan';
import {
  incompleteRow,
  summarize,
  type CaseResult,
  type EvalRunRecord,
} from '../../../src/lib/evals/record';
import { signingKey } from '../../../src/lib/tier/grant';
import { recordIssue, revokeToken } from '../../../src/lib/tier/registry';
import { mintToken, newJti, type Scope, type TokenClaims } from '../../../src/lib/tier/token';
import { BUNDLED_CASES } from './evals-cases';
import { runChatCase, runFitCase, runLeakProbe, runTierCase } from './evals-run';
import type { McpEnv } from './env';

/** What `scheduled()` hands an instance: the suites this cron asked for, in run order. */
export interface EvalsRunParams {
  suites: SuiteName[];
}

/**
 * NO RETRY ON A CASE, AND THE DEFAULT IS WHAT MAKES THAT A DECISION RATHER
 * THAN AN OMISSION. A `step.do` with no config gets Cloudflare's default
 * policy -- five retries, ten seconds apart, exponential backoff -- and that
 * would be a THIRD retry layer stacked on two this repository has already
 * measured and capped.
 *
 * The layers, so the composition is written down once: AI Gateway retries a
 * call up to four times on its own (recorded in `RETRIES` in
 * src/lib/evals/plan.ts), `ask` and `askJudge` retry once past a transient
 * refusal, and a step would retry on top of both. plan.ts settled on exactly
 * one client attempt for a stated reason -- the gateway already implements
 * this, a failure reaching the client is one it has already given up on, and a
 * second mechanism at a second layer is harder to reason about than either
 * alone. A third is strictly worse than that, and it is not free: a case step
 * that throws is a case that was about to be paid for again, five more times.
 *
 * THE CONCRETE EXPOSURE IS `fit`. `payloadOf` throws on an event stream
 * carrying no data line, which is the exact failure its own comment records,
 * and `rpc`'s `JSON.parse` throws on a malformed body. Under the default, each
 * throw sends the step back through another `analyze_fit` -- an Opus call over
 * the whole corpus -- five more times, each doing its own client retry, each
 * of those fanning out at the gateway.
 *
 * WHAT A THROW DOES INSTEAD: it leaves `runSuite`, and `run()` writes an
 * `incomplete` row for that suite. That is the same outcome evals/run.mjs
 * reaches by different means -- a throw from `rpc` there takes down the whole
 * suite and the process with it -- and it is strictly more informative,
 * because the row says the suite did not run rather than leaving its absence
 * to be noticed.
 *
 * `delay` is required by the type and inert at a limit of zero.
 *
 * THE TEN-MINUTE DEFAULT STEP TIMEOUT IS CONSIDERED AND LEFT ALONE. What
 * bounds a step here is a call COUNT rather than a guess at latency: a `fit`
 * case is one `analyze_fit` with no client retry at all, and the longest step
 * in any suite is a `chat` case or a `leak` probe, which is at most two chat
 * turns and two judge calls with a ten-second backoff before each retried one.
 * Four model calls and twenty seconds of waiting is not a ten-minute step.
 */
const CASE_STEP: WorkflowStepConfig = { retries: { limit: 0, delay: 0 } };

/**
 * ONE retry on the row write, which is the one place a retry earns its keep.
 *
 * The 2026-09-11 incident evals/run.mjs's recording comment records was a
 * TRANSIENT write failure: the same statement succeeded against the same
 * database minutes later and the cause was never established. So one cheap
 * second attempt is worth having here in a way it is not on a case, because
 * what is being repeated costs a D1 write rather than an Opus call.
 *
 * One rather than the default five, and five seconds rather than ten with
 * exponential backoff: the catch around this step logs and continues, so the
 * only thing the default would buy is stalling the run for about five minutes
 * before it does.
 */
const RECORD_STEP: WorkflowStepConfig = { retries: { limit: 1, delay: '5 seconds' } };

/**
 * The audience the run mints under. GENERIC ON PURPOSE (09 §2): an audience
 * label is an opaque string to everything that reads it, and this repository
 * is public, so the label says what the caller IS and never who it is for.
 */
const AUDIENCE = 'scheduled-evals';

/**
 * `evals` admits the run to `POST /chat` and to `judge_answer`; `fit` opens
 * `analyze_fit`. Nothing else: the `tier` suite calls anonymously by design,
 * and no suite reads a private document.
 */
const SCOPES: Scope[] = ['evals', 'fit'];

/**
 * One hour, which is longer than any run and shorter than any window worth
 * worrying about. The token is revoked in a `finally` regardless; this is what
 * bounds the one case that cannot be -- an instance that dies between the mint
 * and the revoke.
 */
const TOKEN_TTL_SECONDS = 3600;

export class EvalsWorkflow extends WorkflowEntrypoint<McpEnv, EvalsRunParams> {
  /**
   * THE TOKEN IS MINTED HERE, OUTSIDE EVERY `step.do`, AND THAT IS THE ONE
   * DECISION IN THIS FILE A LATER EDIT WOULD QUIETLY UNDO.
   *
   * A `step.do`'s return value is PERSISTED in the workflow's own durable
   * state, so that a resumed instance can replay the step instead of
   * re-running it. That is the whole point of a step, and it is exactly why
   * the mint must not be one: this bearer admits its holder to `POST /chat`
   * and to `judge_answer`, which is to say it is a frontier-model credential,
   * and this design has no reason to write one down anywhere. Minting at the
   * top of `run()` means a resumed instance mints a FRESH token rather than
   * reading a stored one, and the stored state never holds a credential at
   * all.
   *
   * So tidying this into `step.do('mint', ...)` -- which would look like an
   * improvement, since everything else here is a step -- reverses that
   * silently and with every test still green. It is written down because the
   * reason is invisible in the code.
   *
   * The cost is small and worth naming: a resumed instance's earlier cases
   * were judged under a token that no longer exists. Nothing reads a token
   * after the call it authorised, and the audit rows name the `jti` that was
   * live at the time, so the trail stays honest across a resume.
   */
  async run(event: Readonly<WorkflowEvent<EvalsRunParams>>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    const { suites } = event.payload;

    const issuedAt = Math.floor(Date.now() / 1000);
    const claims: TokenClaims = {
      v: 1,
      jti: newJti(),
      aud: AUDIENCE,
      scopes: [...SCOPES],
      iat: issuedAt,
      exp: issuedAt + TOKEN_TTL_SECONDS,
    };

    let token: string;
    try {
      token = await mintToken(await signingKey(env), claims);
      await recordIssue(env.DB, {
        jti: claims.jti,
        audience: AUDIENCE,
        scopes: [...SCOPES],
        issuedAt: new Date(claims.iat * 1000).toISOString(),
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        revokedAt: null,
        note: `scheduled run: ${suites.join(', ') || 'no suite'}`,
      });
    } catch (error) {
      // A MINT THAT FAILED IS AN INCOMPLETE RUN, NOT A FAILED ONE, and every
      // requested suite has to say so. Writing nothing would leave /ops
      // publishing the previous run's numbers under "Latest run per suite",
      // which is indistinguishable from a suite that is still passing -- the
      // exact confusion migrations/0005_eval_run_status.sql exists to end.
      console.error(`evals: the scheduled run could not mint a token: ${messageOf(error)}`);
      const ranAt = new Date().toISOString();
      for (const suite of suites) {
        await record(env, step, incompleteRow(suite, 'the run could not mint a token', ranAt));
      }
      return;
    }

    try {
      for (const suite of suites) {
        const ranAt = new Date().toISOString();
        let results: CaseResult[];
        try {
          results = await runSuite(env, step, suite, token);
        } catch (error) {
          // A suite whose cases THREW is a suite that did not run. Its cases
          // report their own failures as results; anything that escapes them
          // is the transport or the workflow itself, and the honest row says
          // so rather than reporting zero of zero passing.
          const reason = messageOf(error);
          console.error(`evals: the ${suite} suite did not complete: ${reason}`);
          await record(
            env,
            step,
            incompleteRow(suite, `the suite did not complete: ${reason.slice(0, 200)}`, ranAt),
          );
          continue;
        }

        await record(env, step, summarize(suite, results, ranAt));

        // LOUD, IN A PLACE WITH NO TERMINAL. `leak` is the private-tier
        // disclosure gate (09 §2), and a red probe there is the one result
        // nobody should have to go looking for. This Worker runs with
        // `observability.logs.persist` on (workers/mcp/wrangler.jsonc), so the
        // line is readable after the fact.
        //
        // DELIBERATELY NOT THE QUEUE OR THE EMAIL PATH. `EVENTS` carries
        // high-intent events (06 §3), and an eval failure is not one: issue
        // #291 says so, and a notification channel that also carries
        // housekeeping stops being read.
        if (suite === 'leak') {
          const failed = results.filter((result) => !result.ok).length;
          if (failed > 0) {
            console.error(`evals: the leak suite failed ${failed} of ${results.length} probes`);
          }
        }
      }
    } finally {
      // SWALLOWED AFTER LOGGING, for the same reason a failed row write is:
      // this is bookkeeping, and an unrevoked token expires on its own inside
      // the hour `TOKEN_TTL_SECONDS` above allows it.
      try {
        await revokeToken(env.DB, claims.jti, new Date().toISOString());
      } catch (error) {
        console.error(
          `evals: the scheduled token ${claims.jti} could not be revoked: ${messageOf(error)}`,
        );
      }
    }
  }
}

/**
 * An error's own message, interpolated rather than passed as a second argument
 * to `console.error`: Workers' log pipeline renders the stack and drops the
 * message, so `console.error(msg, err)` loses the one part worth reading.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Writes one `eval_runs` row, in its own step.
 *
 * `model` IS WRITTEN AS AN EXPLICIT NULL, exactly as evals/run.mjs writes it.
 * `EvalRunRecord` (src/lib/evals/record.ts) carries no `model` field by
 * design: which model answered is a property of the deployed engine rather
 * than of a suite's result, so it is the writer's own concern and this writer
 * has nothing to say about it.
 *
 * BOUND PARAMETERS, NOT INTERPOLATION, which is the second half of a decision
 * recorded in `redactedNotes`: that function truncates and redacts but
 * deliberately does not escape quotes, because evals/run.mjs hand-builds a SQL
 * string and needs the escaping to happen after the truncation, while this
 * path binds and needs none at all.
 *
 * RECORDING IS BOOKKEEPING; THE RESULTS ARE THE PRODUCT. A row that will not
 * insert must not destroy the run that produced it -- the same trade
 * `recordToolCall` (src/lib/mcp/audit.ts) and `writeTranscript`
 * (workers/mcp/src/chat.ts) already make, and the one evals/run.mjs learned to
 * make on 2026-09-11 after a failed insert killed a six-minute run.
 */
async function record(env: McpEnv, step: WorkflowStep, row: EvalRunRecord): Promise<void> {
  try {
    await step.do(`${row.suite}/record`, RECORD_STEP, async () => {
      await env.DB.prepare(
        `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed, status, notes)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
        .bind(row.ranAt, row.suite, row.total, row.passed, row.failed, row.status, row.notes)
        .run();
      return row.suite;
    });
  } catch (error) {
    console.error(
      `evals: the ${row.suite} eval_runs row could not be written: ${messageOf(error)}`,
    );
  }
}

/** One unit of work: a step's name and the case it runs. */
interface Unit {
  name: string;
  run: () => Promise<CaseResult>;
}

/**
 * Runs units in order, one `step.do` each, `PACE_MS` apart.
 *
 * NOT BEFORE THE FIRST, which is where the pacing arithmetic in
 * `PACE_MS`'s own comment comes from: the gaps are `cases - 1` summed, two
 * from three fit cases, three from four chat cases and seven from eight leak
 * probes. A sleep before the first case would buy nothing -- there is no
 * preceding request for it to space this one away from.
 *
 * `step.sleep` rather than a `setTimeout`: it suspends the instance instead of
 * holding an invocation open for twenty-five seconds at a time.
 */
async function runPaced(step: WorkflowStep, units: Unit[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const [index, unit] of units.entries()) {
    if (index > 0) await step.sleep(`pace before ${unit.name}`, PACE_MS);
    results.push(await step.do(unit.name, CASE_STEP, unit.run));
  }
  return results;
}

/** One suite's cases, as `CaseResult`s, in the order evals/run.mjs runs them. */
async function runSuite(
  env: McpEnv,
  step: WorkflowStep,
  suite: SuiteName,
  token: string,
): Promise<CaseResult[]> {
  switch (suite) {
    case 'tier': {
      // NOT PACED, mirroring `runTier` in evals/run.mjs, and it looks like an
      // omission so it is worth saying why: `tier` spends no inference at all.
      // Its calls are the handshake, two listings and the no-argument tools,
      // so it puts nothing on the AI Gateway quota `PACE_MS` exists to respect
      // -- which is why the twelve gaps that comment counts are fit's, chat's
      // and leak's, and none of them are here.
      const results: CaseResult[] = [];
      for (const testCase of BUNDLED_CASES.tier) {
        results.push(
          await step.do(
            `tier/${testCase.id}`,
            CASE_STEP,
            async () => await runTierCase(env.SELF, testCase),
          ),
        );
      }
      return results;
    }
    case 'fit':
      return await runPaced(
        step,
        BUNDLED_CASES.fit.map((testCase) => ({
          name: `fit/${testCase.id}`,
          run: async () => await runFitCase(env.SELF, testCase, token),
        })),
      );
    case 'chat':
      return await runPaced(
        step,
        BUNDLED_CASES.chat.map((testCase) => ({
          name: `chat/${testCase.id}`,
          run: async () => await runChatCase(env.SELF, testCase, token),
        })),
      );
    case 'leak': {
      // PACED PER CASE FILE, not across the flattened list, because that is
      // what `runLeak` in evals/run.mjs does: its `index > 0` test restarts
      // with each file it loads. The two are the same thing only because
      // `evals/cases/leak/` holds exactly one file today -- `PACE_MS`'s own
      // comment records that subtlety, and mirroring it here is what keeps the
      // two runners from diverging on the day a second file lands.
      const results: CaseResult[] = [];
      for (const testCase of BUNDLED_CASES.leak) {
        results.push(
          ...(await runPaced(
            step,
            testCase.questions.map((_question, index) => ({
              name: `leak/${testCase.id}[${index}]`,
              run: async () => await runLeakProbe(env.SELF, testCase, index, token),
            })),
          )),
        );
      }
      return results;
    }
  }
}
