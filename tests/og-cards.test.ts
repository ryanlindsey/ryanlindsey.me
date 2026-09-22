/**
 * The share cards (#363): what a card says, where it is written, and that the
 * build leaves exactly the PNGs behind and none of the state that made them.
 *
 * The unit half runs against src/lib/og directly. The build half reads
 * dist/client, so like every harness suite it needs `npm run build` first.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import {
  CHAT_CARD,
  HOME_CARD,
  OPS_CARD,
  cardAlt,
  cardPath,
  contentCard,
  type OgCard,
} from '../src/lib/og/cards';
import { TITLE_FLOOR, TITLE_MAX_CHARS, titleSize } from '../src/lib/og/layout';
import { loadCardAssets, renderCard } from '../src/lib/og/render';
import { standfirstSchema } from '../src/lib/og/standfirst';
import { readingTimeFor } from '../src/lib/reading-time';
import { SITE_HARNESS_WORKERS } from './workers';

const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

const OG_DIR = new URL('../dist/client/og/', import.meta.url);
const ROOT = new URL('../', import.meta.url);

const pngSize = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

function builtCards(dir = OG_DIR): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? builtCards(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)],
  );
}

const post = (title: string, standfirst?: string) =>
  contentCard('post', { id: 'example', body: 'word '.repeat(700), data: { title, standfirst } });

test('a card path is content-addressed under /og', async () => {
  const path = await cardPath(post('A title'));
  expect(path).toMatch(/^\/og\/writing\/example\.[0-9a-f]{8}\.png$/);
  expect(await cardPath(post('A title'))).toBe(path);
});

test('editing what a card says moves its path', async () => {
  const before = await cardPath(post('A title'));
  expect(await cardPath(post('A retitled title'))).not.toBe(before);
  expect(await cardPath(post('A title', 'Now with a standfirst.'))).not.toBe(before);
});

test('a content card carries its kind, its reading time and no invented standfirst', () => {
  const card = post('A title');
  expect(card).toMatchObject({
    variant: 'article',
    kicker: 'ARTICLE',
    footerLeft: '//ryanlindsey.me',
  });
  expect(card.footerRight).toBe(`${readingTimeFor('word '.repeat(700)).minutes} MIN READ`);
  expect(card).not.toHaveProperty('standfirst');
  const study = contentCard('case-study', { id: 'x', data: { title: 'T' } });
  expect(study).toMatchObject({ key: 'work/x', variant: 'case-study', kicker: 'CASE STUDY' });
});

test('the alt text is the card in words', () => {
  expect(cardAlt(post('A title', 'A standfirst.'))).toBe('A title. A standfirst.');
  expect(cardAlt(post('Is it?', 'Yes.'))).toBe('Is it? Yes.');
  expect(cardAlt(post('A title'))).toBe('A title');
});

test('a long title steps down, and never below the floor', () => {
  expect(TITLE_FLOOR).toBe(64);
  expect(titleSize(post('Short'))).toBe(84);
  expect(titleSize(post('x'.repeat(300)))).toBe(TITLE_FLOOR);
  for (const card of [HOME_CARD, CHAT_CARD, OPS_CARD]) {
    expect(titleSize(card)).toBeGreaterThanOrEqual(TITLE_FLOOR);
  }
});

/**
 * Reads every `.mdx` entry's frontmatter `title:` line under
 * `src/content/<dir>`, stripping the surrounding YAML quotes a title with a
 * colon in it needs (silent-failure.mdx's title is one). Drafts included:
 * a draft's card renders from the same layout as a published one.
 */
function contentTitles(dir: 'posts' | 'caseStudies'): { name: string; title: string }[] {
  const base = new URL(`../src/content/${dir}/`, import.meta.url);
  return readdirSync(base)
    .filter((name) => name.endsWith('.mdx'))
    .map((name) => {
      const source = readFileSync(new URL(name, base), 'utf8');
      const match = source.match(/^title:\s*(.*)$/m);
      if (!match) throw new Error(`${dir}/${name}: no "title:" line in frontmatter`);
      let title = match[1].trim();
      if (
        (title.startsWith("'") && title.endsWith("'")) ||
        (title.startsWith('"') && title.endsWith('"'))
      ) {
        title = title.slice(1, -1);
      }
      return { name, title };
    });
}

test('no real title is long enough for its share card to clip it', () => {
  for (const { name, title } of [...contentTitles('posts'), ...contentTitles('caseStudies')]) {
    expect(
      title.length,
      `${name}: title is ${title.length} characters ("${title}"), over TITLE_MAX_CHARS ` +
        `(${TITLE_MAX_CHARS}) -- its share card will clip this title with an ellipsis at ` +
        `TITLE_FLOOR. Shorten the title.`,
    ).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  }
});

test('the standfirst is capped at 140 characters', () => {
  expect(standfirstSchema.safeParse('x'.repeat(140)).success).toBe(true);
  expect(standfirstSchema.safeParse('x'.repeat(141)).success).toBe(false);
  expect(standfirstSchema.safeParse(undefined).success).toBe(true);
});

test('the longest title the layout allows still renders at 1200 by 630', async () => {
  const assets = loadCardAssets(ROOT);
  const card: OgCard = post('word '.repeat(40).trim(), 'x '.repeat(70).trim());
  expect(pngSize(await renderCard(card, assets))).toEqual([1200, 630]);
});

test('the build leaves one 1200 by 630 PNG per card and no manifest', () => {
  expect(existsSync(new URL('cards.json', OG_DIR))).toBe(false);
  const cards = builtCards();
  const entries = (dir: string) =>
    readdirSync(new URL(`../src/content/${dir}/`, import.meta.url)).filter((name) =>
      name.endsWith('.mdx'),
    ).length;
  // Home, chat, ops and the résumé, plus one per entry, drafts included.
  expect(cards).toHaveLength(4 + entries('posts') + entries('caseStudies'));
  for (const card of cards) {
    expect(card.pathname).toMatch(/\.[0-9a-f]{8}\.png$/);
    expect(pngSize(readFileSync(card)), card.pathname).toEqual([1200, 630]);
  }
});

test('the fixed cards are written where their pages will name them', async () => {
  for (const card of [HOME_CARD, CHAT_CARD, OPS_CARD]) {
    expect(existsSync(new URL(`../dist/client${await cardPath(card)}`, import.meta.url))).toBe(
      true,
    );
  }
});

test('a card is served for a year, and the manifest is not served at all', async () => {
  const response = await server.fetch(await cardPath(HOME_CARD));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^image\/png/);
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect((await server.fetch('/og/cards.json')).status).toBe(404);
});

/**
 * The pages with a fixed card name that card, not the home card they would
 * fall back to. Asserted by path, because a page that forgot its prop would
 * still carry a valid, served image and pass every sweep in tests/seo.test.ts.
 */
test.each([
  ['/chat/', CHAT_CARD],
  ['/ops/', OPS_CARD],
  ['/search/', HOME_CARD],
  ['/writing/', HOME_CARD],
  ['/', HOME_CARD],
])('%s names its card', async (path, card) => {
  const html = await (await server.fetch(path)).text();
  expect(html).toContain(`content="https://ryanlindsey.me${await cardPath(card)}"`);
  expect(html).toContain(`property="og:image:alt" content="${cardAlt(card)}"`);
});

test('/resume names the résumé card and every post names its own', async () => {
  const resume = await (await server.fetch('/resume/')).text();
  expect(resume).toMatch(/content="https:\/\/ryanlindsey\.me\/og\/resume\.[0-9a-f]{8}\.png"/);
  const post = await (await server.fetch('/writing/armature/')).text();
  expect(post).toMatch(
    /content="https:\/\/ryanlindsey\.me\/og\/writing\/armature\.[0-9a-f]{8}\.png"/,
  );
  const study = await (await server.fetch('/work/silent-failure/')).text();
  expect(study).toMatch(
    /content="https:\/\/ryanlindsey\.me\/og\/work\/silent-failure\.[0-9a-f]{8}\.png"/,
  );
});
