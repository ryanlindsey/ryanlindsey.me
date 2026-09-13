// @vitest-environment jsdom
/**
 * The mobile navigation takeover, behaviour layer (issue #101).
 *
 * THE FIRST DOM TEST IN THIS REPO, and it is here because the deliverable of
 * that issue is behaviour rather than appearance: focus moves, is trapped and
 * comes back; Esc closes; the page behind does not move. None of that is
 * observable in a rendered response, which is all the wrangler harness can
 * hand a test, so this file runs under jsdom instead. The markup half stays
 * in tests/mobile-nav.test.ts under the harness, where it belongs.
 *
 * The fixture is the BUILT page, not hand-typed markup. Typing the overlay
 * out here would let this suite stay green against a component that no longer
 * renders what it asserts -- the failure mode a DOM test invites, since the
 * DOM it drives is whatever the test put in it. Reading dist/client/index.html
 * means a change to MobileNav.astro that breaks the trap breaks this file too.
 * `npm test` is `astro build && vitest run`, so the build always exists by the
 * time this runs; a bare `npx vitest run` on this file needs `npm run build`
 * first, the same as every harness suite here.
 *
 * WHAT JSDOM CANNOT DO, said plainly because one assertion below looks like it
 * measures something it does not: jsdom performs no layout. Every box is zero
 * by zero, `getComputedStyle` answers from the cascade only, and there is no
 * scrollbar to take space. So the scroll-lock test states the viewport and the
 * scrollbar gutter itself and asserts that the lock compensates for exactly
 * that gutter. That is the mechanism, not the reflow. The reflow is checked by
 * hand at 390px and on a desktop browser, per the issue's step 8.
 */
import { beforeEach, expect, test } from 'vitest';
import { builtHeaderMarkup } from './markup';
import { initMobileNav } from '../src/lib/mobile-nav';

const headerMarkup = builtHeaderMarkup();

const toggle = () => document.querySelector<HTMLButtonElement>('[aria-controls="rl-mobile-menu"]')!;
const overlay = () => document.getElementById('rl-mobile-menu')!;
const closeButton = () => document.querySelector<HTMLButtonElement>('[aria-label="Close menu"]')!;
const focusables = () => [
  ...overlay().querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
];

/**
 * A document whose content box grows by `gutter` when its overflow is hidden,
 * which is what a classic scrollbar does and what the lock has to give back.
 * jsdom performs no layout, so the reaction is stated rather than computed --
 * but it is stated as a REACTION TO THE OVERFLOW, which is the thing the lock
 * is supposed to be measuring.
 *
 * `innerWidth` is set to something deliberately unrelated. The lock must not
 * read it: `window.innerWidth - documentElement.clientWidth` is the formula
 * every modal library reaches for, and it is wrong whenever those two differ
 * for a reason that is not a scrollbar. See the regression test at the bottom.
 */
function stateScrollbar(gutter: number, contentWidth = 1024) {
  Object.defineProperty(window, 'innerWidth', { value: 9999, configurable: true });
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    get: () =>
      document.documentElement.style.overflow === 'hidden' ? contentWidth : contentWidth - gutter,
  });
}

/** A scroll offset, since jsdom does not scroll either. */
function stateScrollY(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

function press(key: string, init: KeyboardEventInit = {}) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

beforeEach(() => {
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
  document.body.innerHTML = headerMarkup;
  stateScrollbar(15);
  stateScrollY(0);
  initMobileNav();
});

test('the toggle opens the overlay', () => {
  expect(overlay().hasAttribute('hidden')).toBe(true);
  toggle().click();
  expect(overlay().hasAttribute('hidden')).toBe(false);
});

test('aria-expanded on the toggle tracks the state', () => {
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  toggle().click();
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  closeButton().click();
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
});

test('opening moves focus to the close button', () => {
  toggle().click();
  expect(document.activeElement).toBe(closeButton());
});

test('Tab from the last focusable inside the overlay returns to the first', () => {
  toggle().click();
  const inside = focusables();
  expect(inside.length, 'the overlay has nothing focusable in it').toBeGreaterThan(1);

  inside[inside.length - 1].focus();
  press('Tab');
  expect(document.activeElement).toBe(inside[0]);
});

test('Shift+Tab from the first focusable inside the overlay returns to the last', () => {
  toggle().click();
  const inside = focusables();

  inside[0].focus();
  press('Tab', { shiftKey: true });
  expect(document.activeElement).toBe(inside[inside.length - 1]);
});

test('Esc closes the overlay', () => {
  toggle().click();
  press('Escape');
  expect(overlay().hasAttribute('hidden')).toBe(true);
});

test('closing returns focus to the toggle that opened it', () => {
  toggle().click();
  press('Escape');
  expect(document.activeElement).toBe(toggle());
});

test('the close button closes it too', () => {
  toggle().click();
  closeButton().click();
  expect(overlay().hasAttribute('hidden')).toBe(true);
});

test('closing does not scroll the page to bring the toggle back into view', () => {
  // MEASURED 2026-09-13, in headless Chrome at a 390px mobile viewport, and
  // this test is here because the first implementation failed it.
  //
  // Requirement 2 says focus returns to the toggle and requirement 1 says the
  // page behind must not move, and those two fight: a bare `.focus()` reveals
  // the element it focuses, the toggle is 60px from the top of the document,
  // and `html { scroll-behavior: smooth }` in global.css turns the reveal
  // into a visible ride. The run recorded a page scrolled to 600px sitting at
  // 600px with the overlay open and at 0 a second after it closed -- the
  // whole page, silently rewound, every time anyone closed the menu.
  // `{ preventScroll: true }` held it at 600.
  //
  // ASSERTED ON THE CALL rather than on window.scrollY, because jsdom neither
  // scrolls nor reveals, so an offset assertion here would pass against both
  // implementations. The option is the thing the browser reacts to, so the
  // option is what this pins. Opening is deliberately not given the same
  // treatment: the close button lives in an `inset: 0` fixed overlay that is
  // never out of view, and the same run measured the offset unchanged at 600
  // across the open.
  const calls: (FocusOptions | undefined)[] = [];
  const button = toggle();
  const original = button.focus.bind(button);
  button.focus = (options?: FocusOptions) => {
    calls.push(options);
    original(options);
  };

  button.click();
  press('Escape');

  expect(calls.length, 'focus never returned to the toggle').toBeGreaterThan(0);
  expect(calls[0]?.preventScroll).toBe(true);
});

test('the page keeps its scroll offset across an open and a close', () => {
  stateScrollY(742);
  toggle().click();
  expect(window.scrollY).toBe(742);
  closeButton().click();
  expect(window.scrollY).toBe(742);
});

test('the lock compensates for the scrollbar it removes, so the page does not jump', () => {
  // The half that catches a bare `overflow: hidden`. That passes the offset
  // test above untouched and still shifts every line of the page left by the
  // scrollbar's width the moment the overlay opens, because hiding the
  // overflow hides the scrollbar and the content reflows into the space it
  // had. The padding has to give that space back.
  toggle().click();
  expect(document.documentElement.style.overflow).toBe('hidden');
  expect(document.body.style.paddingRight).toBe('15px');
});

test('a viewport with no scrollbar to remove gets no padding', () => {
  // Overlay scrollbars -- every phone, and macOS unless a mouse is attached.
  // Hiding the overflow takes no width away, so giving width back would BE
  // the jump this lock exists to prevent.
  stateScrollbar(0);
  toggle().click();
  expect(document.body.style.paddingRight).toBe('');
});

test('a visual viewport narrower than the layout viewport is not mistaken for a scrollbar', () => {
  // MEASURED 2026-09-13, in headless Chrome under mobile emulation at 390px,
  // and this test exists because the first implementation got it wrong there.
  //
  // That implementation used `window.innerWidth - documentElement.clientWidth`
  // -- the formula every modal library reaches for, and a correct one only
  // while those two differ solely because of a scrollbar. Under a page-scale
  // factor they differ for an unrelated reason: the run recorded a layout
  // viewport of 463 against a clientWidth of 390, so the lock read a 73px
  // "scrollbar" that did not exist and padded the page by it. The footer
  // measured 390px wide before opening and 317px while open -- the overlay
  // shoved the page behind it inward by 73px, which is precisely the class of
  // failure required behaviour 1 names, arrived at from the other direction.
  // A pinch-zoomed phone separates the same two numbers the same way.
  //
  // The fix is to stop inferring the gutter and measure it: hide the overflow
  // and see how much wider the content box got. That number is zero whenever
  // there was no scrollbar, whatever innerWidth happens to say.
  // The measured pair, exactly: a 390px content box that does not change when
  // the overflow is hidden, under an innerWidth of 463.
  stateScrollbar(0, 390);
  Object.defineProperty(window, 'innerWidth', { value: 463, configurable: true });

  toggle().click();
  expect(document.body.style.paddingRight).toBe('');
});

test('closing restores the styles the lock changed rather than blanking them', () => {
  document.documentElement.style.overflow = 'clip';
  document.body.style.paddingRight = '3px';

  toggle().click();
  closeButton().click();

  expect(document.documentElement.style.overflow).toBe('clip');
  expect(document.body.style.paddingRight).toBe('3px');
});

test('growing past the breakpoint closes it rather than stranding the scroll lock', () => {
  // The overlay is `lg:hidden`, so a window dragged from narrow to wide with
  // it open leaves an invisible element holding focus and `overflow: hidden`
  // on a page that can no longer scroll. Not one of the issue's five required
  // behaviours; it is the failure the first of them creates.
  const listeners: ((event: MediaQueryListEvent) => void)[] = [];
  window.matchMedia = ((media: string) =>
    ({
      media,
      matches: false,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.push(listener),
      removeEventListener: () => {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;

  document.body.innerHTML = headerMarkup;
  initMobileNav();
  toggle().click();
  expect(overlay().hasAttribute('hidden')).toBe(false);

  expect(listeners.length, 'nothing is watching the breakpoint').toBeGreaterThan(0);
  for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);

  expect(overlay().hasAttribute('hidden')).toBe(true);
  expect(document.documentElement.style.overflow).toBe('');
});
