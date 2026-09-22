// @vitest-environment jsdom
/**
 * The theme toggle's behaviour, once there is more than one of it on a page.
 *
 * The three-state cycle itself is old and was not changed here. What is new is
 * that issue #101 gave the mobile overlay its own toggle, so a page now
 * renders two, and "repaint the button that was clicked" stopped being the
 * same thing as "repaint the toggle". The cycle reads its state from storage
 * rather than from the DOM, so a stale second label does not break the theme
 * -- it just tells the visitor the wrong thing about it, which is worse than
 * a control that does nothing, because it looks like it worked.
 *
 * Driven against the BUILT header, so both toggles are the ones the site
 * actually ships rather than two hand-typed buttons that happen to agree.
 */
import { beforeEach, expect, test } from 'vitest';
import { builtHeaderMarkup } from './markup';
import { initThemeToggle, setFavicon } from '../src/lib/theme-toggle';

const headerMarkup = builtHeaderMarkup();

const toggles = () => [...document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')];
const labels = () =>
  [...document.querySelectorAll('[data-theme-label]')].map((el) => el.textContent);

/*
 * JSDOM IMPLEMENTS NO `matchMedia` AT ALL -- not a stubbed one that answers
 * false, none, so the bare call in src/lib/theme-toggle.ts is a TypeError
 * there. It is a long-standing gap in jsdom rather than anything wrong with
 * the module, and every browser this ships to has the function, so the stub
 * belongs here and the production code is left reading it directly.
 *
 * Stated rather than merely silenced, because the OS preference is a real
 * input to this component: `matches` is read at call time from the variable
 * below, and the listeners are kept so a change can be fired.
 */
let osPrefersDark = false;
const mediaListeners: (() => void)[] = [];

function installMatchMedia() {
  osPrefersDark = false;
  mediaListeners.length = 0;
  window.matchMedia = ((media: string) => ({
    media,
    get matches() {
      return media.includes('dark') ? osPrefersDark : false;
    },
    addEventListener: (_type: string, listener: () => void) => void mediaListeners.push(listener),
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  installMatchMedia();
  // The link Base.astro server-renders, verbatim, so the swap is tested
  // against the element it will actually meet.
  document.head.innerHTML = '<link rel="icon" href="/favicon-dark.svg" type="image/svg+xml">';
  document.body.innerHTML = headerMarkup;
  initThemeToggle();
});

test('the built page really does render two of them', () => {
  // The premise of every test below. If this ever drops to one, the sync
  // assertions still pass and stop meaning anything.
  expect(toggles()).toHaveLength(2);
});

test('every toggle starts showing the same state', () => {
  expect(labels()).toEqual(['SYSTEM', 'SYSTEM']);
});

test('clicking one toggle repaints all of them', () => {
  toggles()[0].click();
  expect(labels()).toEqual(['LIGHT', 'LIGHT']);
});

test('clicking the other one continues the same cycle rather than starting its own', () => {
  // The state lives in storage, not on the button, so the second toggle has to
  // pick the cycle up where the first left it.
  toggles()[0].click();
  toggles()[1].click();
  expect(labels()).toEqual(['DARK', 'DARK']);
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
});

test('the cycle still returns to system, and system still clears the stored choice', () => {
  for (let i = 0; i < 3; i++) toggles()[0].click();
  expect(labels()).toEqual(['SYSTEM', 'SYSTEM']);
  expect(localStorage.getItem('rl-theme')).toBeNull();
});

test('the accessible name tracks the state on every toggle, not just the clicked one', () => {
  toggles()[1].click();
  for (const toggle of toggles()) {
    expect(toggle.getAttribute('aria-label')).toBe('Theme: light');
  }
});

test('while following the system it tracks the OS live, not until the next reload', () => {
  // Carried over with the script rather than written for it. Asserted here
  // because moving code is exactly when a listener gets dropped and nothing
  // notices -- the symptom is a visitor on SYSTEM whose page stays light
  // after their Mac goes dark at sunset, which nobody reports as a bug.
  //
  // `data-theme` is ABSENT rather than "light" before the flip, and that is
  // correct: init paints the buttons but deliberately does not apply a theme,
  // because Base.astro's inline head script has already written the attribute
  // before this module ever runs on a real page. Nothing writes it in jsdom,
  // which is why the starting state here is null and not a value.
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

  osPrefersDark = true;
  for (const listener of mediaListeners) listener();

  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
});

test('an explicit choice is not overridden when the OS flips', () => {
  toggles()[0].click(); // system -> light
  osPrefersDark = true;
  for (const listener of mediaListeners) listener();

  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  expect(labels()).toEqual(['LIGHT', 'LIGHT']);
});

const svgIcons = () => [
  ...document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]'),
];

test('cycling the toggle swaps the SVG icon for the resolved theme, and leaves exactly one', () => {
  toggles()[0].click(); // system -> light
  expect(svgIcons().map((link) => link.getAttribute('href'))).toEqual(['/favicon-light.svg']);
  toggles()[0].click(); // light -> dark
  expect(svgIcons().map((link) => link.getAttribute('href'))).toEqual(['/favicon-dark.svg']);
});

test('the swap replaces the element rather than editing its href', () => {
  // Safari caches the bitmap against the element, and Firefox ignores an
  // in-place href change, so an edited node would look right here and wrong
  // in both browsers.
  const before = svgIcons()[0];
  setFavicon('light');
  expect(svgIcons()[0]).not.toBe(before);
  expect(before.isConnected).toBe(false);
});

test('on load the icon matches the theme the head script already resolved', () => {
  document.documentElement.setAttribute('data-theme', 'light');
  initThemeToggle();
  expect(svgIcons().map((link) => link.getAttribute('href'))).toEqual(['/favicon-light.svg']);
});

test('an OS flip while following the system swaps the icon too', () => {
  osPrefersDark = true;
  for (const listener of mediaListeners) listener();
  expect(svgIcons().map((link) => link.getAttribute('href'))).toEqual(['/favicon-dark.svg']);
});

test('the .ico fallback is left alone', () => {
  document.head.insertAdjacentHTML(
    'beforeend',
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
  );
  setFavicon('light');
  expect(document.head.querySelectorAll('link[href="/favicon.ico"]')).toHaveLength(1);
});
