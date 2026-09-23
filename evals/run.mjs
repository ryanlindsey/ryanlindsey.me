#!/usr/bin/env node
// The eval suite's runner (04 §4). OWNER-RUN, against a deployed endpoint or
// a local `wrangler dev` -- CI holds no inference credential (10 §2.4), so
// this is a pre-merge gate a person runs rather than a workflow step.
//
// DETERMINISTIC CHECKS ONLY at v1, and that is a recorded decision rather than
// an omission: 04 §4 also wants LLM-judge scoring of grounding, honesty and
// tone, and that lands with the chat suite it was designed for (day 6). What
// is here is the half that needs no judge -- schema validity, citation
// resolution against the live corpus, the presence of gaps where a golden case
// requires them, and a banned-pattern scan of everything the public tier says.
//
// THE TOKEN. `analyze_fit` needs a grant, and this script reads it from
// RLME_EVAL_TOKEN in the environment. The owner exports it in their own shell
// (10 §3.4); it is never an argument, never printed, and never written down by
// anything here. Without it the `fit` suite skips loudly rather than failing
// quietly.
//
//   npm run evals -- --endpoint https://mcp.ryanlindsey.me
//   npm run evals -- --endpoint http://127.0.0.1:8787 --suite tier --no-record

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FitReport } from '../src/lib/fit/schema.ts';
// The judging logic below (the per-suite problem lists, the pacing constants,
// and the `pass`/`fail` case shape) is shared with the MCP Worker's scheduled
// runner (Task 4), so it lives in src/lib/evals/ rather than here -- see
// checks.ts, plan.ts and record.ts for the reasoning behind each check and
// each measured number.
import {
  chatProblems,
  fitProblems,
  judgeProblems,
  leakProblems,
  reachedNoModel,
  tierProblems,
} from '../src/lib/evals/checks.ts';
import { BACKOFF_MS, PACE_MS, RETRIES } from '../src/lib/evals/plan.ts';
import { fail, localCount, pass, summarize, unreached } from '../src/lib/evals/record.ts';

const CASES = new URL('./cases/', import.meta.url).pathname;
const DB = 'ryanlindsey-me-db';
// Public (already committed in both wrangler.jsonc files); hardcoded because
// this login resolves two Cloudflare accounts and wrangler cannot pick one
// non-interactively. Same precedent as scripts/token.mjs and
// scripts/private-doc.mjs.
const ACCOUNT_ID = '1b764d090899bf1ee61a8d1e87c10710';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || index === process.argv.length - 1 ? fallback : process.argv[index + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const endpoint = arg('endpoint', 'https://mcp.ryanlindsey.me');
const only = arg('suite', null);
const record = !flag('no-record');

let rpcId = 1;
async function rpc(method, params, token) {
  const response = await fetch(`${endpoint}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const text = await response.text();
  return JSON.parse(payloadOf(response, text));
}

/**
 * The JSON body of a Streamable HTTP response, whether it arrived as JSON or as
 * one SSE frame.
 *
 * DECIDED BY CONTENT-TYPE, not by what the first line happens to be. The version
 * this replaces tested `text.startsWith('event:') || text.startsWith('data:')`,
 * which is true for every fast response and false for a slow one: SSE allows a
 * COMMENT line -- anything beginning with `:` -- and the transport sends
 * `: keepalive` to hold the connection open. `analyze_fit` is an Opus call over
 * the whole corpus and is slow enough to get one, so the body arrived as
 * `: keepalive\n\nevent: message\ndata: {...}`, the prefix test said "not SSE",
 * and the whole stream went to `JSON.parse`:
 *
 *   SyntaxError: Unexpected token ':', ": keepaliv"... is not valid JSON
 *
 * Nothing had ever exercised it. `tier` needs no token and answers fast enough
 * that no heartbeat is sent; `fit` needs one, and no token existed until the
 * signing-key bug in scripts/token.mjs was fixed -- so the first real `fit` run
 * in this repo's history was also the first thing to meet a keepalive.
 *
 * Comment lines are skipped rather than parsed, which is what the SSE spec says
 * to do with them, and an absent `data:` line is a thrown error naming the
 * status rather than a `TypeError` on `undefined.slice`.
 */
function payloadOf(response, text) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) return text;
  const data = text.split('\n').find((line) => line.startsWith('data:'));
  if (data === undefined) {
    throw new Error(
      `the endpoint answered ${response.status} with an event stream carrying no data line`,
    );
  }
  return data.slice(5).trim();
}

/**
 * `local` marks a case loaded from a gitignored `*.local.json` file (the
 * owner's own convention for pointing the suite at a real description
 * without ever committing it -- see README). It travels with every result
 * `report()` builds from this case, because that is the ONLY place the
 * distinction matters: it decides what may be sent to the remote `eval_runs`
 * row, never what prints to this operator's own terminal.
 */
const load = (suite) =>
  readdirSync(join(CASES, suite))
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      ...JSON.parse(readFileSync(join(CASES, suite, name), 'utf8')),
      local: name.endsWith('.local.json'),
    }));

async function runTier() {
  const results = [];
  for (const testCase of load('tier')) {
    const listed = await rpc('tools/list', {});
    const names = listed.result.tools.map((tool) => tool.name);

    // Everything the public tier says, in one string: the handshake's
    // instructions, the tool metadata, the resource listings, and the output of
    // every tool that takes no required argument.
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'rlme-evals', version: '1' },
    });
    const surfaces = [init.result.instructions, JSON.stringify(listed.result)];
    surfaces.push(JSON.stringify((await rpc('resources/list', {})).result));
    surfaces.push(JSON.stringify((await rpc('resources/templates/list', {})).result));
    for (const tool of listed.result.tools) {
      if ((tool.inputSchema?.required ?? []).length > 0) continue;
      surfaces.push(JSON.stringify((await rpc('tools/call', { name: tool.name })).result));
    }

    const problems = tierProblems(testCase, names, surfaces);
    results.push(
      problems.length === 0
        ? pass(testCase.id, testCase.local)
        : fail(testCase.id, problems.join('; '), testCase.local),
    );
  }
  return results;
}

const FIT_SKIP_REASON = 'RLME_EVAL_TOKEN is not set in this shell';

async function runFit() {
  const token = process.env.RLME_EVAL_TOKEN;
  if (!token) {
    // Loud, and NOT a pass. A suite that quietly reports success because it
    // could not run is the exact failure this repo keeps writing comments
    // about -- so this goes to stderr for the terminal AND, in main below, to
    // the stdout summary a redirected log actually keeps, and it flips the
    // exit code rather than leaving `green` untouched.
    process.stderr.write(`SKIP fit: ${FIT_SKIP_REASON}\n`);
    return null;
  }

  const results = [];
  let firstFit = true;
  for (const testCase of load('fit')) {
    // Paced like the chat cases, though these are the least likely to need it:
    // an Opus call over the whole corpus takes long enough that three of them
    // are already spread out. Consistent so the pacing is one rule rather than
    // a rule with an exception nobody remembers the reason for.
    if (!firstFit) await sleep(PACE_MS);
    firstFit = false;
    const answer = await rpc(
      'tools/call',
      { name: 'analyze_fit', arguments: { target_description: testCase.target_description } },
      token,
    );
    if (answer.result?.isError) {
      results.push(
        fail(
          testCase.id,
          `tool refused: ${answer.result.content?.[0]?.text ?? ''}`,
          testCase.local,
        ),
      );
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(answer.result.content[0].text);
    } catch {
      results.push(fail(testCase.id, 'the tool did not return JSON', testCase.local));
      continue;
    }

    const parsed = FitReport.safeParse(payload.report);
    if (!parsed.success) {
      results.push(
        fail(
          testCase.id,
          `report failed the schema: ${parsed.error.message.slice(0, 200)}`,
          testCase.local,
        ),
      );
      continue;
    }

    const report = parsed.data;
    const problems = fitProblems(testCase, report, payload.citations_dropped ?? 0);

    results.push(
      problems.length === 0
        ? pass(testCase.id, testCase.local)
        : fail(testCase.id, problems.join('; '), testCase.local),
    );
  }
  return results;
}

// ---- day 6: chat and leak (04 §1, 04 §4, 09 §2) -------------------------

const CHAT_SKIP_REASON = 'RLME_EVAL_TOKEN is not set in this shell';

// RETRIES, BACKOFF_MS and PACE_MS (imported above from src/lib/evals/plan.ts)
// used to be defined here, each with a long measured comment; that reasoning
// -- the AI Gateway's wholesale rate limit, the 2026-09-10 pacing
// measurements, and why one client retry rather than more -- now lives in
// plan.ts, shared with the MCP Worker's scheduled runner (Task 4).

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Codes worth retrying: the endpoint could not reach the model, for now. */
const TRANSIENT = new Set(['unreachable']);

/**
 * Reads one chat turn off the wire, returning the frames the contract defines.
 *
 * THE TOKEN IS MANDATORY HERE, unlike in `runFit` where it gates one suite:
 * `POST /chat` admits a Turnstile token or an `evals` grant and nothing else,
 * and this process cannot solve a challenge. So the chat and leak suites SKIP
 * loudly without `RLME_EVAL_TOKEN` rather than reporting a run of refusals as
 * failures -- a suite that reports "the model would not answer" when the truth
 * is "the harness was not admitted" is worse than one that does not run.
 *
 * `error` may arrive INSTEAD of `sources` (a guard refused) or AFTER deltas
 * (the upstream stream broke mid-answer). Both are collected; the caller
 * decides which matters.
 */
async function askOnce(question, token) {
  const response = await fetch(`${endpoint}/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ question }),
  });
  const text = await response.text();
  let sources = [];
  let answer = '';
  let error = null;
  let cited = [];
  for (const frame of text.split('\n\n').filter(Boolean)) {
    const name = frame.match(/^event: (.+)$/m)?.[1];
    let data = {};
    try {
      data = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? '{}');
    } catch {
      continue;
    }
    if (name === 'sources') sources = data.sources ?? [];
    else if (name === 'delta') answer += data.text ?? '';
    else if (name === 'done') cited = data.cited ?? [];
    // `?? null` ON BOTH SIDES, changed here in Task 4 (issue #291) so that the
    // two runners describe one wire event identically. `chatProblems` and
    // `leakProblems` (src/lib/evals/checks.ts) test `error !== null`, so an
    // error frame carrying no `code` used to read as the string "undefined" in
    // this runner and as no error at all in the Worker's -- the one place in
    // the port where the same frame produced two different results, which is
    // exactly the property one home for the judging logic exists to protect.
    // `null` is the better of the two behaviors: an error frame without a
    // code says nothing a reader can act on, and reporting `refused with
    // "undefined"` sends somebody after a code that was never sent.
    else if (name === 'error') error = data.code ?? null;
  }
  return { sources, answer, cited, error };
}

/**
 * One chat turn, retried past a transient refusal.
 *
 * The LAST attempt's result is returned whatever it says, so a case that is
 * genuinely refused still reports the code rather than a retry count -- the
 * suite's job is to say what happened, and "unreachable after 3 attempts" is a
 * different and more useful fact than "unreachable".
 */
async function ask(question, token) {
  let result = await askOnce(question, token);
  for (let attempt = 1; attempt <= RETRIES && TRANSIENT.has(result.error); attempt += 1) {
    await sleep(BACKOFF_MS * attempt);
    result = await askOnce(question, token);
  }
  return result;
}

/**
 * Scores `subject` against `criteria` through the gated judge tool.
 *
 * A thrown judge is NOT a failed case: `JudgeUnavailable` means the scorer did
 * not run, and reporting that as a red case sends somebody after a prompt
 * regression that never happened. It returns null and the caller records the
 * case as unjudged, which flips the exit code the same way a skipped suite does.
 */
async function askJudge(criteria, subject, token) {
  let answer = await rpc(
    'tools/call',
    { name: 'judge_answer', arguments: { criteria, subject } },
    token,
  );
  // Retried for the same reason `ask` is: `judge_answer` spends a model call
  // through the same gateway, in the same burst, and a rate-limited judge
  // reports "the judge did not run" -- which reads like a broken tool rather
  // than a busy minute.
  for (
    let attempt = 1;
    attempt <= RETRIES && (answer.error || answer.result?.isError);
    attempt += 1
  ) {
    await sleep(BACKOFF_MS * attempt);
    answer = await rpc(
      'tools/call',
      { name: 'judge_answer', arguments: { criteria, subject } },
      token,
    );
  }
  if (answer.error || answer.result?.isError) return null;
  try {
    return JSON.parse(answer.result.content[0].text);
  } catch {
    return null;
  }
}

async function runChat() {
  const token = process.env.RLME_EVAL_TOKEN;
  if (!token) {
    process.stderr.write(`SKIP chat: ${CHAT_SKIP_REASON}\n`);
    return null;
  }

  const results = [];
  let first = true;
  for (const testCase of load('chat')) {
    if (!first) await sleep(PACE_MS);
    first = false;
    const expect = testCase.expect ?? {};
    const answer = await ask(testCase.question, token);
    const problems = chatProblems(testCase, answer);

    // The judge runs LAST and only on an answer that survived the deterministic
    // checks. Scoring an answer we already know is wrong spends a model call to
    // learn nothing.
    if (problems.length === 0 && expect.judge) {
      const verdict = await askJudge(expect.judge.criteria, answer.answer, token);
      problems.push(...judgeProblems(verdict));
    }

    // `unreached` rather than `fail` when the model never answered, so a suite
    // made only of these records "did not run" (src/lib/evals/record.ts).
    const outcome = reachedNoModel(answer) ? unreached : fail;
    results.push(
      problems.length === 0
        ? pass(testCase.id, testCase.local)
        : outcome(testCase.id, problems.join('; '), testCase.local),
    );
  }
  return results;
}

/**
 * The leak suite (09 §2).
 *
 * EVERY PROBE IS ITS OWN RESULT rather than one pass/fail for the file, so a
 * red run names the question that leaked instead of the case that contains
 * eight of them. The probes deliberately avoid the banned vocabulary --
 * `BANNED_PATTERNS` is what the ANSWERS are scanned for, so a probe built from
 * that list would only prove the model can echo.
 */
async function runLeak() {
  const token = process.env.RLME_EVAL_TOKEN;
  if (!token) {
    process.stderr.write(`SKIP leak: ${CHAT_SKIP_REASON}\n`);
    return null;
  }

  const results = [];
  for (const testCase of load('leak')) {
    for (const [index, question] of (testCase.questions ?? []).entries()) {
      if (index > 0) await sleep(PACE_MS);
      const id = `${testCase.id}[${index}]`;
      const answer = await ask(question, token);
      const problems = leakProblems(testCase, answer);
      if (problems.length === 0 && testCase.judge) {
        const verdict = await askJudge(testCase.judge.criteria, answer.answer, token);
        problems.push(...judgeProblems(verdict));
      }

      const outcome = reachedNoModel(answer) ? unreached : fail;
      results.push(
        problems.length === 0
          ? pass(id, testCase.local)
          : outcome(id, `"${question}" -- ${problems.join('; ')}`, testCase.local),
      );
    }
  }
  return results;
}

/**
 * Prints and records one suite's results, and says what they amount to: `true`
 * for a clean run, `false` for a real failure, and `null` for a suite where no
 * case reached the model. The caller treats `null` as a suite that did not
 * execute, so a transport fault exits 2 rather than 1 (issue #341).
 */
function report(suite, results) {
  const passed = results.filter((r) => r.ok).length;
  const row = summarize(suite, results, new Date().toISOString());
  for (const result of results) {
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${suite}/${result.id} ${result.notes}\n`);
  }
  process.stdout.write(
    row.status === 'incomplete'
      ? `${suite}: incomplete -- no case reached the model, so this is not a gate result\n`
      : `${suite}: ${passed}/${results.length}\n`,
  );

  if (record) {
    const local = localCount(results);
    if (local > 0) {
      process.stdout.write(
        `${suite}: ${local} local case(s) redacted from the remote eval_runs row\n`,
      );
    }
    // A `local` case (README: an owner's real, ungitignored description) may
    // carry its actual id and model-derived failure text -- exactly what the
    // no-real-campaign-data rule exists to keep out of anything that isn't
    // this operator's own terminal. `eval_runs` is remote, so a local case
    // contributes to the counts below (a number leaks nothing) and nothing
    // else: its id and notes never leave this process.
    //
    // Truncate the RAW string first, then escape: escaping first can leave
    // a cut land inside a doubled `''` pair, dropping one of the two quotes
    // and unterminating the SQL literal that follows. `redactedNotes`
    // (src/lib/evals/record.ts, reached through `summarize`) does the
    // filtering, redaction and truncation; it deliberately does not escape,
    // because the Worker runner (Task 4) binds parameters instead and needs
    // none -- so escaping stays here.
    const notes = row.notes.replace(/'/g, "''");
    // `status` comes from `summarize`, the same function the scheduled runner
    // records through, so the two agree on when a run is `incomplete`. From
    // here that is exactly one case: every case ran and none reached the model
    // (issue #341). That is not the operator's choice, it is the deployed
    // system failing, which is why it records where a skip does not.
    //
    // A SKIP STILL WRITES NO ROW. An earlier version of this comment pointed at
    // "the SKIP handling below" for the 'incomplete' case, which was wrong: that
    // handling writes no row at all, calls no `incompleteRow`, and never has.
    //
    // THAT IS DELIBERATE AND IT IS WHERE THE TWO RUNNERS DIFFER ON PURPOSE. A
    // scheduled run that could not run is news, because the only thing that
    // stopped it is something broken -- a mint that failed, a suite that threw
    // -- and nobody was watching, so the row is the only way anyone finds out.
    // A skip here is the operator's own choice in the operator's own shell: it
    // means `RLME_EVAL_TOKEN` was not exported, the SKIP line is already on
    // their terminal, and the exit code is already 2. Writing that to
    // `eval_runs` would replace a real older result on a PUBLIC page with "did
    // not run", caused by an unset variable in one person's shell. A stale pass
    // is a worse thing to publish than a genuine one, and an unset variable is
    // not evidence that anything is wrong with the deployed system.
    const sql = `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed, status, notes)
       VALUES ('${row.ranAt}', '${suite}', NULL, ${row.total}, ${row.passed},
               ${row.failed}, '${row.status}', '${notes}')`;
    // SWALLOWED AFTER LOGGING, and the results above are already on stdout by
    // the time this runs -- which is the whole point of the ordering.
    //
    // RECORDING IS BOOKKEEPING; THE RESULTS ARE THE PRODUCT. This call used to
    // be unguarded, and on 2026-09-11 one invocation failed after a full run:
    // node exited with a stack trace, the process died before printing the
    // closing summary, and the exit code stopped meaning what the suites said.
    // Sixteen cases' worth of work -- six minutes and several dollars of
    // inference -- reduced to a `Command failed` because a row would not insert.
    //
    // The cause was never established: the same 921-character statement
    // succeeded against the same remote database minutes later, a previous run
    // had recorded 748 characters of notes without complaint, and wrangler's own
    // log was the only place the reason would have been. Transient, most likely.
    // The fix does not depend on knowing: a failure to WRITE DOWN a result must
    // not destroy the result.
    //
    // This is the trade src/lib/mcp/audit.ts's `recordToolCall` and
    // workers/mcp/src/chat.ts's `writeTranscript` already make, in the same
    // words -- "a transcript write that fails must not turn a working answer
    // into an error". The Worker treats its own recording as non-essential; the
    // harness did not, and should.
    try {
      execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--command', sql], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      });
    } catch {
      // Not `console.error`: this goes to stdout as well as stderr, for the
      // same reason the SKIP lines do -- a redirected log keeps stdout, and a
      // run whose results were not recorded should say so in the artifact
      // somebody actually reads later.
      process.stdout.write(
        `${suite}: WARNING -- the results above ran but could not be recorded to eval_runs\n`,
      );
      process.stderr.write(`${suite}: the eval_runs row could not be written\n`);
    }
  }
  return row.status === 'incomplete' ? null : passed === results.length;
}

/** Folds one `report()` outcome into the run's exit state. */
function tally(suite, outcome, green) {
  if (outcome === null) {
    skipped.push(suite);
    return green;
  }
  return outcome && green;
}

// `skipped` is what makes a run that proves less than it looks like
// impossible to mistake for a clean one: a suite that could not run must
// show up in the stdout summary (not only stderr, which a redirected log
// drops) and must move the exit code off 0, even when every suite that DID
// run passed outright.
const skipped = [];

let green = true;
if (only === null || only === 'tier') green = tally('tier', report('tier', await runTier()), green);
if (only === null || only === 'fit') {
  const results = await runFit();
  if (results === null) {
    skipped.push('fit');
    // Same wording as runFit()'s own stderr line -- one message, printed on
    // both streams so it survives a `2>/dev/null` as readily as a `>log`.
    process.stdout.write(`SKIP fit: ${FIT_SKIP_REASON}\n`);
    process.stdout.write('fit: skipped\n');
  } else {
    green = tally('fit', report('fit', results), green);
  }
}

// `chat` and `leak` are day 6's, and `leak` goes LAST deliberately: it is the
// private-tier disclosure gate, and a failure there should be the last thing on
// screen rather than scrolled past.
for (const [name, run] of [
  ['chat', runChat],
  ['leak', runLeak],
]) {
  if (only !== null && only !== name) continue;
  const results = await run();
  if (results === null) {
    skipped.push(name);
    process.stdout.write(`SKIP ${name}: ${CHAT_SKIP_REASON}\n`);
    process.stdout.write(`${name}: skipped\n`);
  } else {
    green = tally(name, report(name, results), green);
  }
}

if (!green) {
  // A real failure outranks an incomplete run: exit 1 says something that DID
  // run is wrong, which is the more urgent fact.
  process.exit(1);
}
if (skipped.length > 0) {
  process.stdout.write(`evals: incomplete run -- ${skipped.join(', ')} did not execute (exit 2)\n`);
  process.exit(2);
}
process.exit(0);
