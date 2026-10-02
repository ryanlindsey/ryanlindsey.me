import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// `npm run evals` is `node evals/run.mjs`, loaded by Node's own type stripping
// rather than by Vite (issue #495). Vite resolves an extensionless specifier
// and Node does not, so every other suite here passed on 2026-10-02 while the
// runner failed to load at `src/lib/evals/checks.ts`'s runtime import of
// `../mcp/tool-reason`. Only a real Node process sees that, so this test spawns
// one.
//
// It imports what the runner imports rather than the runner itself, because
// importing run.mjs runs a suite against a deployed endpoint. Node follows each
// module's own imports, so the whole transitive path is loaded and nothing
// below it needs listing here. The specifiers are read from run.mjs so a new
// import there is covered without editing this file.

const RUNNER = new URL('../evals/run.mjs', import.meta.url);

const localImports = [
  ...readFileSync(RUNNER, 'utf8').matchAll(/^\s*(?:import|\})[^;]*?from\s+'(\.[^']+)'/gm),
].map(([, specifier]) => new URL(specifier, RUNNER).href);

test('the runner imports at least its src/lib modules', () => {
  expect(localImports.length).toBeGreaterThanOrEqual(5);
});

test('every module the runner imports loads in a plain Node process', () => {
  const script = localImports.map((href) => `await import(${JSON.stringify(href)});`).join('\n');
  let stderr = '';
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    stderr = String((error as { stderr?: string }).stderr ?? error);
  }
  expect(stderr).toBe('');
});
