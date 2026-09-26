import { readFileSync } from 'node:fs';
import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GATED_TOOL_NAMES } from '../workers/mcp/src/gated';
import { latestRelease } from '../src/lib/home/latest-release';
import { OPS_CACHE_KEYS } from '../src/lib/ops/reads';
import { BANNED_PATTERNS } from './candidacy-patterns';
import { elementWith, stripComments, stripTags } from './markup';
import { SITE_HARNESS_WORKERS } from './workers';

/**
 * The live system band on `/` (issue #437), and the server island behind it.
 *
 * `/` IS PRERENDERED AND THE FIVE FIGURES ARE NOT. The page ships the frame,
 * the release tile and a fallback with no figures in it; the figures come from
 * `/_server-islands/<id>`, which the page names in a `<link rel="preload">`.
 * So there are two documents to test, and the island's URL is read out of the
 * first rather than written here: the component id is Astro's to choose, and a
 * hard-coded one would test a URL the page never asks for.
 *
 * THE ISLAND IS FETCHED BEFORE THE MIGRATIONS FOR THE SAME REASON
 * tests/ops-page.test.ts fetches /ops then: with no tables behind it
 * `readOpsMetrics`'s batch rejects, which is the only genuine D1 failure this
 * harness can produce without a seam. `degraded` is what proves a failed read
 * renders its absence and never a `0`, and that the island still answers 200,
 * since a non-200 leaves the fallback standing rather than showing why.
 */
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

const LABELS = [
  'Public MCP tool calls',
  'Chat sessions',
  'Requests from agents',
  'Requests through the AI Gateway',
  'Requests that reached the Worker',
];

/** The harness's response type, which is undici's rather than the Workers global. */
type IslandResponse = Awaited<ReturnType<typeof server.fetch>>;

/** The prerendered home page, fetched before any table exists. */
let home: string;
/** The island's own path and query, as the home page preloads it. */
let islandUrl: string;
/** The island with no tables behind it. */
let degraded: IslandResponse;
let degradedHtml: string;
/** The island after one public tool call is recorded. */
let live: IslandResponse;
let liveHtml: string;
let kv: KVNamespace;

beforeAll(async () => {
  await server.listen();
  const site = server.getWorker<{ DB: D1Database; KV_CACHE: KVNamespace }>();

  home = await (await server.fetch('/')).text();
  // Relative to the origin, whatever host the page was built against, and with
  // the attribute escaping undone: `&` in the query arrives as `&amp;`.
  const preload = /<link rel="preload" as="fetch" href="([^"]*\/_server-islands\/[^"]*)"/.exec(
    home,
  );
  const href = new URL(
    (preload?.[1] ?? '/_server-islands/none').replaceAll('&amp;', '&'),
    'http://x',
  );
  islandUrl = `${href.pathname}${href.search}`;

  degraded = await server.fetch(islandUrl);
  degradedHtml = await degraded.text();

  await site.applyD1Migrations('DB');
  const env = await site.getEnv();
  kv = env.KV_CACHE;
  await env.DB.prepare(
    `INSERT INTO mcp_tool_calls (called_at, tool, args_hash, tier, audience, outcome, duration_ms)
     VALUES (?, 'get_resume', 'h', 'public', NULL, 'ok', 12)`,
  )
    .bind(new Date().toISOString())
    .run();
  // The degraded read wrote nothing (a rejection leaves `cached` before its
  // `put`), so this delete is a guard rather than a fix: it makes `live` a
  // fresh D1 read whatever the order of the tests above ever becomes.
  await kv.delete(OPS_CACHE_KEYS.metrics);

  live = await server.fetch(islandUrl);
  liveHtml = await live.text();
});

afterAll(async () => {
  await server.close();
});

/** One element carrying `attribute="value"`, whole, nesting included. */
function cell(doc: string, attribute: string, value: string): string {
  return elementWith(doc, 'div', `${attribute}="${value}"`);
}

/** A cell's visible text, whitespace collapsed. */
function text(markup: string): string {
  return stripTags(stripComments(markup)).replace(/\s+/g, ' ').trim();
}

/** The figure a band tile shows, or its absence. */
function figure(doc: string, label: string): string {
  const tile = cell(doc, 'data-band-figure', label);
  const value = /data-metric-value[^>]*>([^<]*)</.exec(tile);
  expect(value, `${label} renders no data-metric-value`).not.toBeNull();
  return value![1].trim();
}

describe('the system band on /', () => {
  test('preloads its island', () => {
    expect(home).toMatch(/<link rel="preload" as="fetch" href="[^"]*\/_server-islands\//);
  });

  test('sits between the Now strip and the lead story', () => {
    const now = home.indexOf('data-now-strip');
    const band = home.indexOf('data-system-band');
    const lead = home.indexOf('data-lead-story');
    expect(now).toBeGreaterThan(-1);
    expect(band).toBeGreaterThan(now);
    expect(lead).toBeGreaterThan(band);
  });

  test('the release tile names the first release in CHANGELOG.md, by date only', () => {
    const release = latestRelease(readFileSync('CHANGELOG.md', 'utf8'));
    expect(release).not.toBeNull();
    const tile = elementWith(home, 'div', 'data-release-tile');
    expect(tile).toContain(release!.version);
    expect(tile).toContain(release!.date);
    expect(tile).toContain(`href="${release!.url}"`);
    expect(tile).not.toMatch(/T\d{2}:/);
  });

  test('the fallback carries the five labels and no figure', () => {
    const fallbacks = home.match(/data-band-fallback="/g) ?? [];
    expect(fallbacks).toHaveLength(5);
    for (const label of LABELS) {
      const fallback = cell(home, 'data-band-fallback', label);
      expect(text(fallback)).toBe(label);
      expect(text(fallback)).not.toMatch(/\d/);
    }
  });

  test('says, under the grid, where the figures always are', () => {
    const note = elementWith(home, 'p', 'data-band-note');
    expect(note).toContain('href="/ops#live-metrics"');
    expect(text(note)).toBe(
      'The live figures, and the system each one is read from, are always on the ops page.',
    );
    // Outside the island, so the swap cannot remove it.
    const band = elementWith(home, 'section', 'data-system-band');
    expect(band.indexOf('data-band-note')).toBeGreaterThan(band.indexOf('data-release-tile'));
    expect(degradedHtml).not.toContain('data-band-note');
  });

  test('links to every figure on /ops', () => {
    const links = elementWith(home, 'div', 'data-system-band-links');
    expect(links).toContain('href="/ops#live-metrics"');
    expect(text(links)).toContain('All figures');
  });

  test('carries no <h1> of its own, and the page keeps exactly one <main>', () => {
    const band = elementWith(home, 'section', 'data-system-band');
    expect(band).not.toMatch(/<h1[\s>]/);
    expect(band).toContain('id="system-band-heading"');
    expect(home.match(/<main[\s>]/g) ?? []).toHaveLength(1);
  });
});

describe('the island', () => {
  test('answers 200 with every tile absent when D1 cannot be read, never 0', () => {
    expect(degraded.status).toBe(200);
    expect(degraded.headers.get('cache-control')).toBe('public, max-age=60');
    expect(degraded.headers.get('x-robots-tag')).toBe('noindex');
    expect(degradedHtml.match(/data-band-figure="/g) ?? []).toHaveLength(5);
    for (const label of LABELS) {
      const tile = cell(degradedHtml, 'data-band-figure', label);
      expect(figure(degradedHtml, label), label).toBe('not available');
      expect(tile, label).not.toContain('>0<');
    }
  });

  test('is cached for as long as /ops and kept out of the index', () => {
    expect(live.headers.get('cache-control')).toBe('public, max-age=60');
    expect(live.headers.get('x-robots-tag')).toBe('noindex');
  });

  test('counts a public tool call, and says the two unread systems are unavailable', () => {
    expect(figure(liveHtml, 'Public MCP tool calls')).toBe('1');
    for (const label of [
      'Requests from agents',
      'Requests that reached the Worker',
      'Requests through the AI Gateway',
    ]) {
      expect(figure(liveHtml, label), label).toBe('not available');
    }
  });

  test('names the gateway tile the same way /ops does', async () => {
    const ops = await (await server.fetch('/ops')).text();
    expect(ops).toContain('data-ops-metric="Requests through the AI Gateway"');
    expect(ops).not.toContain('Requests through the gateway');
    expect(liveHtml).toContain('data-band-figure="Requests through the AI Gateway"');
  });

  test('does not serve an entry written under the previous cache key', async () => {
    // The shape tests/ops-page.test.ts plants, for the same reason: a figure
    // D1 does not hold, so seeing it can only mean the old key was read.
    await kv.delete(OPS_CACHE_KEYS.metrics);
    await kv.put(
      'ops:metrics:v3',
      JSON.stringify({
        windowDays: 30,
        toolCalls: [{ tool: 'get_resume', calls: 4242 }],
        chatSessions: 0,
        chatTurns: 0,
        fitRuns: { started: 0, reports: 0, failed: 0, inProgress: 0, abandoned: 0 },
        evalRuns: [],
      }),
      { expirationTtl: 60 },
    );
    const response = await server.fetch(islandUrl);
    const after = await response.text();
    expect(response.status).toBe(200);
    expect(after).not.toContain('4,242');
    // The D1 row planted in setup, so the fresh read is what won.
    expect(figure(after, 'Public MCP tool calls')).toBe('1');
  });

  test('reads the same cache entry /ops reads', async () => {
    await kv.put(
      OPS_CACHE_KEYS.metrics,
      JSON.stringify({
        windowDays: 30,
        toolCalls: [{ tool: 'get_resume', calls: 7777 }],
        chatSessions: 0,
        chatTurns: 0,
        fitRuns: { started: 0, reports: 0, failed: 0, inProgress: 0, abandoned: 0 },
        evalRuns: [],
      }),
      { expirationTtl: 60 },
    );
    const island = await (await server.fetch(islandUrl)).text();
    const ops = await (await server.fetch('/ops')).text();
    expect(figure(island, 'Public MCP tool calls')).toBe('7,777');
    expect(ops).toContain('7,777');
  });

  test('names no gated tool, no corpus and no candidacy vocabulary', () => {
    for (const doc of [home, liveHtml]) {
      for (const name of GATED_TOOL_NAMES) expect(doc, name).not.toContain(name);
      expect(doc).not.toMatch(/corpus/i);
      for (const pattern of BANNED_PATTERNS) expect(doc).not.toMatch(pattern);
    }
  });
});

describe('/index.md', () => {
  test('points at /ops for the live figures and prints none of them', async () => {
    const markdown = await (await server.fetch('/index.md')).text();
    const start = markdown.indexOf('## Live figures');
    expect(start).toBeGreaterThan(-1);
    const next = markdown.indexOf('\n## ', start + 1);
    const section = markdown.slice(start, next === -1 ? undefined : next);
    expect(section).toContain('https://ryanlindsey.me/ops');
    expect(section).not.toMatch(/\d/);
  });
});
