#!/usr/bin/env node
/**
 * Gates the rendered résumé sheet on the properties an extractor depends on
 * (issue #184, epic #180).
 *
 * WHY THIS IS NOT A VITEST SUITE. No test in this repo may reach a browser, and
 * tests/workers.ts enforces that with override variables no deployed config
 * sets. The sheet does not exist until Chrome has drawn it, so nothing inside
 * vitest can assert its page count, its font types, its link annotations or the
 * text an applicant tracking system would read. That gap is not theoretical: it
 * is how an eight-page PDF carrying no email address, no phone number and one
 * hyperlink shipped and then stayed shipped. This script runs outside vitest,
 * after the render, and looks at the artifact itself.
 *
 * WHAT IT DOES NOT RENDER. scripts/resume-sheet.mjs writes
 * tests/fixtures/resume-sheet.pdf and rewrites tests/fixtures/resume-sheet.txt
 * beside it; this file reads both and judges them. Keeping the two apart is
 * what makes the `extraction` check mean anything -- a gate that rendered its
 * own input could only ever compare a render against itself. CI runs them in
 * that order and so must a developer: `npm run resume:pdf && npm run resume:gate`.
 *
 * THERE IS NO OPEN-SOURCE ATS CHECKER WORTH ADDING. Checked on 2026-09-15
 * rather than assumed. The best-known of them, xitanggg/open-resume, is
 * AGPL-3.0 and was last pushed in October 2024; the network clause against a
 * public site is decisive on its own. `resume-parser` on npm was last published
 * in 2022. The category is commercial SaaS. What IS maintained is the set of
 * tools that check the properties extraction actually depends on, so this file
 * asserts named properties instead of reporting a score. Every line of a named
 * property can be defended; a score cannot.
 */
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { extractText, getDocumentProxy } from 'unpdf';

const root = new URL('../', import.meta.url);

const PDF = new URL('tests/fixtures/resume-sheet.pdf', root);

/**
 * Repo-relative rather than a URL, because every use of it below is an argument
 * to git, which resolves pathspecs against the repository and not against the
 * process's working directory.
 */
const GOLDEN = 'tests/fixtures/resume-sheet.txt';

/** The file holding RESUME_PDF_CONTRACT_VERSION. See the `contract` check. */
const CONTRACT_SOURCE = 'src/lib/resume-pdf.ts';

const RESUME_YAML = new URL('src/content/resume/ryan-lindsey.yaml', root);

/** Three sheets is the epic's target and the number the current design holds. */
const MAX_PAGES = 3;

/**
 * The check that would have caught page eight. The frozen file ran 1,346 words
 * over eight sheets and finished with 74 words on page seven and 11 on page
 * eight, which is the signature of a sheet that overflowed rather than one that
 * was laid out. 200 is set well below the ~580 the three-page design actually
 * carries, because this is a floor against a broken render and not a target to
 * hit: a page that drops under it is holding a widow, not content.
 */
const MIN_WORDS_PER_PAGE = 200;

/**
 * Chrome renders the running head and foot in a SEPARATE document that cannot
 * see the page's fonts, and that document contributes one Times-Roman to the
 * font list no matter what the template asks for (measured for #183, and the
 * reason the foot inlines its own face as a data URL). It is invisible on the
 * sheet. So the face is allowed through by name rather than failing the run --
 * but only this one name, and Type 3 is refused even here.
 */
const FOOTER_FACE = /Times-Roman$/;

/* -------------------------------------------------------------------------- *
 * Shelling out
 * -------------------------------------------------------------------------- */

/**
 * poppler and git both report failure through the exit code, and both write the
 * useful half of the message to stderr. Folding that into the thrown Error
 * keeps a missing binary or an unfetched base ref readable in a CI log rather
 * than surfacing as a bare "Command failed".
 */
function run(command, arguments_) {
  try {
    return execFileSync(command, arguments_, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `\`${command}\` is not installed. CI installs poppler-utils; see checks.yml.`,
      );
    }
    const detail = `${error.stderr ?? ''}`.trim() || `exit ${error.status}`;
    throw new Error(`\`${command} ${arguments_.join(' ')}\` failed: ${detail}`);
  }
}

/** git, but a non-zero exit is an answer rather than an error. Used for diffs. */
function gitSucceeds(arguments_) {
  try {
    execFileSync('git', arguments_, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- *
 * Reading the artifact
 * -------------------------------------------------------------------------- */

/**
 * pdffonts prints a fixed-width table whose `type` column holds values with
 * spaces in them ("CID TrueType"), so splitting on whitespace mangles it. The
 * rule of dashes under the header states every column's width exactly; using it
 * to cut the rows is the difference between parsing the output and guessing at
 * it.
 */
function readFonts(path) {
  const lines = run('pdffonts', [path]).split('\n');
  const rule = lines.findIndex((line) => /^-+ /.test(line));
  if (rule === -1) throw new Error('pdffonts printed no table');

  const spans = [];
  for (const match of lines[rule].matchAll(/-+/g)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  const headers = spans.map(([from, to]) => lines[rule - 1].slice(from, to).trim());

  return lines
    .slice(rule + 1)
    .filter((line) => line.trim())
    .map((line) =>
      Object.fromEntries(
        spans.map(([from, to], index) => [headers[index], line.slice(from, to).trim()]),
      ),
    );
}

/** `pdfinfo` as a lookup. Values are left as strings; every caller wants one. */
function readInfo(path) {
  return Object.fromEntries(
    run('pdfinfo', [path])
      .split('\n')
      .filter((line) => line.includes(':'))
      .map((line) => [
        line.slice(0, line.indexOf(':')).trim(),
        line.slice(line.indexOf(':') + 1).trim(),
      ]),
  );
}

/**
 * Page text and link annotations, read through unpdf so the gate needs no
 * system dependency for the two checks that are about content rather than
 * structure. poppler is still what answers for fonts and the tag flag.
 */
async function readDocument(bytes) {
  // getDocumentProxy is handed a copy: pdf.js transfers the buffer it is given.
  const document_ = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(document_, { mergePages: false });

  const links = [];
  for (let number = 1; number <= document_.numPages; number += 1) {
    const page = await document_.getPage(number);
    for (const annotation of await page.getAnnotations()) {
      if (annotation.subtype === 'Link' && (annotation.url ?? annotation.unsafeUrl)) {
        links.push(annotation.url ?? annotation.unsafeUrl);
      }
    }
  }

  return { totalPages, pages: text, links };
}

/* -------------------------------------------------------------------------- *
 * What the résumé record says the sheet must carry
 * -------------------------------------------------------------------------- */

/**
 * Derived from the YAML rather than from a literal list, which is the point.
 * A hand-written expectation agrees with whatever it was copied from, so it
 * cannot notice a profile the record gained and the sheet did not.
 *
 * Read with `yaml` rather than through astro:content, for the reason
 * scripts/resume-sheet.mjs gives at more length: the virtual module does not
 * resolve in a plain node process, and `astro build` has already validated this
 * file against resumeSchema by the time anything here runs.
 */
async function expectations() {
  const resume = parse(await readFile(RESUME_YAML, 'utf8'));
  const { email, phone, url, profiles = [] } = resume.basics;

  return {
    /* What must appear in the text layer. The sheet prints URLs in display
     * form, so these are compared after the same trimming -- see displayForm(). */
    fields: [
      ['email', email],
      ['phone', phone],
      ['url', url],
      ...profiles.map((profile) => [`profile:${profile.network}`, profile.url]),
    ],
    /* What must be reachable. mailto: and tel: are built the way
     * src/pages/resume.print.astro builds them; the rest are URLs as authored. */
    links: [
      `mailto:${email}`,
      `tel:+1${phone.replace(/\D/g, '')}`,
      url,
      ...profiles.map((profile) => profile.url),
      ...(resume.projects ?? []).map((project) => project.url).filter(Boolean),
    ],
  };
}

/**
 * The sheet prints `github.com/ryanlindsey`, not `https://github.com/ryanlindsey`,
 * and Chrome writes the annotation back with a trailing slash the YAML does not
 * have. Both comparisons run through here so neither has to care.
 */
function displayForm(value) {
  return value
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

/* -------------------------------------------------------------------------- *
 * The checks
 * -------------------------------------------------------------------------- */

/**
 * The golden is regenerated by the render and committed to the repository, so
 * "does a fresh render still say what the repository claims it says" is exactly
 * `git diff`. Nothing here re-derives the text: a second copy of the formatting
 * in scripts/resume-sheet.mjs would be a second source of truth, and the two
 * would drift on the first edit to either.
 *
 * This is why the check reads as a diff for a reviewer. A sheet that still
 * renders but has lost its contact block shows up here and nowhere else.
 */
function checkExtraction() {
  // Against HEAD rather than the index, so a staged edit cannot hide.
  if (gitSucceeds(['diff', '--quiet', 'HEAD', '--', GOLDEN])) {
    const lines = run('git', ['show', `HEAD:${GOLDEN}`]).split('\n').length;
    return { ok: true, detail: `fresh render matches the committed golden, ${lines} lines` };
  }
  const diff = run('git', ['diff', '--stat', 'HEAD', '--', GOLDEN]).trim();
  return {
    ok: false,
    detail: `the committed golden is not what this tree renders (${diff})\n${run('git', ['diff', 'HEAD', '--', GOLDEN])}`,
  };
}

function checkFields(expected, pages) {
  // One string, whitespace flattened: a field may straddle a line break, and
  // letter-spaced runs extract with a space between every character.
  const haystack = displayForm(pages.join(' ').replace(/\s+/g, ' '));
  const missing = expected.filter(([, value]) => !haystack.includes(displayForm(value)));

  return missing.length === 0
    ? { ok: true, detail: `${expected.length} of ${expected.length} present` }
    : {
        ok: false,
        detail: `missing from the text layer: ${missing.map(([name, value]) => `${name} (${value})`).join(', ')}`,
      };
}

function checkFonts(fonts) {
  const type3 = fonts.filter((font) => font.type === 'Type 3');
  const unembedded = fonts.filter((font) => font.emb !== 'yes' && !FOOTER_FACE.test(font.name));

  if (type3.length > 0) {
    // Named because the cause is always the same: a variable font. Chrome
    // rasterises those into Type 3, which has no text an extractor can read.
    return {
      ok: false,
      detail: `Type 3 face, which extracts as nothing: ${type3.map((font) => font.name).join(', ')}. A variable @fontsource import is the usual cause; the sheet must use the static packages.`,
    };
  }
  if (unembedded.length > 0) {
    return { ok: false, detail: `not embedded: ${unembedded.map((font) => font.name).join(', ')}` };
  }
  return { ok: true, detail: `${fonts.length} faces, every one embedded, no Type 3` };
}

function checkPages(totalPages, pages) {
  const counts = pages.map((page) => page.split(/\s+/).filter(Boolean).length);
  const thin = counts
    .map((count, index) => [index + 1, count])
    .filter(([, count]) => count < MIN_WORDS_PER_PAGE);

  if (totalPages > MAX_PAGES) {
    return { ok: false, detail: `${totalPages} pages, over the ${MAX_PAGES} the design holds` };
  }
  if (thin.length > 0) {
    return {
      ok: false,
      detail: `under ${MIN_WORDS_PER_PAGE} words: ${thin.map(([page, count]) => `page ${page} (${count})`).join(', ')}`,
    };
  }
  return { ok: true, detail: `${totalPages} pages, ${counts.join(' / ')} words` };
}

function checkLinks(expected, found) {
  const have = new Set(found.map(displayForm));
  const missing = expected.filter((link) => !have.has(displayForm(link)));

  return missing.length === 0
    ? { ok: true, detail: `${found.length} annotations, covering all ${expected.length} required` }
    : { ok: false, detail: `no link annotation for: ${missing.join(', ')}` };
}

function checkTagged(info) {
  return info.Tagged === 'yes'
    ? { ok: true, detail: 'pdfinfo reports Tagged: yes' }
    : { ok: false, detail: `pdfinfo reports Tagged: ${info.Tagged ?? '(absent)'}` };
}

/**
 * THE STALE-RENDER BUG IN A NEW COSTUME. The hash that decides whether to
 * republish covers the YAML and RESUME_PDF_CONTRACT_VERSION, and nothing else.
 * The sheet's own source -- its route, its stylesheet, the fonts it imports --
 * is not in it. So an edit to the stylesheet moves the output without moving
 * the hash, the publish step reads a hash it has already seen, skips the
 * upload, and /resume.pdf goes on serving bytes nobody can reproduce. That is
 * the failure this epic exists to fix, arriving through a different door.
 *
 * The golden is the evidence the output moved. The constant is the thing that
 * has to move with it. So: a pull request that changes one and not the other
 * fails here.
 *
 * Only a pull request has a base to diff against, so this is the one check that
 * can report `skip`. It is skipped loudly rather than silently, because a guard
 * that quietly does nothing is worse than no guard.
 */
function checkContract() {
  const base = process.env.GITHUB_BASE_REF;
  if (!base) return { skip: true, detail: 'not a pull request, nothing to diff against' };

  const ref = ['origin/' + base, base].find((spelling) =>
    gitSucceeds(['rev-parse', '--verify', spelling]),
  );
  if (!ref) {
    return {
      ok: false,
      detail: `base ref \`${base}\` is not in this clone. The checkout needs fetch-depth: 0.`,
    };
  }

  const mergeBase = run('git', ['merge-base', ref, 'HEAD']).trim();
  const goldenMoved = !gitSucceeds(['diff', '--quiet', mergeBase, 'HEAD', '--', GOLDEN]);
  if (!goldenMoved) return { ok: true, detail: 'the golden is unchanged on this branch' };

  const version = (source) => source.match(/RESUME_PDF_CONTRACT_VERSION\s*=\s*(\d+)/)?.[1];
  const before = version(run('git', ['show', `${mergeBase}:${CONTRACT_SOURCE}`]));
  const after = version(run('git', ['show', `HEAD:${CONTRACT_SOURCE}`]));

  if (!before || !after) {
    return {
      ok: false,
      detail: `could not read RESUME_PDF_CONTRACT_VERSION from ${CONTRACT_SOURCE}`,
    };
  }
  return before === after
    ? {
        ok: false,
        detail: `the golden changed and RESUME_PDF_CONTRACT_VERSION did not (still ${after}). The deployed manifest would keep pointing at the old bytes. Bump it in ${CONTRACT_SOURCE}.`,
      }
    : { ok: true, detail: `golden changed and the contract moved ${before} -> ${after}` };
}

/* -------------------------------------------------------------------------- *
 * Main
 * -------------------------------------------------------------------------- */

async function main() {
  const path = fileURLToPath(PDF);
  try {
    await stat(path);
  } catch {
    throw new Error(`${path} is not there. Render it first: \`npm run resume:pdf\`.`);
  }

  const bytes = await readFile(PDF);
  const [expected, document_] = await Promise.all([expectations(), readDocument(bytes)]);
  const { totalPages, pages, links } = document_;

  const results = [
    ['extraction', checkExtraction()],
    ['fields', checkFields(expected.fields, pages)],
    ['fonts', checkFonts(readFonts(path))],
    ['pages', checkPages(totalPages, pages)],
    ['links', checkLinks(expected.links, links)],
    ['tagged', checkTagged(readInfo(path))],
    ['contract', checkContract()],
  ];

  // One named line per check, whatever the outcome. A gate that prints only its
  // failures leaves a reader unable to tell a pass from a check that never ran.
  for (const [name, result] of results) {
    const mark = result.skip ? 'skip' : result.ok ? 'ok  ' : 'FAIL';
    console.log(`${mark}  ${name.padEnd(11)}${result.detail}`);
  }

  const failed = results.filter(([, result]) => !result.skip && !result.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${results.length} checks failed.`);
    process.exitCode = 1;
  }
}

await main();
