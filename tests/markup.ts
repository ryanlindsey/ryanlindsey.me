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

/**
 * Astro emits template `<!-- ... -->` comments into the built page, and this
 * codebase writes long ones. A comment mentioning `<div>` would be counted as
 * structure, so every scan below runs on the commentless copy.
 */
export function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
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
