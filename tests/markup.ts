/**
 * Balanced-element extraction for tests that assert against a slice of a
 * rendered page rather than the whole of it.
 *
 * This exists because the obvious spelling is wrong in a way that looks
 * right. Issue #101 specified the mobile overlay's assertions against
 * `/<[^>]*id="rl-mobile-menu"[\s\S]*?<\/(nav|div)>/` -- an opening tag, then a
 * NON-GREEDY run to the first closing `</nav>` or `</div>`. For any markup
 * shaped like design 1c that window ends at the overlay's own 100px header
 * strip, several hundred characters before the first nav link, so four of the
 * six assertions written against it would fail for a reason that has nothing
 * to do with the overlay and one -- `not.toContain('<input')` -- would pass
 * against markup it never looked at. The same trap is already recorded one
 * issue earlier in tests/pages.test.ts, where a character-window around the
 * `⌘K` chip measured the theme toggle beside the search placeholder rather
 * than the placeholder.
 *
 * Counting depth is the fix, and it is only a few lines, so both suites in
 * this repo that need a sub-element share these rather than each growing a
 * slightly different regex.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Astro emits template `<!-- ... -->` comments into the built page, and this
 * codebase writes long ones. A comment mentioning `<div>` would be counted as
 * structure, so every scan below runs on the commentless copy.
 *
 * REPEATED UNTIL IT STOPS CHANGING, rather than a single `.replace`, and the
 * loop is the whole point of this function rather than belt and braces.
 * Removing a comment joins what sat in front of it to what sat behind it, and
 * those two halves can form a comment that was not there before: strip the
 * inner comment out of `<!-<!--x-->-hello-->` and the `<!-` meets the
 * `-hello-->` to make `<!--hello-->`, which one pass then leaves in the
 * "stripped" output. Flagged by CodeQL as
 * js/incomplete-multi-character-sanitization (alert #5) against the first
 * version of this file, and kept honest by tests/markup.test.ts.
 *
 * The rule is filed under security and this use is not: the input is this
 * site's own build output and nothing is rendered from the result. It is a
 * correctness fix. A comment that survives is a comment whose text
 * `elementWith` below then counts as structure, and one stray `<div` inside
 * one throws the depth count off and hands a test the wrong slice of a page --
 * silently, and in the direction that makes assertions pass.
 */
export function stripComments(html: string): string {
  let stripped = html;
  let previous;
  do {
    previous = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, '');
  } while (stripped !== previous);
  return stripped;
}

/**
 * Markup with every tag removed, for comparing a cell's text.
 *
 * THE LOOP IS FOR THE SCANNER, NOT FOR A SEAM THIS PATTERN HAS. CodeQL raised
 * js/incomplete-multi-character-sanitization twice against the single-pass
 * `.replace(/<[^>]*>/g, '')` tests/ops-page.test.ts first shipped with (#431),
 * and it recognizes replace-until-unchanged as complete. Unlike
 * `stripComments`, one pass here cannot glue a new tag together: a match
 * starts at the leftmost `<` and `[^>]*` absorbs any `<` inside it, so
 * `<<b>td>` loses `<<b>` whole and leaves `td>`. An unclosed `<script`
 * survives either way, which is harmless: the input is this site's own build
 * output, and the result is only compared as text. The loop was chosen over
 * dismissing the alerts because a dismissal lives outside the repository.
 */
export function stripTags(html: string): string {
  let stripped = html;
  let previous;
  do {
    previous = stripped;
    stripped = stripped.replace(/<[^>]*>/g, '');
  } while (stripped !== previous);
  return stripped;
}

/**
 * The site header as it was BUILT, for the jsdom suites to drive.
 *
 * A function rather than a module constant so the harness suites that import
 * the extractors above do not read the build output they have no use for.
 *
 * `new URL('../dist/...', import.meta.url)` -- which every harness suite here
 * uses to find a file next to itself -- DOES NOT WORK under jsdom, and the
 * failure reads as a path bug rather than an environment one: the
 * `@vitest-environment jsdom` transform rewrites `import.meta.url` to
 * `self.location`, which is the jsdom document's address (an http:// URL for a
 * page that was never served), so the URL resolves and then `readFileSync`
 * rejects it with "The URL must be of scheme file". The project root is the
 * honest anchor instead; vitest runs with cwd there.
 *
 * `npm test` is `astro build && vitest run`, so the build always exists by the
 * time this runs. A bare `npx vitest run` on a suite that calls this needs
 * `npm run build` first, the same as every harness suite in this directory.
 */
export function builtHeaderMarkup(): string {
  const page = readFileSync(resolve(process.cwd(), 'dist/client/index.html'), 'utf8');
  return elementWith(page, 'header', 'data-site-header');
}

/**
 * The whole `<tag>...</tag>` element carrying `needle`, nesting included.
 *
 * `needle` is expected inside the element's own OPENING tag (an id or a data
 * attribute), which is what makes `lastIndexOf` land on that tag rather than
 * on some earlier sibling.
 *
 * Throws rather than returning null. A missing element is a failure worth a
 * sentence, and `expect(...).not.toBeNull()` on every call site buys nothing
 * that the thrown message does not already say.
 */
export function elementWith(html: string, tag: string, needle: string): string {
  const source = stripComments(html);
  const at = source.indexOf(needle);
  if (at === -1) throw new Error(`markup does not contain ${needle}`);

  const open = source.lastIndexOf(`<${tag}`, at);
  if (open === -1) throw new Error(`no <${tag}> opens before ${needle}`);

  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  tags.lastIndex = open;
  let depth = 0;
  for (let match = tags.exec(source); match !== null; match = tags.exec(source)) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return source.slice(open, match.index + match[0].length);
  }
  throw new Error(`unbalanced <${tag}> around ${needle}`);
}
