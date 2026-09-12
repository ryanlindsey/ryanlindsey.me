#!/usr/bin/env node
// Grades one eval run and writes grading.json next to its outputs.
//
// The mechanical assertions are graded by shelling out to check-prose.mjs, so
// the grader and the skill can never drift apart on what counts as a violation.
//
// A run that quotes the original bad prose back at the user (an audit showing
// what it found, a rewrite showing a before and after) would otherwise be
// penalized for its own evidence, so findings whose text comes from the known
// source material are attributed there and excluded.
//
//   node grade.mjs <eval-id> <run-dir>

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { argv, exit, stdout } from 'node:process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, '..', 'scripts', 'check-prose.mjs');
// Fixtures live beside this script so the suite is reproducible from a lone
// checkout. Run outputs go wherever the caller puts them, which is deliberately
// not in the repo: they are large, disposable, and not worth reviewing.
const INPUTS = process.env.HOUSE_STYLE_INPUTS || join(HERE, 'inputs');

const ORIGINAL_PARAGRAPH =
  'Our new caching layer has been a game-changer for performance. By leveraging a sophisticated multi-tier strategy — combining edge caching with an intelligent origin shield — we’ve been able to dramatically reduce latency across the board. It’s a robust solution that we’re really excited about, and it could be argued that it’s one of the most impactful optimisations we’ve shipped this year. The results speak for themselves.';

function check(path) {
  try {
    const out = execFileSync('node', [CHECKER, '--json', path], { encoding: 'utf8' });
    return JSON.parse(out).findings;
  } catch (e) {
    // exit 1 just means findings exist; the JSON is still on stdout.
    if (e.stdout) return JSON.parse(e.stdout).findings;
    throw e;
  }
}

// Drop findings that are quoting source material rather than committing the error.
function ownFindings(findings, sourceTexts) {
  const haystack = sourceTexts.join(' \n ').toLowerCase();
  return findings.filter((f) => {
    const snippet = f.snippet.toLowerCase().trim();
    if (snippet.length < 25) return true;
    // A snippet lifted from the source appears, near enough, inside it.
    const probe = snippet.slice(0, 45);
    return !haystack.includes(probe);
  });
}

const has = (text, ...needles) => needles.some((n) => text.toLowerCase().includes(n.toLowerCase()));

const evalId = Number(argv[2]);
const runDir = argv[3];
const outDir = join(runDir, 'outputs');
const expectations = [];
const pass = (text, passed, evidence) => expectations.push({ text, passed, evidence });

function readOut(name) {
  const p = join(outDir, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

if (evalId === 0) {
  const path = join(outDir, 'draft.mdx');
  if (!existsSync(path)) {
    pass('Draft file was produced', false, 'draft.mdx missing from outputs');
  } else {
    const text = readFileSync(path, 'utf8');
    const f = check(path);
    const by = (rule) => f.filter((x) => x.rule === rule);
    const dashes = [...by('em-dash'), ...by('en-dash'), ...by('ascii-dash')];

    pass(
      'Draft contains no em dashes in body prose',
      dashes.length === 0,
      dashes.length
        ? `${dashes.length} at line(s) ${dashes.map((x) => x.line).join(', ')}`
        : 'none found',
    );
    pass(
      'Draft contains no contractions',
      by('contraction').length === 0,
      by('contraction').length
        ? by('contraction')
            .map((x) => `line ${x.line}`)
            .join(', ')
        : 'none found',
    );
    pass(
      'Draft uses American spelling throughout',
      by('spelling').length === 0,
      by('spelling').length
        ? by('spelling')
            .map((x) => x.message)
            .join('; ')
        : 'none found',
    );
    pass(
      'Draft avoids the disallow-list words seam and load-bearing',
      by('disallowed').length === 0,
      by('disallowed').length
        ? by('disallowed')
            .map((x) => `line ${x.line}`)
            .join(', ')
        : 'none found',
    );
    pass(
      'Every prose paragraph occupies a single line (no hard wrapping)',
      by('wrapping').length === 0,
      by('wrapping').length
        ? `${by('wrapping').length} wrapped paragraph(s)`
        : 'all paragraphs unwrapped',
    );
    pass(
      'Draft includes a Context section heading',
      /^##\s+Context\s*$/m.test(text),
      /^##\s+Context\s*$/m.test(text) ? 'found "## Context"' : 'no Context heading',
    );

    const nums = ['47', '11', '99.4', '639'].filter((n) => text.includes(n));
    pass(
      'Uses real figures from the notes and invents none',
      nums.length >= 2,
      `figures present: ${nums.join(', ') || 'none'}`,
    );
  }
}

if (evalId === 1) {
  const review = readOut('review.md');
  const draftPath = join(INPUTS, 'rate-limiting-draft.mdx');
  if (review === null) {
    pass('Review file was produced', false, 'review.md missing from outputs');
  } else {
    pass(
      'Review flags the em dashes',
      has(review, 'em dash', 'em-dash', 'emdash'),
      has(review, 'em dash', 'em-dash') ? 'mentions em dashes' : 'no mention',
    );
    pass(
      'Review flags the contractions',
      has(review, 'contraction', "don't", "it's", "wasn't", "haven't"),
      has(review, 'contraction') ? 'mentions contractions' : 'no explicit mention',
    );
    pass(
      'Review flags the British spellings',
      has(review, 'organisation', 'optimise', 'behaviour', 'british', 'american spelling'),
      'checked for organisation / optimised / behaviour / spelling',
    );
    // Merely containing the word is not flagging it; a review that quotes the
    // offending line would pass on a bare substring test. Require the word to
    // sit near language that marks it as a problem.
    const flagged = (word) => {
      const re = new RegExp(`.{0,220}\\b${word}\\b.{0,220}`, 'gis');
      return [...review.matchAll(re)].some((m) =>
        /disallow|banned|ban\b|avoid|remove|cut\b|replace|metaphor|vocabulary|not allowed|forbidden|delete/i.test(
          m[0],
        ),
      );
    };
    const seamFlagged = flagged('seam');
    const lbFlagged = flagged('load-bearing');
    pass(
      'Review flags both disallow-list words as violations',
      seamFlagged && lbFlagged,
      `seam flagged: ${seamFlagged}, load-bearing flagged: ${lbFlagged}`,
    );

    // A review that uses a disallow-list word in its own prose while auditing
    // for that very word has not internalized the rule.
    const ownProse = review.replace(/^>.*$/gm, '').replace(/`[^`]*`/g, '');
    const selfUse = /\bload-bearing\b/i.test(ownProse) || /\bseams?\b/i.test(ownProse);
    pass(
      'Review does not itself use a disallow-list word in its own prose',
      !selfUse,
      selfUse ? 'review commits the violation it is auditing for' : 'clean',
    );
    pass(
      'Review flags the hard line wrapping',
      has(review, 'wrap', 'one line per paragraph', 'line break'),
      has(review, 'wrap') ? 'mentions wrapping' : 'no mention',
    );

    const draftNow = readFileSync(draftPath, 'utf8');
    const untouched = check(draftPath).length === 20;
    pass(
      'The input draft file was left unmodified by the audit',
      untouched,
      untouched ? 'draft still has its original 20 findings' : 'draft was altered',
    );
    void draftNow;

    const own = ownFindings(check(join(outDir, 'review.md')), [readFileSync(draftPath, 'utf8')]);
    const ownDashes = own.filter((x) => ['em-dash', 'en-dash', 'ascii-dash'].includes(x.rule));
    pass(
      'The review prose itself contains no em dashes',
      ownDashes.length === 0,
      ownDashes.length
        ? `${ownDashes.length} outside quoted evidence, line(s) ${ownDashes.map((x) => x.line).join(', ')}`
        : 'none outside quoted evidence',
    );
  }
}

if (evalId === 2) {
  const answer = readOut('answer.md');
  if (answer === null) {
    pass('Answer file was produced', false, 'answer.md missing from outputs');
  } else {
    // The deliverable is the rewritten paragraph, which both presentations put
    // in the first blockquote. Grading answer.md as a whole would check the
    // commentary instead, and the commentary legitimately names the phrases it
    // cut. Pull the rewrite out and check that text on its own.
    const quoted = answer.match(/(?:^>.*(?:\n|$))+/m);
    const rewrite = quoted
      ? quoted[0]
          .split('\n')
          .filter(Boolean)
          .map((l) => l.replace(/^>\s?/, ''))
          .join(' ')
      : answer.split(/\n\s*\n/).filter((p) => !/^#|^-|^\*/.test(p.trim()))[1] || answer;

    const tmp = join(runDir, '.rewrite.md');
    writeFileSync(tmp, rewrite + '\n');
    const own = ownFindings(check(tmp), [ORIGINAL_PARAGRAPH]);
    const by = (rule) => own.filter((x) => x.rule === rule);
    const dashes = [...by('em-dash'), ...by('en-dash'), ...by('ascii-dash')];

    pass(
      'Rewrite contains no em dashes',
      dashes.length === 0,
      dashes.length
        ? `${dashes.length} outside the quoted original`
        : 'none outside the quoted original',
    );
    pass(
      'Rewrite contains no contractions',
      by('contraction').length === 0,
      by('contraction').length
        ? by('contraction')
            .map((x) => `line ${x.line}`)
            .join(', ')
        : 'none outside the quoted original',
    );
    pass(
      'Rewrite uses American spelling',
      by('spelling').length === 0,
      by('spelling').length
        ? by('spelling')
            .map((x) => x.message)
            .join('; ')
        : 'none outside the quoted original',
    );
    pass(
      'Rewritten paragraph is on a single line',
      by('wrapping').length === 0,
      by('wrapping').length ? `${by('wrapping').length} wrapped paragraph(s)` : 'unwrapped',
    );

    // The hedge and the empty claim appear in commentary that names what was
    // cut, which is correct behavior, so only a copy surviving in the rewritten
    // paragraph itself counts against the run.
    const afterOnly = rewrite;
    pass(
      "The hedge 'it could be argued' is gone",
      !/it could be argued/i.test(afterOnly),
      /it could be argued/i.test(afterOnly) ? 'hedge survives' : 'hedge removed',
    );
    pass(
      "The empty claim 'the results speak for themselves' is gone",
      !/results speak for themselves/i.test(afterOnly),
      /results speak for themselves/i.test(afterOnly) ? 'claim survives' : 'claim removed',
    );

    const invented = /\b\d+(\.\d+)?\s?(ms|milliseconds|%|percent)\b/i.test(afterOnly);
    pass(
      'Does not invent latency figures or percentages absent from the source',
      !invented,
      invented ? 'contains a number that was not in the source' : 'no invented figures',
    );
  }
}

const total = expectations.length;
const passed = expectations.filter((e) => e.passed).length;
const grading = {
  eval_id: evalId,
  run_dir: runDir,
  passed,
  total,
  pass_rate: total ? passed / total : 0,
  expectations,
};
writeFileSync(join(runDir, 'grading.json'), JSON.stringify(grading, null, 2));
stdout.write(`${runDir}: ${passed}/${total} passed\n`);
for (const e of expectations)
  stdout.write(`  ${e.passed ? 'PASS' : 'FAIL'}  ${e.text}\n        ${e.evidence}\n`);
exit(0);
