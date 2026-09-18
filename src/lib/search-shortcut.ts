/**
 * The ⌘K search shortcut (issue #149, epic #143).
 *
 * WHAT IT DOES NOT DO IS THE INTERESTING HALF. Epic #143 rejects the command
 * palette outright -- "no modal, no command palette, no autocomplete", because
 * a query is an address -- and ⌘K is borrowed from exactly that pattern. This
 * module opens nothing. It moves focus into a field that submits a GET form to
 * `/search`, and the page behaves identically for anyone who never presses it.
 *
 * IT EXISTS BECAUSE THE CHIP ALREADY DID. SiteHeader.astro has rendered a ⌘K
 * chip since the redesign, advertising a binding that was not there; its own
 * comment used to say so. #149 could have deleted the chip or made it true,
 * and making it true costs this file. If the shortcut ever proves confusing,
 * deleting the chip and this module is a two-line change and the form keeps
 * working.
 *
 * A MODULE rather than an inline `<script>`, for the reason src/lib/mobile-nav.ts
 * states: the behaviour IS the deliverable, none of it survives into a rendered
 * response, and the only way to assert "focus went to the right field" is to run
 * it against a DOM. tests/search-shortcut.test.ts imports this function and
 * drives it against the built header.
 */

/**
 * The breakpoint at which the header's own field is on the page.
 *
 * `64rem` is Tailwind's `lg`, which is what SiteHeader.astro spells its
 * `hidden lg:flex` swap with and what src/lib/mobile-nav.ts already matches for
 * the same reason. THREE PLACES NOW AGREE ON THIS NUMBER and they have to: get
 * it wrong here and the shortcut focuses a field that is `display: none`, which
 * silently does nothing at all.
 *
 * ASKED OF THE MEDIA QUERY RATHER THAN OF THE ELEMENT, deliberately.
 * `offsetParent` and `getBoundingClientRect` answer for a box, and the box is
 * not the question -- which of the two search fields the visitor can see is
 * decided by one media query in both components, so that is the thing to ask.
 */
const DESKTOP = '(min-width: 64rem)';

/**
 * Where a keystroke means something other than "search".
 *
 * Ctrl+K inside a text field is delete-to-end-of-line on macOS and in every
 * readline-style binding, and this site has real fields to lose it in: the
 * /chat composer and /search's own input. Swallowing it there would break a
 * standard editing key to offer a shortcut to a field the visitor is already
 * typing in. The search fields themselves are covered by the same rule and for
 * the same reason -- somebody standing in one does not need to be sent to it.
 *
 * `[contenteditable]` is in the list for completeness rather than because
 * anything on this site renders one today; it is the one editable surface a
 * future component could add without also remembering this file.
 */
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

const headerField = () =>
  document.querySelector<HTMLInputElement>('[data-header-search] input[name="q"]');
const navField = () =>
  document.querySelector<HTMLInputElement>('[data-nav-search] input[name="q"]');

export function initSearchShortcut(): void {
  // Nothing on the page to wire, so nothing is bound. Returning rather than
  // throwing, the same contract src/lib/mobile-nav.ts keeps: this module is
  // bundled into a script that runs on every page of the site, and a throw here
  // would take the mobile nav down with it.
  if (!headerField() && !navField()) return;

  document.addEventListener('keydown', onKeydown);
}

function onKeydown(event: KeyboardEvent): void {
  // EXACTLY ONE OF Meta OR Ctrl, AND NEITHER OF THE OTHER TWO. Ctrl+Shift+K is
  // the console in Firefox and ⌘+Alt+K is a devtools panel; a handler that
  // answers to every K carrying a modifier has taken both. `key` rather than
  // `code`, so a non-QWERTY layout gets the letter its keycaps show.
  if (event.key.toLowerCase() !== 'k') return;
  if (event.metaKey === event.ctrlKey) return;
  if (event.altKey || event.shiftKey) return;

  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest(EDITABLE)) return;

  /*
   * THE FIELDS ARE LOOKED UP NOW, NOT AT INIT. Holding references from
   * `initSearchShortcut` would be fine on this site, where the header is
   * server-rendered once and never replaced -- and it is exactly the assumption
   * that makes a module untestable, because a suite that resets its fixture
   * between tests leaves the handler pointing at detached elements. Two
   * `querySelector` calls per ⌘K is not a cost worth that.
   *
   * THE VISIBLE FIELD OR NOTHING, with no falling back to the other one. An
   * earlier version read `desktop ? (header ?? nav) : (nav ?? header)`, and a
   * review of issue #149 showed both arms failing worse than doing nothing:
   * below `lg` with no overlay field it swallowed the key and focused a
   * `display: none` input, and at desktop with no header field it clicked an
   * `lg:hidden` toggle, putting the scroll lock on and `aria-expanded="true"`
   * on an invisible toggle over an invisible overlay. Both need a component to
   * stop rendering its form, so neither is likely -- but when the field a
   * visitor can see is missing, handing the key back to the browser is the only
   * honest answer, and returning before `preventDefault` is what does that.
   */
  const desktop = window.matchMedia?.(DESKTOP)?.matches ?? true;
  const nav = navField();
  const target = desktop ? headerField() : nav;
  if (!target) return;

  event.preventDefault();

  if (target === nav) openNav();

  /*
   * FOCUSED AND SCROLLED TO, which is the opposite call from the one
   * src/lib/mobile-nav.ts makes at its own `.focus()`.
   *
   * That file passes `preventScroll: true` because it is returning focus to a
   * toggle the visitor already knows about, and scrolling the page back to it
   * would rewind their reading -- `html { scroll-behavior: smooth }` in
   * global.css makes that an animated ride rather than a jump, which is what
   * made it so obvious there. Here the field is the thing being asked for: the
   * header is sticky on article routes only, so on every other page a visitor
   * who has scrolled down would be typing into a box that is off screen unless
   * the browser brings it back. The same animated scroll is the feature, and
   * global.css already answers `prefers-reduced-motion` for anyone who has
   * asked not to have it.
   */
  target.focus();
  // SELECTED, so the next keystroke replaces rather than appends. On /search
  // the field arrives prefilled, and somebody pressing the shortcut there is
  // starting a new search far more often than extending the last one.
  target.select();
}

function openNav(): void {
  const overlay = document.getElementById('rl-mobile-menu');
  const toggle = document.querySelector<HTMLElement>('[aria-controls="rl-mobile-menu"]');
  if (!overlay || !toggle) return;
  // ALREADY OPEN IS NOT A NO-OP TO GET WRONG: the toggle's own listener is a
  // toggle, so clicking it here without this guard would close the overlay the
  // visitor is standing in and then focus a field inside a `hidden` element,
  // which fails silently.
  if (!overlay.hasAttribute('hidden')) return;
  /*
   * CLICKED RATHER THAN OPENED DIRECTLY. Opening the overlay means removing
   * `hidden`, setting `aria-expanded`, locking the scroll and binding the focus
   * trap -- src/lib/mobile-nav.ts owns all four and exports none of them.
   * Reproducing them here would be a second implementation of the overlay's
   * state that could disagree with the first; dispatching the gesture the
   * visitor would otherwise make cannot.
   *
   * The ordering this depends on: `open()` is synchronous and ends by focusing
   * the close button, so the caller's `focus()` has to come after this call or
   * it is immediately overwritten.
   */
  toggle.click();
}
