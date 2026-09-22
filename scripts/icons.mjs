#!/usr/bin/env node
/**
 * Writes every icon file public/ ships, from one definition (#363). Owner-run
 * as `npm run icons`; the output is committed and tests/icons.test.ts pins it
 * to the current tokens, so a palette change fails a test until this is rerun.
 *
 * The letters are outlined from the real face rather than set as <text>: a
 * favicon renders outside the document, loads no webfont, and would fall back
 * to a system face in every browser.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { Resvg } from '@resvg/resvg-js';
import { readTokens } from '../src/lib/tokens-read.mjs';

const PUBLIC = new URL('../public/', import.meta.url);
const FONT = new URL(
  '../node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff',
  import.meta.url,
);

/**
 * The chamfer: 20 percent of a 64-unit edge, drawn at 13, cut from the top
 * left because platform masks eat corners and that is the one most of them
 * leave intact. Moving it is this one constant. The other three, also 20:
 *
 *   top-right     M0 0h51l13 13v51H0z
 *   bottom-right  M0 0h64v51L51 64H0z
 *   bottom-left   M0 0h64v64H13L0 51z
 */
const CHAMFER = 'M13 0h51v64H0V13z';

/** The handoff's letter geometry. The center sits one unit right of 32 to counterbalance the weight the chamfer removes. */
const SIZE = 34;
const TRACKING = -2;
const CENTER_X = 34;
const BASELINE = 45;

const { light, dark } = readTokens();

function lettersPath() {
  const bytes = readFileSync(FONT);
  const font = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const scale = SIZE / font.unitsPerEm;
  const glyphs = font.stringToGlyphs('RL');
  const kern = font.getKerningValue(glyphs[0], glyphs[1]) * scale;
  const advances = glyphs.map((glyph) => glyph.advanceWidth * scale);
  // SVG letter-spacing follows every glyph, the last one included, and
  // text-anchor="middle" centers that whole run. Reproduced here so the
  // outline lands where the handoff's <text> did.
  //
  // Checked 2026-09-22 against the handoff's screenshots/icon-dark.png: a
  // 256px render of this SVG (public/favicon-dark.svg) put the outlined pair
  // at the same rightward offset from center as the specimen (measured by
  // the black-pixel bounding box in each, ~5-6% of the square's width in
  // both), so the trailing `+ TRACKING` this comment already assumed is
  // correct for opentype.js plus resvg-js and needed no change.
  const width = advances[0] + kern + TRACKING + advances[1] + TRACKING;
  let x = CENTER_X - width / 2;
  return glyphs
    .map((glyph, i) => {
      const d = glyph.getPath(x, BASELINE, SIZE).toPathData(2);
      x += advances[i] + TRACKING + (i === 0 ? kern : 0);
      return d;
    })
    .join('');
}

const letters = lettersPath();

// Token names are written without their leading `--`: XML forbids `--` inside
// a comment, and a malformed SVG icon renders as nothing.
function icon(theme) {
  const ground = (theme === 'dark' ? dark : light)['--rl-bg'];
  const pink = dark['--rl-accent-ground'];
  const ink = dark['--rl-accent-on'];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="RL">',
    '<!-- Written by scripts/icons.mjs from src/styles/tokens.css. Edit the script and rerun it. -->',
    `<!-- ${ground} is rl-bg, ${theme} theme -->`,
    `<rect width="64" height="64" fill="${ground}"/>`,
    `<!-- ${pink} is rl-accent-ground -->`,
    `<path d="${CHAMFER}" fill="${pink}"/>`,
    `<!-- ${ink} is rl-accent-on -->`,
    `<path d="${letters}" fill="${ink}"/>`,
    '</svg>',
    '',
  ].join('\n');
}

const png = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

/** A PNG-framed ICO: a six-byte header, a sixteen-byte entry per frame, then the frames. */
function ico(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + 16 * frames.length;
  const entries = frames.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size, 0);
    entry.writeUInt8(size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...frames.map(({ data }) => data)]);
}

// Every raster comes from the dark variant: a raster cannot follow a theme,
// and the dark notch holds up against both browser chromes.
const darkSvg = icon('dark');
const write = (name, data) => writeFileSync(new URL(name, PUBLIC), data);
write('favicon-dark.svg', darkSvg);
write('favicon-light.svg', icon('light'));
write('favicon.ico', ico([16, 32].map((size) => ({ size, data: png(darkSvg, size) }))));
write('apple-touch-icon.png', png(darkSvg, 180));
write('icon-192.png', png(darkSvg, 192));
write('icon-512.png', png(darkSvg, 512));
console.log('icons: wrote six files to public/');
