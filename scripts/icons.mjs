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
import { readTokens, requireTokens } from '../src/lib/tokens-read.mjs';

const PUBLIC = new URL('../public/', import.meta.url);
const FONT = new URL(
  '../node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff',
  import.meta.url,
);

/**
 * A plain square. The handoff cut a chamfer from the top-left corner, and the
 * corner it left behind had to be painted in one theme's ground or left
 * transparent; both read as a mistake in a tab strip (2026-09-24), so the
 * corner went.
 */
const GROUND = 'M0 0h64v64H0z';

/**
 * The letter size. The handoff drew them at 34, about 24 units of cap height,
 * and in Safari's 16-point tab that read as a smudge even on a 5K display
 * (2026-09-24); 50 filled the square too far. The pair is centered on its own
 * outline rather than on its advance widths, so the ink sits in the middle of
 * the square whatever the glyphs' side bearings are.
 */
const SIZE = 44;
const TRACKING = -2;

// requireTokens throws naming whichever key is missing, rather than letting
// icon() below read an absent one as `undefined` and draw a corner or a
// letter in no color at all.
const { dark } = readTokens();
requireTokens(dark, ['--rl-accent-ground', '--rl-ink']);

function lettersPath() {
  const bytes = readFileSync(FONT);
  const font = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const scale = SIZE / font.unitsPerEm;
  const glyphs = font.stringToGlyphs('RL');
  const kern = font.getKerningValue(glyphs[0], glyphs[1]) * scale;
  const advances = glyphs.map((glyph) => glyph.advanceWidth * scale);
  // Laid out once at the origin to measure the ink, then again offset so the
  // outline's bounding box sits on the square's center.
  const layout = (dx, dy) => {
    let x = dx;
    return glyphs.map((glyph, i) => {
      const path = glyph.getPath(x, dy, SIZE);
      x += advances[i] + TRACKING + (i === 0 ? kern : 0);
      return path;
    });
  };
  const boxes = layout(0, 0).map((path) => path.getBoundingBox());
  const x1 = Math.min(...boxes.map((box) => box.x1));
  const x2 = Math.max(...boxes.map((box) => box.x2));
  const y1 = Math.min(...boxes.map((box) => box.y1));
  const y2 = Math.max(...boxes.map((box) => box.y2));
  return layout(32 - (x1 + x2) / 2, 32 - (y1 + y2) / 2)
    .map((path) => path.toPathData(2))
    .join('');
}

const letters = lettersPath();

// Token names are written without their leading `--`: XML forbids `--` inside
// a comment, and a malformed SVG icon renders as nothing.
//
// Until 2026-09-24 there were two SVGs, one per site theme, and a script
// swapping them (#374). That swap removed and re-inserted the icon link during
// load, and Safari answered by showing no icon on the home page. A pink square
// with white letters reads on either chrome, so one static file serves both
// themes and nothing has to swap.
function icon() {
  const pink = dark['--rl-accent-ground'];
  const ink = dark['--rl-ink'];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="RL">',
    '<!-- Written by scripts/icons.mjs from src/styles/tokens.css. Edit the script and rerun it. -->',
    `<!-- ${pink} is rl-accent-ground -->`,
    `<path d="${GROUND}" fill="${pink}"/>`,
    `<!-- ${ink} is rl-ink, dark theme -->`,
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

// Every file is the same square, so every raster comes from the one SVG.
const svg = icon();
const write = (name, data) => writeFileSync(new URL(name, PUBLIC), data);
write('favicon.svg', svg);
write('favicon.ico', ico([16, 32].map((size) => ({ size, data: png(svg, size) }))));
write('apple-touch-icon.png', png(svg, 180));
write('icon-192.png', png(svg, 192));
write('icon-512.png', png(svg, 512));
console.log('icons: wrote five files to public/');
