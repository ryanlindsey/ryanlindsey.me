/**
 * The markup helpers' own tests.
 *
 * ./markup.ts is a test utility, so this is a test of a test -- worth it
 * because four suites now assert against whatever it returns, and both
 * functions in it are the kind of small string algorithm that is wrong in
 * ways nobody notices until an assertion quietly stops looking at anything.
 */
import { expect, test } from 'vitest';
import { elementWith, stripComments, stripTags } from './markup';

test('a comment that reassembles itself after one pass is still removed', () => {
  // CodeQL js/incomplete-multi-character-sanitization, alert #5, raised
  // against the first version of stripComments on 2026-09-13. That version
  // was a single `.replace(/<!--[\s\S]*?-->/g, '')`, and a single pass can
  // GLUE A NEW COMMENT TOGETHER out of what it leaves behind: removing the
  // inner comment below joins the `<!-` in front of it to the `-hello-->`
  // behind it, and the result is `<!--hello-->` sitting in the "stripped"
  // output.
  //
  // Not a security finding here -- the input is this site's own build output,
  // and nothing is rendered from it. It is a correctness one, which is the
  // other half of what that rule is for: a comment surviving the strip is a
  // comment whose text elementWith then counts as structure, and a stray
  // `<div` inside one would throw the depth count off and hand a test the
  // wrong slice of the page.
  // `<!-` + `<!--REMOVEME-->` + `-hello-->`, written as one literal so the
  // seam is visible. There is deliberately no whitespace at either join: a
  // single space anywhere in it stops the two halves forming `<!--` and the
  // case evaporates, which is how the first draft of this test passed against
  // the very implementation it was written to fail.
  const stripped = stripComments('<!-<!--REMOVEME-->-hello-->');
  expect(stripped).not.toContain('<!--');
});

test('ordinary comments come out and the markup around them does not', () => {
  expect(stripComments('<p>a</p><!-- note --><p>b</p>')).toBe('<p>a</p><p>b</p>');
});

test('elementWith returns the whole element, not the first closing tag it meets', () => {
  // The bug this helper exists to avoid, as a case. A non-greedy match to the
  // first `</div>` would stop at the header strip and never see the link.
  const markup = `
    <div id="outer"><div class="strip">MENU</div><a href="/writing">Writing</a></div><div>after</div>
  `;
  const element = elementWith(markup, 'div', 'id="outer"');
  expect(element).toContain('href="/writing"');
  expect(element).not.toContain('after');
  expect(element.endsWith('</div>')).toBe(true);
});

test('elementWith says which thing it could not find', () => {
  expect(() => elementWith('<div></div>', 'div', 'id="nope"')).toThrow(/id="nope"/);
});

test('stripTags leaves only the text of nested markup', () => {
  expect(stripTags('<td class="text-ok"><span data-numeric>1/1</span></td>')).toBe('1/1');
});
