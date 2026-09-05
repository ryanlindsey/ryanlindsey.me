import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The harness builds and boots real Workers; the default 5s is not enough.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
