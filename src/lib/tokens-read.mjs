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

/** @param {string} css @param {string} selector @returns {Record<string, string>} */
function block(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`tokens.css: no "${selector} {" block`);
  const body = css.slice(start, css.indexOf('}', start));
  const entries = [...body.matchAll(/(--rl-[a-z-]+):\s*(#[0-9a-f]{6});/g)];
  if (entries.length === 0) throw new Error(`tokens.css: "${selector}" declares no --rl-* hex`);
  return Object.fromEntries(entries.map(([, name, hex]) => [name, hex]));
}

/**
 * @param {string} [css] the file's text; read from disk when omitted
 * @returns {{ light: Record<string, string>, dark: Record<string, string> }}
 */
export function readTokens(css = readFileSync(TOKENS_CSS, 'utf8')) {
  return { light: block(css, ':root'), dark: block(css, "[data-theme='dark']") };
}
