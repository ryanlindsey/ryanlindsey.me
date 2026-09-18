// @vitest-environment jsdom
/**
 * The ⌘K search shortcut's behaviour (issue #149).
 *
 * A DOM SUITE BECAUSE NOTHING HERE SURVIVES INTO HTML, which is the same
 * reason tests/mobile-nav-behavior.test.ts and tests/theme-toggle.test.ts are
 * ones. "⌘K moves focus into the header field, and into the overlay's field
 * when the header's is hidden" is not a string a rendered response can be
 * asked about; it is only observable by running the handler against a
 * document. The markup half -- that the forms exist and are reachable -- stays
 * in tests/pages.test.ts and tests/mobile-nav.test.ts under the harness.
 *
 * THE FIXTURE IS THE BUILT HEADER, not hand-typed markup, for the reason that
 * file states: a DOM test drives whatever the test put in the DOM, so typing
 * the forms out here would let this suite stay green against components that
 * no longer render them. `npm test` is `astro build && vitest run`, so the
 * build exists by the time this runs; a bare `npx vitest run` on this file
 * needs `npm run build` first.
 *
 * WHY THIS SHORTCUT EXISTS AT ALL, since the epic rejects the pattern it comes
 * from: the ⌘K chip was already in the header, advertising a binding that did
 * not exist. #149 could have deleted the chip or made it true, and making it
 * true costs one module. It opens nothing -- no palette, no overlay, no
 * dropdown. It moves focus to a field that submits a GET form.
 */
import { beforeEach, expect, test } from 'vitest';
import { builtHeaderMarkup } from './markup';
import { initMobileNav } from '../src/lib/mobile-nav';
import { initSearchShortcut } from '../src/lib/search-shortcut';

const headerMarkup = builtHeaderMarkup();

const headerInput = () =>
  document.querySelector<HTMLInputElement>('[data-header-search] input[name="q"]')!;
const navInput = () =>
  document.querySelector<HTMLInputElement>('[data-nav-search] input[name="q"]')!;
const overlay = () => document.getElementById('rl-mobile-menu')!;

/**
 * The viewport, as the only thing the module is allowed to ask about it.
 *
 * jsdom implements no `matchMedia` whatsoever -- not a stub answering false,
 * none -- so this is required rather than convenient, exactly as
 * tests/theme-toggle.test.ts records for the same gap. Stated as a real input
 * because it is one: `64rem` is Tailwind's `lg`, which is the breakpoint
 * SiteHeader.astro hides its right cluster at, and the module has to agree
 * with that number or it focuses a field nobody can see.
 */
let desktop = true;

function installMatchMedia() {
  window.matchMedia = ((media: string) => ({
    media,
    get matches() {
      return media.includes('64rem') ? desktop : false;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** A ⌘K or Ctrl+K keypress, returned so a test can ask whether it was eaten. */
function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  desktop = true;
  installMatchMedia();
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
  document.body.innerHTML = headerMarkup;
  // Both, because the page runs both and the mobile branch below depends on
  // the overlay actually opening rather than on a stub of it.
  initMobileNav();
  initSearchShortcut();
});

test('⌘K puts the cursor in the header field and takes the key off the browser', () => {
  const event = press('k', { metaKey: true });
  expect(document.activeElement).toBe(headerInput());
  // Unprevented, ⌘K is the browser's own search bar on Firefox and a tab
  // shortcut elsewhere, so a shortcut that focuses the field and ALSO hands
  // the key on has moved focus to a field the visitor is about to navigate
  // away from.
  expect(event.defaultPrevented).toBe(true);
});

test('Ctrl+K does the same, because not every visitor is on a Mac', () => {
  press('k', { ctrlKey: true });
  expect(document.activeElement).toBe(headerInput());
});

test('an existing query is selected, so the next keystroke replaces it', () => {
  // On /search the header field arrives prefilled. Focusing it without
  // selecting would make the visitor's first keystroke append to a query they
  // were trying to replace, which is the one thing worse than an empty field.
  headerInput().value = 'armature';
  press('k', { metaKey: true });
  expect(headerInput().selectionStart).toBe(0);
  expect(headerInput().selectionEnd).toBe('armature'.length);
});

test('below lg the shortcut opens the nav and lands in the field that is actually there', () => {
  desktop = false;
  press('k', { metaKey: true });
  // The header's cluster is `hidden lg:flex`, so on a phone its input is not
  // on screen and focusing it would move the caret nowhere a thumb can see.
  expect(overlay().hasAttribute('hidden')).toBe(false);
  expect(document.activeElement).toBe(navInput());
});

test('an already-open nav is not toggled shut by the shortcut', () => {
  desktop = false;
  document.querySelector<HTMLButtonElement>('[aria-controls="rl-mobile-menu"]')!.click();
  press('k', { metaKey: true });
  expect(overlay().hasAttribute('hidden')).toBe(false);
  expect(document.activeElement).toBe(navInput());
});

test('it stays out of the way while the visitor is typing somewhere else', () => {
  /*
   * Ctrl+K inside a text field is delete-to-end-of-line on macOS and in every
   * readline-style binding, and this site has real fields to lose it in: the
   * /chat composer and the /search page's own input. A plain input stands in
   * for them here rather than building a second page fixture -- what is being
   * asserted is that the module reads `document.activeElement`, not which
   * page the field came from.
   */
  const composer = document.createElement('input');
  composer.type = 'text';
  // `appendChild`, not `append`: worker-configuration.d.ts puts Cloudflare's
  // own `append` in scope here and it takes a body, not a node.
  document.body.appendChild(composer);
  composer.focus();

  const event = press('k', { ctrlKey: true });

  expect(document.activeElement).toBe(composer);
  expect(event.defaultPrevented).toBe(false);
});

test('it does not swallow modifier combinations that mean something else', () => {
  // Ctrl+Shift+K is the console in Firefox and Cmd+Alt+K is a devtools panel;
  // a shortcut that answers to every K with a modifier on it has taken those.
  const shifted = press('k', { metaKey: true, shiftKey: true });
  const alted = press('k', { metaKey: true, altKey: true });
  const bare = press('k');

  for (const event of [shifted, alted, bare]) expect(event.defaultPrevented).toBe(false);
  expect(document.activeElement).not.toBe(headerInput());
});

test('a page without the header does not throw, because this module ships on all of them', () => {
  // Same contract src/lib/mobile-nav.ts states: the bundle runs on every page
  // of the site, so nothing to wire is a return rather than a TypeError that
  // would take the rest of the bundle down with it.
  document.body.innerHTML = '<p>no header here</p>';
  expect(() => initSearchShortcut()).not.toThrow();
  expect(() => press('k', { metaKey: true })).not.toThrow();
});
