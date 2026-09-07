import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { hashArgs } from '../src/lib/mcp/audit';

test('hashes equal argument objects identically regardless of key order', async () => {
  expect(await hashArgs({ a: 1, b: 2 })).toBe(await hashArgs({ b: 2, a: 1 }));
});

test('hashes nested keys canonically too', async () => {
  expect(await hashArgs({ o: { a: 1, b: 2 } })).toBe(await hashArgs({ o: { b: 2, a: 1 } }));
});

test('distinguishes different arguments', async () => {
  expect(await hashArgs({ q: 'alpha' })).not.toBe(await hashArgs({ q: 'beta' }));
});

test('gives no-argument calls a stable hash rather than an empty string', async () => {
  const empty = await hashArgs(undefined);
  expect(empty).toMatch(/^[0-9a-f]{64}$/);
  expect(empty).toBe(await hashArgs({}));
});

// The point of hashing rather than storing: the input must not be recoverable
// from the row, and a long pasted document must not become a long column.
test('produces a fixed-width hex digest for a large input', async () => {
  expect(await hashArgs({ text: 'x'.repeat(200_000) })).toMatch(/^[0-9a-f]{64}$/);
});

/**
 * The seam invariant, made mechanical rather than left to a comment and code
 * review.
 *
 * `defineTool`/`defineResource` (workers/mcp/src/define.ts) are meant to be
 * the ONLY paths that register a tool or a resource with the SDK -- that is
 * what makes every call audited (this module) and every call rate limited
 * (src/lib/mcp/limits.ts) rather than "audited and limited, except wherever
 * someone forgot to route through the wrapper." Today that is true only
 * because define.ts's own doc comments say so and a reviewer checks it by
 * eye. A day-5 tool calling `server.registerTool` directly would work fine --
 * the SDK does not care who calls it -- and would simply never be audited or
 * limited, silently, with nothing here to notice.
 *
 * So this greps the whole repo (skipping vendored/build output, and this
 * file itself -- it names the two calls literally, on purpose, to search for
 * them) for the two calls that actually register something with the SDK --
 * `server.registerTool(` and `server.registerResource(` -- and requires
 * every match to live in define.ts. Repo-wide today that is exactly three:
 * one in `defineTool` (`registerTool`) and two in `defineResource`
 * (`registerResource`, one per branch of the string-vs-template overload --
 * see that file's own note on why the branches are identical). A new call
 * site anywhere else fails this test by construction, regardless of what the day-5 tool is named.
 *
 * Cheap on purpose: no harness, no bindings, plain source text over 81
 * repo files (measured -- see the walk below), matching this file's own
 * no-bindings, no-index style.
 */
test('server.registerTool and server.registerResource are called only from define.ts', () => {
  const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
  const DEFINE_TS = 'workers/mcp/src/define.ts';
  // This file's own path, relative to REPO_ROOT the same way every other
  // candidate is compared -- excluded below because it names both calls
  // literally in the doc comment above and in `CALLS` itself, which would
  // otherwise flag this test as its own offender.
  const SELF = 'tests/mcp-audit.test.ts';
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro', '.wrangler', '.vercel']);
  const CALLS = ['server.registerTool(', 'server.registerResource('];

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (/\.(ts|tsx|js|mjs|cjs|astro)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const offenders: string[] = [];
  let matchesInDefineTs = 0;
  for (const file of sourceFiles(REPO_ROOT)) {
    const rel = relative(REPO_ROOT, file);
    if (rel === SELF) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!CALLS.some((call) => line.includes(call))) return;
      if (rel === DEFINE_TS) matchesInDefineTs++;
      else offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }

  // Not vacuous: proves the two literals above still match something before
  // trusting that an empty `offenders` list means the invariant holds rather
  // than that the search silently stopped finding anything at all (a rename
  // of either call in define.ts would do exactly that).
  expect(matchesInDefineTs).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});
