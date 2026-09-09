import { defineConfig } from 'vitest/config';

// NO LOADER FOR `prompts/fit.md?raw` IS CONFIGURED HERE, DELIBERATELY, and this
// note exists because its absence looks like an omission. src/lib/fit/engine.ts
// imports the fit prompt as a string, and on the deployed side that works
// through a `rules` entry of `type: "Text"` in workers/mcp/wrangler.jsonc. The
// vitest side needs no equivalent: `?raw` is Vite's OWN spelling for "give me
// this file's contents as a string", so plain Vite already answers it. The
// suffix is on the import for a TypeScript reason (see
// src/lib/fit/markdown-modules.d.ts), and it happens to remove the need for a
// second loader here -- one import specifier, honoured natively by both.
//
// `assetsInclude: ['**/prompts/*.md']` was considered and is WRONG: it makes
// Vite treat the file as an ASSET, whose default export is its URL. `FIT_PROMPT`
// would silently become a path string, the system prompt would be garbage, and
// every test in tests/fit-engine.test.ts would still pass, because they all stub
// the model. The assertion that would catch it is the 'the target description
// and the prompt both reach the model call' test, which is there for this reason.

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The harness builds and boots real Workers; the default 5s is not enough.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
