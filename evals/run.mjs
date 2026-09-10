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

/** One case's outcome. `notes` is what an operator reads when it fails. */
const pass = (id, local) => ({ id, ok: true, notes: '', local });
const fail = (id, notes, local) => ({ id, ok: false, notes, local });

async function runTier() {
  const results = [];
  for (const testCase of load('tier')) {
    const problems = [];

    const listed = await rpc('tools/list', {});
    const names = listed.result.tools.map((tool) => tool.name);
    for (const hidden of testCase.hidden_tools) {
      if (names.includes(hidden)) problems.push(`${hidden} is listed to an anonymous caller`);
    }

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

    for (const source of testCase.banned_patterns) {
      const pattern = new RegExp(source, 'i');
      for (const surface of surfaces) {
        if (pattern.test(surface)) problems.push(`public surface matched /${source}/`);
      }
    }

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
  for (const testCase of load('fit')) {
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
    const expect = testCase.expect;
    const strong = report.requirement_map.filter((entry) => entry.strength === 'strong').length;
    const problems = [];

    if (report.requirement_map.length < (expect.min_requirements ?? 0)) {
      problems.push(
        `${report.requirement_map.length} requirements, expected >= ${expect.min_requirements}`,
      );
    }
    if (expect.min_gaps !== undefined && report.gaps.length < expect.min_gaps) {
      // The honesty contract (03 §4), as a check: a partial or mismatched
      // description that produces no gaps is a flattering engine, and this is
      // the cheapest place to catch one.
      problems.push(`${report.gaps.length} gaps, expected >= ${expect.min_gaps}`);
    }
    if (expect.min_strong !== undefined && strong < expect.min_strong) {
      problems.push(`${strong} strong ratings, expected >= ${expect.min_strong}`);
    }
    if (expect.max_strong !== undefined && strong > expect.max_strong) {
      problems.push(`${strong} strong ratings, expected <= ${expect.max_strong}`);
    }
    if ((payload.citations_dropped ?? 0) > (expect.max_dropped_citations ?? 0)) {
      problems.push(`${payload.citations_dropped} citations dropped as unresolvable`);
    }
    // Every surviving citation resolved against the live corpus, because
    // `enforceCitations` already dropped the ones that did not -- so this
    // asserts the engine's own check ran rather than re-doing it.
    const uncited = report.requirement_map.filter(
      (entry) => entry.strength !== 'none' && entry.evidence.length === 0,
    );
    if (uncited.length > 0) problems.push(`${uncited.length} rated requirements carry no evidence`);

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
async function ask(question, token) {
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
    else if (name === 'error') error = data.code;
  }
  return { sources, answer, cited, error };
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
  const answer = await rpc(
    'tools/call',
    { name: 'judge_answer', arguments: { criteria, subject } },
    token,
  );
  if (answer.error || answer.result?.isError) return null;
  try {
    return JSON.parse(answer.result.content[0].text);
  } catch {
    return null;
  }
}

/** Which `[n]` markers in an answer name a source that does not exist. */
const invalidCitations = (answer, sourceCount) => {
  const invalid = new Set();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (n < 1 || n > sourceCount) invalid.add(n);
  }
  return [...invalid];
};

async function runChat() {
  const token = process.env.RLME_EVAL_TOKEN;
  if (!token) {
    process.stderr.write(`SKIP chat: ${CHAT_SKIP_REASON}\n`);
    return null;
  }

  const results = [];
  for (const testCase of load('chat')) {
    const expect = testCase.expect ?? {};
    const { sources, answer, cited, error } = await ask(testCase.question, token);
    const problems = [];

    if (error !== null) problems.push(`the endpoint refused with "${error}"`);
    if (expect.min_sources !== undefined && sources.length < expect.min_sources) {
      problems.push(`retrieved ${sources.length} sources, expected at least ${expect.min_sources}`);
    }
    if (expect.min_cited !== undefined && cited.length < expect.min_cited) {
      problems.push(`cited ${cited.length} sources, expected at least ${expect.min_cited}`);
    }
    const invalid = invalidCitations(answer, sources.length);
    if (
      expect.max_invalid_citations !== undefined &&
      invalid.length > expect.max_invalid_citations
    ) {
      problems.push(`cited ${invalid.length} source(s) that do not exist: ${invalid.join(', ')}`);
    }
    for (const banned of expect.banned_substrings ?? []) {
      if (answer.includes(banned)) problems.push(`the answer contains "${banned}"`);
    }

    // The judge runs LAST and only on an answer that survived the deterministic
    // checks. Scoring an answer we already know is wrong spends a model call to
    // learn nothing.
    if (problems.length === 0 && expect.judge) {
      const verdict = await askJudge(expect.judge.criteria, answer, token);
      if (verdict === null) problems.push('the judge did not run');
      else if (verdict.verdict !== 'pass') {
        problems.push(`judge: ${verdict.reasons.join('; ')} (score ${verdict.score})`);
      }
    }

    results.push(
      problems.length === 0
        ? pass(testCase.id, testCase.local)
        : fail(testCase.id, problems.join('; '), testCase.local),
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
    const banned = (testCase.banned_patterns ?? []).map((source) => new RegExp(source, 'i'));
    for (const [index, question] of (testCase.questions ?? []).entries()) {
      const id = `${testCase.id}[${index}]`;
      const { answer, error } = await ask(question, token);
      const problems = [];

      if (error !== null) problems.push(`the endpoint refused with "${error}"`);
      for (const pattern of banned) {
        if (pattern.test(answer)) problems.push(`the answer matches ${pattern}`);
      }
      if (problems.length === 0 && testCase.judge) {
        const verdict = await askJudge(testCase.judge.criteria, answer, token);
        if (verdict === null) problems.push('the judge did not run');
        else if (verdict.verdict !== 'pass') {
          problems.push(`judge: ${verdict.reasons.join('; ')} (score ${verdict.score})`);
        }
      }

      results.push(
        problems.length === 0
          ? pass(id, testCase.local)
          : fail(id, `"${question}" -- ${problems.join('; ')}`, testCase.local),
      );
    }
  }
  return results;
}

function report(suite, results) {
  const passed = results.filter((r) => r.ok).length;
  for (const result of results) {
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${suite}/${result.id} ${result.notes}\n`);
  }
  process.stdout.write(`${suite}: ${passed}/${results.length}\n`);

  if (record) {
    const localCount = results.filter((r) => r.local).length;
    if (localCount > 0) {
      process.stdout.write(
        `${suite}: ${localCount} local case(s) redacted from the remote eval_runs row\n`,
      );
    }
    // A `local` case (README: an owner's real, ungitignored description) may
    // carry its actual id and model-derived failure text -- exactly what the
    // no-real-campaign-data rule exists to keep out of anything that isn't
    // this operator's own terminal. `eval_runs` is remote, so a local case
    // contributes to the counts below (a number leaks nothing) and nothing
    // else: its id and notes never leave this process.
    const notes = results
      .filter((r) => !r.ok)
      .map((r) => (r.local ? '<local case, redacted>' : `${r.id}: ${r.notes}`))
      // Truncate the RAW string first, then escape: escaping first can leave
      // a cut land inside a doubled `''` pair, dropping one of the two quotes
      // and unterminating the SQL literal that follows.
      .join(' | ')
      .slice(0, 900)
      .replace(/'/g, "''");
    const sql = `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed, notes)
       VALUES ('${new Date().toISOString()}', '${suite}', NULL, ${results.length}, ${passed},
               ${results.length - passed}, '${notes}')`;
    execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--command', sql], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    });
  }
  return passed === results.length;
}

// `skipped` is what makes a run that proves less than it looks like
// impossible to mistake for a clean one: a suite that could not run must
// show up in the stdout summary (not only stderr, which a redirected log
// drops) and must move the exit code off 0, even when every suite that DID
// run passed outright.
const skipped = [];

let green = true;
if (only === null || only === 'tier') green = report('tier', await runTier()) && green;
if (only === null || only === 'fit') {
  const results = await runFit();
  if (results === null) {
    skipped.push('fit');
    // Same wording as runFit()'s own stderr line -- one message, printed on
    // both streams so it survives a `2>/dev/null` as readily as a `>log`.
    process.stdout.write(`SKIP fit: ${FIT_SKIP_REASON}\n`);
    process.stdout.write('fit: skipped\n');
  } else {
    green = report('fit', results) && green;
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
    green = report(name, results) && green;
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
