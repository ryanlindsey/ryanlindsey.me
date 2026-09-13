/**
 * The mobile navigation takeover, rendered-markup layer (issue #101).
 *
 * What a server response can show: that the overlay ships in the HTML, that
 * it carries every link it is meant to, that the toggle names it, and that
 * nothing in it is a control pretending to be one. What it cannot show is the
 * focus trap, the scroll lock or the Esc key, which are the deliverable here
 * and are covered in tests/mobile-nav-behavior.test.ts against a DOM.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';
import { elementWith } from './markup';
import { NAV_LINKS } from '../src/lib/nav';

// See ./workers.ts for why the site Worker is booted from the build output and
// why the MCP Worker is always listed with it.
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

const html = async (path: string) => await (await server.fetch(path)).text();

/** The overlay element, depth-counted -- see ./markup.ts for why not a regex. */
const overlayOf = (page: string) => elementWith(page, 'div', 'id="rl-mobile-menu"');

test('the toggle names the overlay it controls, and starts collapsed', async () => {
  const page = await html('/');
  const toggle = /<button[^>]*aria-controls="rl-mobile-menu"[^>]*>/.exec(page);
  expect(toggle, 'no toggle wired to the overlay').not.toBeNull();
  expect(toggle![0]).toContain('aria-expanded="false"');
});

test('the overlay exists in the markup and carries the id the toggle names', async () => {
  // Server-rendered rather than built by script on first open: a menu that
  // does not exist until JavaScript runs is a menu a visitor without it
  // cannot reach, and every link in it is a real page.
  expect(await html('/')).toContain('id="rl-mobile-menu"');
});

test('the overlay carries every primary link, with Ask my agent marked as promoted', async () => {
  const overlay = overlayOf(await html('/'));
  for (const link of NAV_LINKS) expect(overlay).toContain(`href="${link.href}"`);
  // The design says the promotion in colour. Asserted because it is the one
  // thing in this overlay a restyle would quietly drop.
  expect(overlay).toMatch(/<a[^>]*href="\/chat"[^>]*class="[^"]*text-accent/);
});

test('the overlay repeats the demoted links rather than orphaning them', async () => {
  const overlay = overlayOf(await html('/'));
  for (const href of ['/ops', '/ai-policy', '/llms.txt', '/rss.xml']) {
    expect(overlay, `${href} is unreachable on mobile`).toContain(href);
  }
});

test('the close control is labelled, because ✕ is not a name', async () => {
  expect(await html('/')).toContain('aria-label="Close menu"');
});

test('the mobile search affordance is a label, not a control', async () => {
  const overlay = overlayOf(await html('/'));
  expect(overlay).not.toContain('<input');
  // The same rule the header's placeholder follows (tests/pages.test.ts):
  // site search is not built, so nothing here takes focus and nothing binds
  // the shortcut the chip advertises.
  expect(overlay).toContain('aria-hidden="true"');
  expect(await html('/')).not.toContain('metaKey');
});

test('both 44x44 hit targets are spelled at 44px, because the design floors them there', async () => {
  // `h-11 w-11` is Tailwind's 44px step, and the assertion is on the spelling
  // because the size IS the requirement -- the issue's words are "44px is the
  // minimum hit target and must not shrink". A rendered page cannot be
  // measured from here; what it can show is that nobody swapped the utility
  // for a smaller one.
  const page = await html('/');
  const toggle = /<button[^>]*aria-controls="rl-mobile-menu"[^>]*>/.exec(page)![0];
  expect(toggle).toMatch(/class="[^"]*\bh-11\b/);
  expect(toggle).toMatch(/class="[^"]*\bw-11\b/);

  const close = /<button[^>]*aria-label="Close menu"[^>]*>/.exec(page)![0];
  expect(close).toMatch(/class="[^"]*\bh-11\b/);
  expect(close).toMatch(/class="[^"]*\bw-11\b/);
});

test('the overlay carries the theme control, because the header hides it below lg', async () => {
  // A REGRESSION GUARD, not a new feature's test. Before this issue the right
  // cluster had no breakpoint on it, so the theme toggle rendered at every
  // width -- badly, crushed into a wrapping row, but it was there and it
  // worked. Putting the cluster behind `lg` took the only way to choose a
  // theme away from every phone, and issue #101's step 5 says in terms not to
  // put one in the overlay ("the design does not place one there, and
  // inventing a spot for it is out of scope"). Followed literally, that
  // instruction deletes a control. Raised on the pull request and overruled
  // there, which is why this test disagrees with the issue that asked for it.
  const overlay = overlayOf(await html('/'));
  expect(overlay).toContain('data-theme-toggle');
});

test('the page carries exactly two theme controls, one per header', async () => {
  // The desktop cluster's and the overlay's. Asserted because two is the
  // number that makes ThemeToggle's script have to paint every instance
  // rather than the one that was clicked -- see tests/theme-toggle.test.ts.
  // A third would mean a surface grew one without that being thought about.
  //
  // MATCHED ON THE BUTTON TAG, not on the bare attribute name. The first
  // version of this counted `/data-theme-toggle/g` and passed at RED against
  // a page carrying ONE button: Astro inlines the component's script, and
  // that script contains `querySelectorAll('[data-theme-toggle]')`, so the
  // string occurs twice with only one control on the page. The selector in
  // global.css's @media print block is a third occurrence waiting to happen
  // the day that stylesheet is inlined too.
  const page = await html('/');
  expect([...page.matchAll(/<button[^>]*data-theme-toggle/g)]).toHaveLength(2);
});

test('the overlay is a cut, so reduced motion has nothing to disable', async () => {
  // Required behaviour 5, confirmed rather than assumed. The motion budget
  // (05 §4, restated in the epic) spends one of its three moments here and
  // spends it on a cut: the overlay appears, it does not slide. So the
  // correct amount of transition on it is none, and a `transition-`,
  // `duration-` or `animate-` utility anywhere inside is the bug the issue
  // says to look for -- not something for a prefers-reduced-motion branch to
  // switch off.
  const overlay = overlayOf(await html('/'));
  expect(overlay).not.toMatch(/\b(transition|duration|animate)-/);
});
