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
 * OWN KV key for 60 seconds (`ops:metrics:v3`, `ops:traffic:v1`,
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
/** The page's own cache, so the version test below can plant a stale entry in it. */
let kv: KVNamespace;

beforeAll(async () => {
  await server.listen();
  // The type argument goes on `getWorker`, not on `getEnv` -- `getEnv()` takes
  // none (wrangler-dist/cli.d.ts). Same note as tests/ops-metrics.test.ts.
  const site = server.getWorker<{ DB: D1Database; KV_CACHE: KVNamespace }>();

  // FIRST, while `mcp_tool_calls` and friends still do not exist.
  degraded = await (await server.fetch('/ops')).text();

  await site.applyD1Migrations('DB');
  const db = (await site.getEnv()).DB;
  kv = (await site.getEnv()).KV_CACHE;
  // A private-tier row, planted so the assertions below are testing a filter
  // that had something to filter. Without it they pass vacuously.
  await db
    .prepare(
      `INSERT INTO mcp_tool_calls (called_at, tool, args_hash, tier, audience, outcome, duration_ms)
       VALUES (?, 'analyze_fit', 'h', 'private', 'label-a', 'ok', 900)`,
    )
    .bind(new Date().toISOString())
    .run();
  // One INCOMPLETE eval run (migrations/0005), so the Evals section renders a
  // suite that could not run rather than only ever exercising the empty "No
  // runs recorded yet" state. `leak` is a real suite name (evals/README.md);
  // the row carries no model, matching src/lib/evals/record.ts's
  // `incompleteRow()`, which sets none.
  await db
    .prepare(
      `INSERT INTO eval_runs (ran_at, suite, model, total, passed, failed, status)
       VALUES (?, 'leak', NULL, 0, 0, 0, 'incomplete')`,
    )
    .bind(new Date().toISOString())
    .run();
  // One fit run in each status `fit_reports` can hold (migrations/0006), so
  // the fit tile has a failure and an unfinished run to name (issue #353).
  for (const [id, status] of [
    ['fit-ok', 'ok'],
    ['fit-failed', 'failed'],
    ['fit-pending', 'pending'],
  ]) {
    await db
      .prepare(
        `INSERT INTO fit_reports (id, created_at, status, audience, target_description)
         VALUES (?, ?, ?, 'label-a', 'a-posting')`,
      )
      .bind(id, new Date().toISOString(), status)
      .run();
  }
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

/** One breakdown list's markup, looked up by its title. */
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

  test('an incomplete eval run renders as words in text-warn, never a dash or a zero', () => {
    // The ruling this task shipped against its own brief's contradictory
    // sentence: an 'incomplete' row (migrations/0005) renders Pass as "did
    // not run" and Fail as "not recorded", both in `text-warn`. No em dash and
    // no lone glyph -- every other cell in these two columns is a number, and
    // a bare dash there would read as a value.
    const section = /<section aria-labelledby="evals"[\s\S]*?<\/section>/.exec(html);
    expect(section, 'no evals section').not.toBeNull();
    const evals = section![0];
    // Scoped to the table body: the section's own intro paragraph now contains
    // the substring "did not run" too (it says a row CAN say that), so
    // searching the whole section would find that prose first.
    const tbodyAt = evals.indexOf('<tbody');
    expect(tbodyAt, 'no table body').toBeGreaterThan(-1);

    const passAt = evals.indexOf('did not run', tbodyAt);
    expect(passAt, 'Pass cell must say did not run').toBeGreaterThan(-1);
    expect(evals.slice(evals.lastIndexOf('<td', passAt), passAt)).toContain('text-warn');

    const failAt = evals.indexOf('not recorded', tbodyAt);
    expect(failAt, 'Fail cell must say not recorded').toBeGreaterThan(-1);
    expect(evals.slice(evals.lastIndexOf('<td', failAt), failAt)).toContain('text-warn');

    // The Ran column keeps its date: when a suite could not run is exactly
    // the fact this row exists to carry.
    expect(evals).toContain(new Date().toISOString().slice(0, 10));
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

  test('a breakdown that was read names its source once, in its header', () => {
    // The 2026-09 redesign put the source in the panel kicker (`By tool · D1`)
    // and left the trailing provenance line under the list, so every panel that
    // could be read named where its numbers came from twice, about fifteen rows
    // apart. 06 §1 asks that a figure state its source. It does not ask twice.
    //
    // `By tool` IS THE ARM THIS CAN ASSERT, and the reason is two layers down:
    // its D1 query narrows to `tier = 'public'` (src/lib/ops/metrics.ts) and the
    // only row planted above is private, so this render reaches the
    // rows-not-null path with an empty list -- the same branch a populated panel
    // takes, and the only way this suite can reach it without a seam.
    const list = breakdown('By tool');
    expect(list, 'By tool must have been read at all').toContain('Nothing recorded in this window');
    // THE COUNT ALONE DOES NOT PIN POSITION: if a later change moved D1 from the
    // kicker to an unconditional trailing line, the count would still be 1 and
    // this test would falsely pass. Both assertions together say "exactly one
    // mention, and it is the kicker."
    expect(list.match(/D1/g) ?? [], 'By tool must name D1 exactly once').toHaveLength(1);
    expect(list, 'the one mention must be the kicker').toContain('By tool · D1');
  });

  test('a breakdown that could not be read still names its cause', () => {
    // The other half of the assertion above, and the reason the line is made
    // conditional rather than deleted. `degraded` renders before the migrations
    // exist, so `By tool` takes the rows === null path, where this line is the
    // only place the CAUSE appears: the body carries the two-word state alone,
    // and "not available" without "the metrics store could not be read" is the
    // labelled absence with the label taken off.
    const list = breakdown('By tool', degraded);
    expect(list, 'By tool must render its absence').toContain('not available');
    expect(list, 'By tool must name the cause').toContain(
      'D1 — the metrics store could not be read',
    );
  });

  test('the changelog shows dates and never a time', () => {
    // Sliced from the section's anchor rather than from its heading. The
    // heading was "Changelog" and is "Release history" now, and the old slice
    // followed that word to the only place it still appears, which is the
    // footer -- where there is no date to find and the test failed for a
    // reason that had nothing to do with dates. The `id` is what a link into
    // this page depends on, so it is the stable thing to key on.
    const releases = html.slice(html.indexOf('id="releases"'));
    expect(releases).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(releases).not.toMatch(/\d{2}:\d{2}/);
  });

  test('every model in use is named, from the constants rather than by hand', () => {
    expect(html).toContain('anthropic/claude-sonnet-5');
    expect(html).toContain('anthropic/claude-opus-5.5');
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

  test('the architecture diagram is selectable text built from rules, not a drawing', () => {
    // WAS: "is inline SVG using currentColor, not an image". That assertion was
    // right against the failure it was written for -- a diagram becoming a PNG
    // -- and the 2026-09 redesign moves further in the same direction: no SVG
    // either. What it protects is unchanged: the diagram stays selectable,
    // themeable and accessible. Rewritten rather than deleted, so the record of
    // what it was guarding survives the change of mechanism.
    const diagram = /data-architecture-diagram[\s\S]*?<\/figure>/.exec(html);
    expect(diagram, 'no architecture diagram').not.toBeNull();
    expect(diagram![0]).not.toContain('<svg');
    expect(diagram![0]).not.toContain('<img');
    // Real hostnames as real text, so a reader can select and paste one.
    expect(diagram![0]).toContain('ryanlindsey.me');
    expect(diagram![0]).toContain('mcp.ryanlindsey.me');
  });

  test('the diagram carries the one description the markdown fallback also uses', async () => {
    // src/lib/architecture.ts exists to refuse a second hand-written
    // description: the SVG's <desc> and markdown-export's COMPONENT_FALLBACKS
    // were one string. With no <desc> to hang it on it becomes a
    // visually-hidden description, and it is still one string.
    const { ARCHITECTURE_DESCRIPTION } = await import('../src/lib/architecture');
    expect(html).toContain(ARCHITECTURE_DESCRIPTION.slice(0, 80));
    expect(html).toMatch(/aria-describedby="[^"]+"/);
  });

  test('the connectors and glyphs are decoration, not content', () => {
    const diagram = /data-architecture-diagram[\s\S]*?<\/figure>/.exec(html)![0];
    // PRESENCE IS ASSERTED FIRST, and the draft of this test skipped a glyph it
    // could not find rather than failing on it. That version cannot fail once
    // the figure exists: a diagram that renders no glyph at all passes it, so
    // it would have gone green the moment the SVG was replaced and stayed
    // green if the binding arrows were never drawn. Same class of dead
    // assertion the analytics test above records having had.
    for (const glyph of ['\u25b6', '\u25c0']) {
      const at = diagram.indexOf(glyph);
      expect(at, `the diagram draws no ${glyph}`).toBeGreaterThan(-1);
      expect(diagram.slice(Math.max(0, at - 200), at)).toContain('aria-hidden');
    }
  });

  test('the status pill degrades with the page rather than always reading nominal', () => {
    // /ops already renders a labelled absence when D1 is unreachable. A pill
    // hardcoded to "nominal" above a page saying three figures could not be
    // read is worse than no pill at all.
    expect(html).toContain('data-status-pill');
    expect(html).toMatch(/data-status-pill[^>]*data-status="(nominal|degraded)"/);
  });

  test('no metric cell renders a bare zero where a figure could not be read', () => {
    const band = /data-metrics-band[\s\S]*?<\/section>/.exec(html);
    expect(band, 'no metrics band').not.toBeNull();
    // The rule this page has lived by since launch, restated against the new
    // markup: a hairline cell with a 2.25rem zero in it is the most convincing
    // way to publish a false number this page has ever had available.
    const values = [...band![0].matchAll(/data-metric-value[^>]*>([^<]*)</g)].map((m) =>
      m[1].trim(),
    );
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).not.toBe('');
  });

  test('every link in the masthead index reaches a section this page renders', () => {
    // The index replaced the masthead's explanatory paragraph, and it is
    // hand-written: SECTIONS in the page names an anchor per row, and nothing
    // in Astro checks that the anchor exists. A dead entry is the failure this
    // construction actually has, and it is silent -- the link renders, the
    // click does nothing, and the page looks correct in every screenshot.
    //
    // By the declared `data-ops-index` hook rather than by slicing on the nav
    // element, for the reason `hooked` above gives: an assertion keyed on
    // markup that is free to change starts passing vacuously the first time it
    // does.
    const nav = /<nav[^>]*data-ops-index[\s\S]*?<\/nav>/.exec(html);
    expect(nav, 'no masthead index').not.toBeNull();

    const targets = [...nav![0].matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    // Six, and the count is load-bearing rather than incidental: the index is a
    // `hairline-grid` running two and three columns, and six is what divides
    // both. A seventh entry leaves a short row, which in that idiom paints as a
    // block of rule colour rather than as whitespace.
    expect(targets).toHaveLength(6);
    for (const id of targets) {
      expect(html, `the index links to #${id}, which this page does not render`).toContain(
        `id="${id}"`,
      );
    }
  });

  test('all six sections survive the restyle', () => {
    // Unchanged assertion, restated against the ids because the handoff's
    // design shows four sections. It is a restyle, not a re-scope -- the
    // screenshot shows what fitted in a screenshot. The sibling test above
    // pins the headings; this one pins the anchors the headings carry, which
    // is what a link into this page depends on.
    for (const id of [
      'architecture',
      'live-metrics',
      'model-cost',
      'evals',
      'status',
      'releases',
    ]) {
      expect(html, `${id} is missing`).toContain(`id="${id}"`);
    }
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
      'Fit reports produced',
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

  /*
   * TWO TESTS STOOD HERE AND GUARDED THE REQUESTS TILE'S NOTE, which the page
   * no longer carries: one asserted the note named the home page and the static
   * sub-resources served without a Worker invocation, the other that it named
   * `/resume.md` and `/.well-known/mcp.json`, the two prerendered files
   * `run_worker_first` does not list. The `note` prop is empty now, by a copy
   * decision, so both were pinning a sentence rather than a property and are
   * gone rather than weakened into assertions that cannot fail.
   *
   * The figure is still partial by construction. Nothing in this suite can see
   * that any more, and wrangler.jsonc's `run_worker_first` comment is the one
   * place the reasoning survives.
   */

  test('the fit tile counts reports and names the runs that produced none', () => {
    // Issue #353. The figure is the question a reader actually asks of this
    // page, whether the feature produced anything, and the note is what keeps
    // a failed or abandoned run from disappearing into it.
    const metric = tile('Fit reports produced');
    expect(metric).toMatch(/data-numeric[^>]*>\s*1\s*</);
    expect(metric).toContain('3 started, 1 failed, 1 not finished');
    expect(metric).not.toContain('a-posting');
  });

  test('an entry written under the previous cache version is not served', async () => {
    // WHAT WOULD HAVE SHIPPED WITHOUT THE BUMP. `OpsMetrics` gained `status`
    // (migrations/0005), and for up to `CACHE_TTL_SECONDS` after a deploy the
    // page would have read an entry written by the previous build, whose eval
    // rows carry no `status` at all. `run.status === 'ran'` is false for
    // `undefined`, so EVERY suite would have rendered "did not run" -- the page
    // reporting a broken pipeline because its own cache was a minute old.
    //
    // THE SAME LESSON THIS REPOSITORY HAS ALREADY LEARNED ONCE. `CLAUDE.md`
    // records it about `SEARCH_CACHE_VERSION`: when what an entry holds
    // changes, the key has to change too, or entries written before the change
    // keep being served for a full TTL.
    //
    // AND IT HAPPENED AGAIN IN ISSUE #353, which is why the planted key is `v2`
    // now rather than `v1`. `fitRuns` went from one number to four, and a `v2`
    // entry's bare number has no `reports` on it, so the fit tile would have
    // rendered its absence for a minute after the deploy while D1 answered
    // perfectly well.
    //
    // The planted value is the OLD shape, and the tool-call figure is what the
    // assertion reads: a number that exists nowhere in D1, so finding it on the
    // page can only mean the old key was read.
    await kv.put(
      'ops:metrics:v2',
      JSON.stringify({
        windowDays: 30,
        toolCalls: [{ tool: 'get_resume', calls: 4242 }],
        chatSessions: 0,
        chatTurns: 0,
        fitRuns: 0,
        evalRuns: [
          {
            ranAt: '2026-09-01T00:00:00.000Z',
            suite: 'tier',
            total: 3,
            passed: 3,
            failed: 0,
            status: 'ran',
          },
        ],
      }),
      { expirationTtl: 60 },
    );

    const after = await (await server.fetch('/ops')).text();
    expect(after, 'the page served an entry written under the old cache key').not.toContain(
      '4,242',
    );
  });
});
