/**
 * The mobile navigation takeover's behaviour (issue #101, design 1c).
 *
 * A MODULE rather than the inline `<script>` every other component in this
 * repo carries, and the reason is that the behaviour IS the deliverable here.
 * ThemeToggle.astro can keep its script inline because what it does -- writing
 * an attribute and a storage key -- is visible in the next rendered response.
 * A focus trap is not: nothing about "Tab from the last link goes back to the
 * first" survives into HTML, so the only way to assert it is to run it against
 * a DOM, and the only way to run it against a DOM is for it to be importable.
 * tests/mobile-nav-behavior.test.ts imports exactly this function and drives it
 * against the built page's own markup.
 *
 * The `<script>` in MobileNav.astro is therefore two lines: import this, call
 * it. Astro bundles the module in, so a visitor still gets one script.
 */

/**
 * What Tab moves between inside the overlay.
 *
 * Still deliberately short, because the overlay's contents are known and small:
 * one close button, two lists of links, and since issue #149 one search field.
 * The rest of the usual sprawling focusable selector (selects, iframes,
 * contenteditable, [tabindex]) would be describing elements that are not in
 * there.
 *
 * THE INPUT IS THE PART THAT CHANGED, and the note that stood here said the
 * opposite in terms: inputs "must never be" in this list, because "the search
 * affordance in this overlay is a label, not a control". That was true while
 * site search did not exist. Epic #143 built `/search` and #149 made this a
 * real GET form, so the field is now the one control in here that is neither a
 * link nor a button, and a trap that does not know about it is a trap reasoning
 * about the wrong set.
 *
 * WHAT IT DOES NOT CHANGE, said plainly so the next reader does not go looking:
 * the field sits between the nav links and the theme toggle, so `first` and
 * `last` below are the same two elements they were. Tab already reached it, by
 * document order, on the arms where the trap does not intervene. This makes the
 * set honest rather than fixing a reachability bug, and it is what keeps that
 * true the day the field moves to an end of the overlay.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled])';

/**
 * The breakpoint the rule bar returns at. `64rem` is Tailwind's `lg`, which is
 * what SiteHeader.astro spells its swap with; the two have to agree, because
 * the listener below exists precisely for the moment the overlay stops being
 * displayed.
 */
const DESKTOP = '(min-width: 64rem)';

export function initMobileNav(): void {
  const overlay = document.getElementById('rl-mobile-menu');
  const toggle = document.querySelector<HTMLElement>('[aria-controls="rl-mobile-menu"]');
  // Nothing on the page to wire. Returning rather than throwing: this module
  // is bundled into a script that runs on every page of the site.
  if (!overlay || !toggle) return;

  const closeButton = overlay.querySelector<HTMLElement>('[data-mobile-nav-close]');

  // What the lock overwrote. Closing RESTORES these rather than blanking them,
  // so the lock composes with any inline value the page already had instead of
  // quietly deleting it.
  let restoreOverflow = '';
  let restorePadding = '';

  const lock = () => {
    const root = document.documentElement;
    const existing = Number.parseFloat(getComputedStyle(document.body).paddingRight) || 0;

    restoreOverflow = root.style.overflow;
    restorePadding = document.body.style.paddingRight;

    /*
     * The gutter is MEASURED rather than inferred, and that distinction is the
     * whole of this function.
     *
     * `window.innerWidth - root.clientWidth` is what every modal library
     * reaches for, and it was what this did first. It is correct only while
     * those two numbers differ solely because a scrollbar sits between them.
     * MEASURED 2026-09-13, in headless Chrome under mobile emulation at 390px:
     * a page-scale factor put the layout viewport at 463 against a clientWidth
     * of 390, so the lock read a 73px scrollbar that was not there and padded
     * the page by it -- the footer went from 390px wide to 317px the instant
     * the overlay opened. Required behaviour 1 says the page behind must not
     * move, and that moved it, in the opposite direction to the failure the
     * compensation exists to prevent.
     *
     * Emulation is where it was caught, not the only place it happens: any
     * page scale separates those two numbers, and a pinch-zoomed phone is the
     * everyday version. At a true 390px layout the same run measured
     * innerWidth and clientWidth both 390 and no padding applied, which is
     * the right answer and the one the old formula also happened to give.
     *
     * So: hide the overflow, then ask how much wider the content box got.
     * That is the space the scrollbar was occupying, by definition, and it is
     * zero whenever there was no scrollbar to remove -- overlay scrollbars, a
     * phone, a zoomed page -- whatever innerWidth happens to say. Reading
     * clientWidth between the two writes forces one synchronous reflow, which
     * is the cost of being right, and this runs once per tap.
     */
    const before = root.clientWidth;
    root.style.overflow = 'hidden';
    const gutter = root.clientWidth - before;

    if (gutter > 0) document.body.style.paddingRight = `${existing + gutter}px`;
  };

  const unlock = () => {
    document.documentElement.style.overflow = restoreOverflow;
    document.body.style.paddingRight = restorePadding;
  };

  const isOpen = () => !overlay.hasAttribute('hidden');

  const open = () => {
    if (isOpen()) return;
    lock();
    // The attribute comes off BEFORE the focus call, deliberately: an element
    // carrying `hidden` is not a focusable area, so focusing the close button
    // first fails silently and leaves focus on the toggle behind the overlay.
    overlay.removeAttribute('hidden');
    toggle.setAttribute('aria-expanded', 'true');
    closeButton?.focus();
    document.addEventListener('keydown', onKeydown);
  };

  const close = () => {
    if (!isOpen()) return;
    overlay.setAttribute('hidden', '');
    toggle.setAttribute('aria-expanded', 'false');
    unlock();
    document.removeEventListener('keydown', onKeydown);
    /*
     * Back where it came from, WITHOUT revealing it.
     *
     * A bare `.focus()` scrolls its element into view, the toggle is 60px
     * from the top of the document, and global.css sets
     * `html { scroll-behavior: smooth }` -- so closing the overlay animated
     * the whole page back to the top. MEASURED 2026-09-13, in headless Chrome
     * at 390px: a page at 600px stayed at 600px with the overlay open and sat
     * at 0 a second after it closed. `preventScroll` held it at 600.
     *
     * That is requirement 2 (focus returns to the toggle) colliding with
     * requirement 1 (the page behind must not move), and this is the line
     * where they are reconciled. The trade is that a keyboard visitor's focus
     * can land off screen; their next Tab scrolls to wherever it goes, which
     * is a far smaller surprise than the page rewinding under a thumb.
     */
    toggle.focus({ preventScroll: true });
  };

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const inside = [...overlay!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (inside.length === 0) return;

    const first = inside[0];
    const last = inside[inside.length - 1];
    const active = document.activeElement;

    // The `!contains` arm is not belt and braces. The overlay is fixed over
    // the page rather than replacing it, so everything behind is still in the
    // document and still tabbable; a keypress arriving while focus sits out
    // there has to be pulled back in, not just wrapped at the ends.
    if (event.shiftKey) {
      if (active === first || !overlay!.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !overlay!.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  toggle.addEventListener('click', () => (isOpen() ? close() : open()));
  closeButton?.addEventListener('click', close);

  // A window dragged from narrow to wide with the overlay open leaves it
  // `display: none` (MobileNav.astro's `lg:hidden`) while the scroll lock is
  // still on and focus is still trapped inside it -- an invisible element
  // holding a page that will not scroll. Not one of the issue's five required
  // behaviours; it is the failure the first of them creates, so it is fixed
  // beside it.
  window.matchMedia?.(DESKTOP)?.addEventListener?.('change', (event) => {
    if (event.matches) close();
  });
}
