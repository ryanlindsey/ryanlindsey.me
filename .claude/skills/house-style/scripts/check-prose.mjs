#!/usr/bin/env node
// House-style checker for prose in src/content/.
//
// Audits the mechanical half of the editorial standards (the canonical statement
// of which is 02 Section 4 in the private docs repo): em dashes, American spelling,
// the vocabulary disallow list, contractions, and hard line wrapping. The
// judgment half -- register, structure, whether a claim earns its sentence --
// is not checkable and is not attempted here.
//
// Auditing never writes. Unwrapping is a separate, explicit mode, because a
// reader running an audit should be able to trust that nothing moved under them.
//
//   node check-prose.mjs src/content/**/*.mdx      audit, exit 1 on findings
//   node check-prose.mjs --json <paths>            same, machine-readable
//   node check-prose.mjs --unwrap <paths>          rewrite to one line per paragraph
//   node check-prose.mjs --unwrap --dry-run <p>    show what unwrapping would change

import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';

// --- Rules -----------------------------------------------------------------

// Banned as metaphors. The test is mechanical: delete the word. If the sentence
// still says the same thing it was filler; if it now says less, the specific
// claim was hiding behind the metaphor, so write that claim instead. The list
// grows by that test, never by taste.
const DISALLOWED = [
  [
    /\bseams?\b/gi,
    'name the actual thing: the interface, the boundary, the authorization check, the one place a decision is made',
  ],
  [/\bload-bearing\b/gi, 'say what depends on it and what breaks without it'],
];

// British forms mapped to the American ones. Mixing conventions reads as text
// assembled from several sources rather than written by one person.
const BRITISH = {
  analogue: 'analog',
  analyse: 'analyze',
  analysed: 'analyzed',
  analyses: 'analyzes',
  analysing: 'analyzing',
  apologise: 'apologize',
  artefact: 'artifact',
  artefacts: 'artifacts',
  behaviour: 'behavior',
  behaviours: 'behaviors',
  cancelled: 'canceled',
  cancelling: 'canceling',
  categorise: 'categorize',
  categorised: 'categorized',
  catalogue: 'catalog',
  centre: 'center',
  centres: 'centers',
  characterise: 'characterize',
  colour: 'color',
  colours: 'colors',
  defence: 'defense',
  emphasise: 'emphasize',
  emphasised: 'emphasized',
  endeavour: 'endeavor',
  favour: 'favor',
  favourite: 'favorite',
  fibre: 'fiber',
  flavour: 'flavor',
  fulfil: 'fulfill',
  generalise: 'generalize',
  generalises: 'generalizes',
  grey: 'gray',
  honour: 'honor',
  humour: 'humor',
  initialise: 'initialize',
  initialised: 'initialized',
  labelled: 'labeled',
  labelling: 'labeling',
  labour: 'labor',
  licence: 'license',
  litre: 'liter',
  manoeuvre: 'maneuver',
  maximise: 'maximize',
  metre: 'meter',
  minimise: 'minimize',
  minimised: 'minimized',
  modelled: 'modeled',
  modelling: 'modeling',
  neighbour: 'neighbor',
  normalise: 'normalize',
  offence: 'offense',
  optimise: 'optimize',
  optimised: 'optimized',
  optimising: 'optimizing',
  organisation: 'organization',
  organisations: 'organizations',
  organise: 'organize',
  organised: 'organized',
  practise: 'practice',
  prioritise: 'prioritize',
  prioritised: 'prioritized',
  programme: 'program',
  realise: 'realize',
  realised: 'realized',
  recognise: 'recognize',
  recognised: 'recognized',
  rumour: 'rumor',
  sceptical: 'skeptical',
  serialise: 'serialize',
  specialise: 'specialize',
  standardise: 'standardize',
  summarise: 'summarize',
  summarised: 'summarized',
  theatre: 'theater',
  travelled: 'traveled',
  travelling: 'traveling',
  utilise: 'utilize',
  visualise: 'visualize',
  whilst: 'while',
  acknowledgement: 'acknowledgment',
  judgement: 'judgment',
};
const BRITISH_RE = new RegExp(`\\b(${Object.keys(BRITISH).join('|')})\\b`, 'gi');

// The -isation family is open-ended (optimisation, prioritisation, realisation,
// normalisation, ...), so enumerating it would always lag the prose. No common
// English word ends in -isation without being the British variant, which makes
// the general pattern safe here in a way that -ise and -ised are not: those
// collide with advertised, supervised, surprised, promised and a dozen more.
const ISATION_RE = /\b[a-z]{3,}isations?\b|\b[a-z]{3,}isational\b/gi;

// Published prose does not use contractions. The one exception is the fixed
// case-study heading "What I'd do differently", and headings are skipped wholesale.
const CONTRACTION_RE =
  /\b(\w+n['’]t|(?:I|you|we|they|it|he|she|that|there|here|what|who|let)['’](?:s|re|ve|ll|d|m))\b/gi;

// --- Line classification ---------------------------------------------------

const RE = {
  blank: /^\s*$/,
  heading: /^\s{0,3}#{1,6}\s/,
  table: /^\s*\|/,
  rule: /^\s{0,3}(?:[-*_]\s*){3,}$/,
  list: /^(\s*(?:[-*+]|\d+[.)])\s+)/,
  quote: /^(\s*>\s?)/,
  markup: /^\s*<\/?[A-Za-z!/]/,
  linkDef: /^\s*\[[^\]]+\]:\s/,
  fence: /^(\s*)(`{3,}|~{3,})(.*)$/,
  hardBreak: /(?:\s\s|\\)$/,
  indentedCode: /^ {4,}\S/,
};

// Replace inline code, link targets and bare URLs with spaces so the text
// checks never fire on an identifier or a href, while columns stay accurate.
function maskNonProse(line) {
  const blank = (m) => ' '.repeat(m.length);
  return line
    .replace(/`[^`]*`/g, blank)
    .replace(/\]\([^)]*\)/g, blank)
    .replace(/<https?:\/\/[^>]*>/g, blank)
    .replace(/https?:\/\/\S+/g, blank);
}

// Walk a file once, handing each line to a visitor with enough context to know
// whether it is prose. Shared by the audit and the unwrapper so the two can
// never disagree about what counts as a paragraph.
function walk(text, visit) {
  const lines = text.split('\n');
  let i = 0;
  let inFrontmatter = false;

  if (lines[0] === '---') {
    inFrontmatter = true;
    visit({ line: lines[0], no: 1, kind: 'frontmatter' });
    for (i = 1; i < lines.length; i++) {
      visit({ line: lines[i], no: i + 1, kind: 'frontmatter' });
      if (lines[i] === '---') {
        i++;
        break;
      }
    }
    inFrontmatter = false;
  }

  let fence = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const no = i + 1;
    const f = line.match(RE.fence);

    if (fence) {
      visit({ line, no, kind: 'code' });
      if (f && f[2][0] === fence[0] && f[2].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[2];
      visit({ line, no, kind: 'code' });
      continue;
    }

    let kind = 'prose';
    if (RE.blank.test(line)) kind = 'blank';
    else if (RE.heading.test(line)) kind = 'heading';
    else if (RE.rule.test(line)) kind = 'rule';
    else if (RE.table.test(line)) kind = 'table';
    else if (RE.quote.test(line)) kind = 'quote';
    else if (RE.list.test(line)) kind = 'list';
    else if (RE.markup.test(line)) kind = 'markup';
    else if (RE.linkDef.test(line)) kind = 'linkDef';
    else if (RE.indentedCode.test(line)) kind = 'code';

    visit({ line, no, kind });
  }
  void inFrontmatter;
}

// --- Audit -----------------------------------------------------------------

function audit(path, text) {
  const findings = [];
  const add = (no, col, rule, message, snippet) =>
    findings.push({ path, line: no, col, rule, message, snippet });

  // Wrapping is tracked per paragraph rather than per line break, so a
  // six-line paragraph is one finding to fix and not five to wade through.
  let para = null;
  const closePara = () => {
    if (para && para.lines > 1)
      add(
        para.no,
        1,
        'wrapping',
        `paragraph is hard-wrapped across ${para.lines} lines; join it into one line`,
        para.snippet,
      );
    para = null;
  };

  walk(text, ({ line, no, kind }) => {
    // Verbatim quotations and table cells are left alone; a quotation's line
    // breaks may well be the source's own.
    if (kind === 'prose' || kind === 'list') {
      const continues = para && kind === 'prose' && !RE.hardBreak.test(para.last);
      if (continues) {
        para.lines++;
        para.last = line;
      } else {
        closePara();
        para = { no, lines: 1, last: line, snippet: line.trim().slice(0, 72) };
      }
    } else {
      closePara();
    }

    // Text checks skip code, frontmatter, tables and verbatim quotations
    // (Section 4 exempts quotations from the punctuation, spelling and
    // vocabulary rules, since they are the source's words and not ours).
    if (kind === 'code' || kind === 'frontmatter' || kind === 'quote' || kind === 'table') return;

    const masked = maskNonProse(line);

    for (const m of masked.matchAll(/—/g))
      add(
        no,
        m.index + 1,
        'em-dash',
        'em dash: use a comma pair for an appositive, a colon for a definition or payoff, a semicolon for two joined independent clauses, or a full stop',
        line.trim().slice(0, 72),
      );

    for (const m of masked.matchAll(/ – /g))
      add(
        no,
        m.index + 1,
        'en-dash',
        'spaced en dash is an em dash in disguise; use the replacements above (an unspaced en dash in a number range is fine)',
        line.trim().slice(0, 72),
      );

    for (const m of masked.matchAll(/(?<=\S) -- (?=\S)/g))
      add(
        no,
        m.index + 1,
        'ascii-dash',
        'double hyphen reads as an em dash; use the replacements above',
        line.trim().slice(0, 72),
      );

    for (const [re, advice] of DISALLOWED)
      for (const m of masked.matchAll(re))
        add(
          no,
          m.index + 1,
          'disallowed',
          `"${m[0]}" is on the disallow list: ${advice}`,
          line.trim().slice(0, 72),
        );

    const spelled = new Set(); // a word caught by both rules is still one error
    for (const m of masked.matchAll(BRITISH_RE)) {
      const fix = BRITISH[m[0].toLowerCase()];
      spelled.add(m.index);
      add(
        no,
        m.index + 1,
        'spelling',
        `British spelling "${m[0]}"; American English throughout, so "${fix}"`,
        line.trim().slice(0, 72),
      );
    }
    for (const m of masked.matchAll(ISATION_RE)) {
      if (spelled.has(m.index)) continue;
      add(
        no,
        m.index + 1,
        'spelling',
        `British spelling "${m[0]}"; American English throughout, so "${m[0].replace(/isation/i, 'ization')}"`,
        line.trim().slice(0, 72),
      );
    }

    // "What I'd do differently" is a fixed case-study heading and a term of art
    // in this corpus, so it is exempt wherever it appears, not only as a heading.
    const forContractions = masked.replace(/What I['’]d do differently/gi, (m) =>
      ' '.repeat(m.length),
    );

    if (kind !== 'heading')
      for (const m of forContractions.matchAll(CONTRACTION_RE))
        add(
          no,
          m.index + 1,
          'contraction',
          `"${m[0]}" is a contraction; published prose writes these out`,
          line.trim().slice(0, 72),
        );
  });

  closePara(); // a file ending mid-paragraph still gets its finding
  findings.sort((a, b) => a.line - b.line || a.col - b.col);
  return findings;
}

// --- Unwrap ----------------------------------------------------------------

// Join every hard-wrapped paragraph, list item and blockquote into one line.
// Code, tables, frontmatter, headings and markup blocks are copied byte for
// byte, and an explicit markdown hard break is honored rather than swallowed.
function unwrap(text) {
  const out = [];
  let buf = null;

  const flush = () => {
    if (buf) out.push(buf.prefix + buf.parts.join(' '));
    buf = null;
  };

  walk(text, ({ line, kind }) => {
    if (kind === 'prose' || kind === 'list' || kind === 'quote') {
      // An explicit markdown hard break is a break the author asked for, so the
      // trailing marker survives and the paragraph closes right after it.
      const hardBreak = RE.hardBreak.test(line);
      const body = (s) => (hardBreak ? s.replace(/^\s+/, '') : s.trim());

      if (buf && kind === 'prose') {
        buf.parts.push(body(line));
        if (hardBreak) flush();
        return;
      }

      flush();
      if (kind === 'list') {
        const [, marker] = line.match(RE.list);
        buf = { prefix: marker, parts: [body(line.slice(marker.length))] };
      } else if (kind === 'quote') {
        const [, marker] = line.match(RE.quote);
        buf = { prefix: marker, parts: [body(line.slice(marker.length))] };
      } else {
        buf = { prefix: line.match(/^\s*/)[0], parts: [body(line)] };
      }
      if (hardBreak) flush();
      return;
    }

    flush();
    out.push(line);
  });

  flush();
  return out.join('\n');
}

// --- CLI -------------------------------------------------------------------

const args = argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const paths = args.filter((a) => !a.startsWith('--'));

if (paths.length === 0) {
  stdout.write('usage: check-prose.mjs [--json] [--unwrap [--dry-run]] <paths...>\n');
  exit(2);
}

if (flags.has('--unwrap')) {
  let changed = 0;
  for (const path of paths) {
    const before = readFileSync(path, 'utf8');
    const after = unwrap(before);
    if (before === after) continue;
    changed++;
    const lost = before.split('\n').length - after.split('\n').length;
    stdout.write(
      `${flags.has('--dry-run') ? 'would unwrap' : 'unwrapped'} ${path} (${lost} line breaks joined)\n`,
    );
    if (!flags.has('--dry-run')) writeFileSync(path, after);
  }
  stdout.write(
    `${changed} of ${paths.length} file(s) ${flags.has('--dry-run') ? 'would change' : 'changed'}\n`,
  );
  exit(0);
}

const all = paths.flatMap((path) => audit(path, readFileSync(path, 'utf8')));

if (flags.has('--json')) {
  stdout.write(JSON.stringify({ findings: all, count: all.length }, null, 2) + '\n');
  exit(all.length ? 1 : 0);
}

if (all.length === 0) {
  stdout.write(`clean: ${paths.length} file(s), no house-style findings\n`);
  exit(0);
}

const byRule = {};
for (const f of all) {
  byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  stdout.write(`${f.path}:${f.line}:${f.col}  [${f.rule}]  ${f.message}\n    ${f.snippet}\n`);
}
stdout.write(
  `\n${all.length} finding(s): ` +
    Object.entries(byRule)
      .map(([r, n]) => `${r} ${n}`)
      .join(', ') +
    '\n',
);
exit(1);
