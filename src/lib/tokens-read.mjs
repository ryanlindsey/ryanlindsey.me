import { readFileSync } from 'node:fs';

/**
 * The palette as src/styles/tokens.css declares it, for the two places that
 * need hex values outside the page's cascade (#363): the icon generator,
 * because an SVG loaded as rel="icon" cannot read the document's custom
 * properties, and the share-card renderer, because a PNG rasterized in Node
 * has no cascade at all. Both read the file rather than restate it, so the
 * token file stays the one place a color is written.
 *
 * Plain `.mjs` for the reason src/lib/unindexed-routes.mjs is: a node script
 * imports it with no build step in between.
 *
 * `css` is a parameter because the card integration runs inside Astro's config
 * loader, where this module's own `import.meta.url` is not a promise worth
 * resting on; it reads the file from the project root and passes it in.
 */
const TOKENS_CSS = new URL('../styles/tokens.css', import.meta.url);

/**
 * Locates one `selector { ... }` block and returns every `--rl-*` declaration
 * inside it, lowercased.
 *
 * `opener` is a RegExp rather than a literal string, matching the pattern
 * tests/tokens.test.ts already uses to find `[data-theme='dark']`: Prettier
 * normalizes a stylesheet's own quote style, so a literal `[data-theme='dark']
 * {` search can go stale on a reformat that this file never asked for. The
 * `:root` opener stays quote-tolerant too, for the same reason and so both
 * callers share one code path rather than one being the exception.
 *
 * EVERY VALUE IS VALIDATED, not merely captured. FOUND BY THE #364 FINAL
 * WHOLE-BRANCH REVIEW, 2026-09-22: the original version of this function
 * matched `#[0-9a-f]{6}` directly in its capture group, which is silent-drop
 * rather than a check. An uppercase hex (`#FF2D95`), which tests/tokens.test.ts
 * accepts as a value, simply failed to match and the token vanished from the
 * returned object rather than raising anything. loadCardAssets and
 * scripts/icons.mjs then read the missing key as `undefined`, and Satori
 * renders `background: undefined` as nothing and `color: undefined` as
 * black -- a share card or an icon silently wrong in a way no build step
 * caught, though nothing in src/styles/tokens.css has ever declared an
 * uppercase value, so this was a defect never actually triggered. Throwing on
 * a non-hex value, and lowercasing what is accepted, closes that gap for
 * every future token rather than only for the case found here.
 *
 * @param {string} css
 * @param {RegExp} opener matches up to (not including) the selector's `{`
 * @param {string} label the selector, for error messages
 * @returns {Record<string, string>}
 */
function block(css, opener, label) {
  const found = css.match(opener);
  if (!found) throw new Error(`tokens.css: no "${label} {" block`);
  const open = css.indexOf('{', found.index);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out = {};
  for (const [, name, rawValue] of body.matchAll(/(--rl-[a-z0-9-]+):\s*([^;]+);/g)) {
    const value = rawValue.trim();
    if (!/^#[0-9a-f]{6}$/i.test(value)) {
      throw new Error(
        `tokens.css: "${label}" declares ${name} as "${value}", which is not a 6-digit hex color`,
      );
    }
    out[name] = value.toLowerCase();
  }
  if (Object.keys(out).length === 0)
    throw new Error(`tokens.css: "${label}" declares no --rl-* hex`);
  return out;
}

/**
 * @param {string} [css] the file's text; read from disk when omitted
 * @returns {{ light: Record<string, string>, dark: Record<string, string> }}
 */
export function readTokens(css = readFileSync(TOKENS_CSS, 'utf8')) {
  return {
    // `:root` followed by whitespace-then-brace, so it cannot match the
    // `:root:not([data-theme='light'])` selector inside the no-JS media query
    // (same reasoning as tests/tokens.test.ts's copy of this pattern).
    light: block(css, /:root\s*\{/, ':root'),
    dark: block(css, /\[data-theme=['"]dark['"]\]\s*\{/, "[data-theme='dark']"),
  };
}

/**
 * Throws unless `palette` carries every name in `keys`. `block()` above only
 * guarantees the SHAPE of what tokens.css declares -- a `--rl-*` name mapped
 * to a valid hex -- not that any particular name a caller reads is present.
 * A renamed or deleted token would otherwise reach loadCardAssets
 * (src/lib/og/render.ts) or scripts/icons.mjs as a plain JavaScript
 * `undefined`, which is exactly the silent failure this module's header
 * comment on `block()` describes for a bad hex value, just reached from the
 * other direction.
 *
 * @param {Record<string, string>} palette
 * @param {readonly string[]} keys
 * @returns {Record<string, string>} `palette`, unchanged, for chaining at the call site
 */
export function requireTokens(palette, keys) {
  for (const key of keys) {
    if (!(key in palette)) throw new Error(`tokens.css: missing required token "${key}"`);
  }
  return palette;
}
