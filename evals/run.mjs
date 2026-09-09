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
  const payload =
    text.startsWith('event:') || text.startsWith('data:')
      ? text
          .split('\n')
          .find((line) => line.startsWith('data:'))
          .slice(5)
          .trim()
      : text;
  return JSON.parse(payload);
}

const load = (suite) =>
  readdirSync(join(CASES, suite))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(CASES, suite, name), 'utf8')));

/** One case's outcome. `notes` is what an operator reads when it fails. */
const pass = (id) => ({ id, ok: true, notes: '' });
const fail = (id, notes) => ({ id, ok: false, notes });

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
      problems.length === 0 ? pass(testCase.id) : fail(testCase.id, problems.join('; ')),
    );
  }
  return results;
}

async function runFit() {
  const token = process.env.RLME_EVAL_TOKEN;
  if (!token) {
    // Loud, and NOT a pass. A suite that quietly reports success because it
    // could not run is the exact failure this repo keeps writing comments
    // about.
    process.stderr.write('SKIP fit: RLME_EVAL_TOKEN is not set in this shell\n');
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
      results.push(fail(testCase.id, `tool refused: ${answer.result.content?.[0]?.text ?? ''}`));
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(answer.result.content[0].text);
    } catch {
      results.push(fail(testCase.id, 'the tool did not return JSON'));
      continue;
    }

    const parsed = FitReport.safeParse(payload.report);
    if (!parsed.success) {
      results.push(
        fail(testCase.id, `report failed the schema: ${parsed.error.message.slice(0, 200)}`),
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
      problems.length === 0 ? pass(testCase.id) : fail(testCase.id, problems.join('; ')),
    );
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
    const notes = results
      .filter((r) => !r.ok)
      .map((r) => `${r.id}: ${r.notes}`)
      .join(' | ');
    const sql = `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed, notes)
       VALUES ('${new Date().toISOString()}', '${suite}', NULL, ${results.length}, ${passed},
               ${results.length - passed}, '${notes.replace(/'/g, "''").slice(0, 900)}')`;
    execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--command', sql], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    });
  }
  return passed === results.length;
}

let green = true;
if (only === null || only === 'tier') green = report('tier', await runTier()) && green;
if (only === null || only === 'fit') {
  const results = await runFit();
  if (results !== null) green = report('fit', results) && green;
}
process.exit(green ? 0 : 1);
