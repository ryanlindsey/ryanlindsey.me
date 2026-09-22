/**
 * The theme toggle's behaviour, cycling system -> light -> dark -> system.
 *
 * "System" is a real state rather than an implicit default, so a visitor can
 * always get back to following their OS without clearing site data. That
 * reasoning predates the 2026-09 redesign, survived it, and is why this is a
 * three-state control where design 1a drew a two-state one.
 *
 * A MODULE rather than the inline `<script>` this lived in until issue #101,
 * for the reason src/lib/mobile-nav.ts is one: the page now renders TWO of
 * these -- the desktop right cluster's and the mobile overlay's -- and
 * "repaint the button that was clicked" stopped being the same thing as
 * "repaint the toggle". Cross-instance behaviour is not visible in a rendered
 * response, so the only way to assert it is to run it against a DOM, and the
 * only way to do that is for it to be importable. tests/theme-toggle.test.ts
 * drives exactly this function against the built header.
 *
 * The state lives in storage rather than on any button, so a second toggle
 * left showing a stale label does NOT break the theme -- the cycle still
 * advances correctly from wherever storage says it is. It just tells the
 * visitor the wrong thing about it, which is worse than a control that
 * plainly does nothing, because it looks like it worked.
 */
const LABELS = { system: 'SYSTEM', light: 'LIGHT', dark: 'DARK' } as const;
const ORDER = ['system', 'light', 'dark'] as const;
type Mode = (typeof ORDER)[number];

const prefersDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

/**
 * The tab icon, in the resolved theme's variant (#363).
 *
 * REPLACES THE NODE rather than editing its `href`: Safari caches the old
 * bitmap against the element, and Firefox ignores an in-place change. Firefox
 * also keeps the first icon it fetched for a tab whatever happens here, so
 * this is an enhancement there. Only the SVG link is touched; the .ico cannot
 * follow a theme and is left as the fallback.
 *
 * Not in Base.astro's blocking head script, deliberately: the tab icon is not
 * painted before <body>, so it would buy nothing and add bytes to the path
 * that decides first paint.
 */
export const setFavicon = (theme: 'light' | 'dark') => {
  document.head.querySelector('link[rel="icon"][type="image/svg+xml"]')?.remove();
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = `/favicon-${theme}.svg`;
  document.head.appendChild(link);
};

const read = (): Mode => {
  try {
    const stored = localStorage.getItem('rl-theme');
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
};

const apply = (mode: Mode) => {
  const resolved = mode === 'system' ? (prefersDark() ? 'dark' : 'light') : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  setFavicon(resolved);
  try {
    if (mode === 'system') localStorage.removeItem('rl-theme');
    else localStorage.setItem('rl-theme', mode);
  } catch {
    // Storage unavailable: the choice still applies for this page view.
  }
};

/**
 * Every toggle on the page, not the one that was clicked.
 *
 * The whole difference between this file and the inline script it replaces.
 * That script closed `paint` over a single button inside the wiring loop,
 * which was correct while exactly one of these existed and silently wrong the
 * moment a second did.
 */
const paintAll = (mode: Mode) => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    const label = button.querySelector('[data-theme-label]');
    if (label) label.textContent = LABELS[mode];
    button.setAttribute(
      'aria-label',
      mode === 'system' ? 'Theme: follow system' : `Theme: ${mode}`,
    );
  }
};

export function initThemeToggle(): void {
  // The server renders the dark variant. Base.astro's head script has already
  // resolved the theme by the time this runs, so read its answer rather than
  // deciding again.
  const resolved = document.documentElement.getAttribute('data-theme');
  if (resolved === 'light' || resolved === 'dark') setFavicon(resolved);

  paintAll(read());

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    button.addEventListener('click', () => {
      const next = ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length];
      apply(next);
      paintAll(next);
    });
  }

  // While following the system, track it live rather than until next reload.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (read() === 'system') apply('system');
  });
}
