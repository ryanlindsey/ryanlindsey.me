import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SITE_HARNESS_WORKERS } from './workers';
import { BANNED_PATTERNS } from './candidacy-patterns';

/**
 * The public /ops page (06 §1), rendered by the real Worker against a real D1.
 *
 * TWO RENDERS ARE CAPTURED HERE, AND THE ORDER IS THE MECHANISM RATHER THAN AN
 * ACCIDENT OF SETUP. The first fetch happens BEFORE `applyD1Migrations`, so the
 * four tables `readOpsMetrics` reads do not exist and its `db.batch` rejects --
 * which is the only way this repo can produce a genuine D1 failure without a
 * seam, and it is the exact failure a public page must not answer with a 500.
 * `readOpsMetrics` returns `Promise<OpsMetrics>` and has no internal try (its
 * signature is not this task's to change), so the degradation has to live at
 * the page, and `degraded` below is what proves it does.
 *
 * The second fetch, after the migrations and after a PRIVATE-TIER row is
 * planted, is what every other assertion reads. The planted row is what makes
 * the leak assertions mean something: without it they would pass against a page
 * that renders every column of an empty table.
 *
 * THE ORDER ALSO PINS THE CACHE. /ops caches each of its three reads under its
 * OWN KV key for 60 seconds (`ops:metrics:v1`, `ops:traffic:v1`,
 * `ops:spend:v1`), so if the failed metrics read had been stored, the second
 * fetch would still be showing "could not be read" a minute later -- a
 * transient D1 blip pinned as a state. It is not stored because `cached`
 * (src/lib/ops/cache.ts) awaits its `fn` before it writes anything, so a
 * rejection leaves that function before the `put`. An earlier version of this
 * paragraph credited the page's `try` sitting OUTSIDE `cached` for that, which
 * is not a cause: the `put` is skipped wherever the caller's catch sits, and
 * the placement buys the page a labelled absence instead of a 500, which is a
 * different property. The "not pinned" test below is the assertion for the
 * cache half, and it only works because the degraded render came first.
 */
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

/** The render with no tables behind it. */
let degraded: string;
/** The render every other test reads. */
let html: string;

beforeAll(async () => {
  await server.listen();
  // The type argument goes on `getWorker`, not on `getEnv` -- `getEnv()` takes
  // none (wrangler-dist/cli.d.ts). Same note as tests/ops-metrics.test.ts.
  const site = server.getWorker<{ DB: D1Database }>();

  // FIRST, while `mcp_tool_calls` and friends still do not exist.
  degraded = await (await server.fetch('/ops')).text();

  await site.applyD1Migrations('DB');
  const db = (await site.getEnv()).DB;
  // A private-tier row, planted so the assertions below are testing a filter
  // that had something to filter. Without it they pass vacuously.
  await db
    .prepare(
      `INSERT INTO mcp_tool_calls (called_at, tool, args_hash, tier, audience, outcome, duration_ms)
       VALUES (?, 'analyze_fit', 'h', 'private', 'label-a', 'ok', 900)`,
    )
    .bind(new Date().toISOString())
    .run();
  html = await (await server.fetch('/ops')).text();
});

afterAll(async () => {
  await server.close();
});

/**
 * The markup of the one element carrying `attribute="value"`.
 *
 * By a declared hook rather than by slicing on class names: an assertion keyed
 * on `class="border-t border-rule pt-3"` would start passing vacuously the next
 * time a margin changes, which is the failure mode that made the original
 * version of the analytics test meaningless. Neither hooked element nests a
 * `<div>`, so the first `</div>` after the hook is its own.
 */
function hooked(attribute: string, value: string, doc: string): string {
  const hook = doc.indexOf(`${attribute}="${value}"`);
  expect(hook, `nothing on the page carries ${attribute}="${value}"`).toBeGreaterThan(-1);
  return doc.slice(doc.lastIndexOf('<div', hook), doc.indexOf('</div>', hook));
}

/** One `OpsMetric` tile's markup, looked up by its label. */
function tile(label: string, doc: string = html): string {
  return hooked('data-ops-metric', label, doc);
}

/** One Analytics Engine breakdown list's markup, looked up by its title. */
function breakdown(title: string, doc: string = html): string {
  return hooked('data-ops-breakdown', title, doc);
}

/** One `<li>` of a definition list, looked up by the text in it. */
function row(text: string): string {
  const at = html.indexOf(text);
  expect(at, `no row contains ${text}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<li', at), html.indexOf('</li>', at));
}

describe('/ops', () => {
  test('renders all six sections 06 §1 names', () => {
    for (const heading of [
      'Architecture',
      'Live metrics',
      'Model &amp; cost',
      'Evals',
      'Status &amp; degradation',
      'Changelog',
    ]) {
      expect(html).toContain(heading);
    }
  });

  test('no gated tool name and no audience label reaches the page', () => {
    expect(html).not.toContain('analyze_fit');
    expect(html).not.toContain('label-a');
    expect(html).not.toContain('get_application_narrative');
    // `judge_answer` joins the list with the "Eval judging" row below it: that
    // row names the judge's MODEL, which is a constant in a public file, and
    // the tool name is the separate thing that would say which scoped surface
    // exists (09 §2). The row is the one edit that made naming it tempting.
    expect(html).not.toContain('judge_answer');
  });

  test('no copy on the page matches a banned pattern', () => {
    for (const pattern of BANNED_PATTERNS) expect(html).not.toMatch(pattern);
  });

  test('an unconfigured analytics section says so instead of showing a zero', () => {
    // RLME_ANALYTICS_MODE is 'stub' under the harness, so readAnalytics is null.
    //
    // ASSERTED PER TILE, WHICH THE BRIEF'S VERSION WAS NOT, and the difference
    // is the whole value of the test. That version was
    // `not.toMatch(/0 agents served/i)` beside `toMatch(/not configured/i)`, and
    // NEITHER HALF COULD FAIL for these three figures: the page never renders
    // the words "agents served" anywhere, and "not configured" would still be
    // found on the three AI Gateway tiles even if all three Analytics Engine
    // figures regressed to `?? 0`. So the property 06 §1 calls an invisible lie
    // had no failing assertion behind it.
    //
    // THOSE GATEWAY TILES ARE NOT "PERMANENTLY NULL", which is what this
    // comment used to call them and what they were while `readSpend` returned
    // `null` unconditionally. It now reads the AI Gateway's GraphQL API; they
    // are null HERE for the same reason the Analytics Engine ones are, namely
    // that `RLME_ANALYTICS_MODE` is 'stub' under this harness. The point about
    // the old assertion is unchanged -- a tile that is null for its own reasons
    // still cannot witness a regression in a different tile.
    //
    // `data-numeric` is the mechanism: `OpsMetric` puts that attribute on the
    // figure paragraph and on nothing else, so its presence in a tile means a
    // number was rendered there. MEASURED against a deliberate `?? 0` on
    // `traffic?.requests` (fix round 1): red on the requests tile, and green
    // again on revert.
    for (const label of [
      'Requests that reached the Worker',
      'Requests from agents',
      'Median Worker time per request',
    ]) {
      const metric = tile(label);
      expect(metric, `${label} must render its absence`).toContain('not configured');
      expect(metric, `${label} must name the missing credential`).toContain(
        'Analytics Engine — this needs the read-only analytics token',
      );
      expect(metric, `${label} must not render a figure at all`).not.toContain('data-numeric');
    }
  });

  test('the traffic breakdowns say they are unread rather than rendering as empty', () => {
    // The two Analytics Engine lists /ops added when it stopped paying for two
    // queries it never rendered. A breakdown that simply VANISHED on a failed
    // read would be indistinguishable from one with nothing in it -- the
    // invisible zero in list form -- so each one renders the same absence
    // wording, and the same named cause, as the metric tiles beside it.
    //
    // `data-numeric` is the mechanism again: it is on the count in each row and
    // nowhere else in these lists, so its presence means a row was rendered.
    for (const title of ['By agent', 'By route class']) {
      const list = breakdown(title);
      expect(list, `${title} must render its absence`).toContain('not configured');
      expect(list, `${title} must name the missing credential`).toContain(
        'Analytics Engine — this needs the read-only analytics token',
      );
      expect(list, `${title} must not render a row`).not.toContain('data-numeric');
    }
  });

  test('the changelog shows dates and never a time', () => {
    const changelog = html.slice(html.indexOf('Changelog'));
    expect(changelog).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(changelog).not.toMatch(/\d{2}:\d{2}/);
  });

  test('every model in use is named, from the constants rather than by hand', () => {
    expect(html).toContain('anthropic/claude-sonnet-5');
    expect(html).toContain('anthropic/claude-opus-5');
    expect(html).toContain('@cf/qwen/qwen3-embedding-0.6b');
    // THE JUDGE ROW, which the three assertions above cannot see: `JUDGE_MODEL`
    // is the same string as `CHAT_MODEL` today, so dropping the row would leave
    // all three green while the page named three of the four models the site
    // calls. The judge is a real deployed call site, not a spare constant --
    // the `chat` and `leak` eval suites score through it, and this page
    // publishes their pass rates two sections further down.
    expect(html).toContain('Eval judging');
  });

  test('the retention windows on the page are the ones the cron enforces', () => {
    expect(html).toContain('30 days');
    expect(html).toContain('1 year');
    // PINNED TO THEIR OWN ROWS, because the two assertions above are weaker than
    // they look: the "Last 30 days" eyebrow over the metrics grid satisfies
    // `toContain('30 days')` on its own, so the retention list could break
    // entirely and half of this test would still pass. Each window is checked
    // against the thing it is a window FOR.
    expect(row('Chat questions and answers')).toContain('30 days');
    expect(row('The MCP audit log')).toContain('1 year');
    expect(row('Stored analysis reports')).toContain('1 year');
  });

  test('the architecture diagram is inline SVG using currentColor, not an image', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('currentColor');
    expect(html).not.toMatch(/<img[^>]+architecture/i);
  });

  test('the page is not cached by an intermediary for longer than the data is fresh', async () => {
    const response = await server.fetch('/ops');
    expect(response.headers.get('cache-control')).toContain('max-age=60');
  });

  /**
   * Ruling 2. `readOpsMetrics` can reject -- D1 has outages, and this page is
   * public and linked -- and an unhandled rejection here is a 500 on the one
   * page whose premise is that it tells you what it knows. "Absent is a state,
   * not a zero" has to hold for the uncredentialed half too, so the page
   * catches and renders the same labelled cannot-say state it uses for a
   * missing analytics token, with its own wording: the token is not what is
   * missing here.
   */
  test('a D1 failure degrades to a labelled absence rather than a 500', async () => {
    expect(degraded).toContain('Live metrics');
    // Never a zero standing in for a number nobody could read, which is the
    // failure that is invisible to a reader -- asserted PER TILE, through the
    // same `data-numeric` mechanism the Analytics Engine test uses. This test
    // used to carry `not.toMatch(/0 agents served/i)` here as well, which was
    // the same dead assertion fix round 1 removed from its sibling: the page
    // renders those words nowhere, so nothing could ever have failed it. Every
    // D1 figure is checked instead, and each one names D1 rather than the
    // analytics token as the thing that is missing.
    for (const label of [
      'Public MCP tool calls',
      'Chat sessions',
      'Chat turns',
      'Fit analyses run',
    ]) {
      const metric = tile(label, degraded);
      expect(metric, `${label} must render its absence`).toContain('not available');
      expect(metric, `${label} must blame D1, not the credential`).toContain(
        'D1 — the metrics store could not be read',
      );
      expect(metric, `${label} must not render a figure at all`).not.toContain('data-numeric');
    }
    // And never the exception itself. A stack trace on a public page is both a
    // worse answer and a disclosure.
    expect(degraded).not.toMatch(/D1_ERROR|no such table/i);
  });

  test('the degraded render is not pinned in the cache once D1 answers again', () => {
    // The exact absence sentence, not a loose /could not be read/: the page's
    // own intro explains that a figure it cannot read says so, and matching
    // that prose would make this test green for the wrong reason.
    expect(html).not.toContain('the metrics store could not be read');
  });

  /**
   * 06 §1's headline figure is partial by construction: the home page and every
   * static sub-resource are served without a Worker invocation, so they are not
   * in it. The label is the fix (wrangler.jsonc's `run_worker_first` comment
   * makes the same argument from the other end), so the label has to be there.
   */
  test('the requests figure says what it does not count', () => {
    // Case-insensitive only because the label renders in the page's sentence
    // case and the requirement quotes it in running prose; the words and their
    // order are what this pins.
    expect(html).toMatch(/requests that reached the Worker/i);
    expect(html).toMatch(/home page/i);
  });

  test('the requests note names the two agent-signal routes that are NOT counted', () => {
    // The sentence this replaces claimed "Every agent-signal route ... is"
    // counted, and two are not: `/resume.md` and `/.well-known/mcp.json` are
    // prerendered files, `run_worker_first` lists neither, and a request served
    // by the Asset Worker never reaches src/worker.ts to be classified.
    //
    // THIS IS THE ONLY GUARD ON THAT SENTENCE and it is a weak one by nature --
    // it pins the copy, not the config. Nothing here can prove a request
    // reached the Worker (tests/pages.test.ts records why), so the failure this
    // catches is the copy drifting back to the confident version, not the
    // config drifting away from the copy. If `/resume.md` is ever added to
    // `run_worker_first`, this test is what says the note must change with it.
    const note = tile('Requests that reached the Worker');
    expect(note).toContain('/resume.md');
    expect(note).toContain('/.well-known/mcp.json');
    expect(note).not.toMatch(/every agent-signal route[^.]*is\./i);
  });
});
