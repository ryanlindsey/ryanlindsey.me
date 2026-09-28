import { describe, expect, test } from 'vitest';
import { assertAstroKey } from '../src/lib/astro-key.mjs';

// The guard astro.config.mjs runs before every build. A Workers Builds build
// without a fixed `ASTRO_KEY` ships a server-island URL no earlier copy of `/`
// can reach, and the system band's figures stay blank for that visitor with
// nothing on the page saying why (src/lib/astro-key.mjs has the measurement).

describe('assertAstroKey', () => {
  test('refuses a Workers Builds build with no key', () => {
    expect(() => assertAstroKey({ WORKERS_CI: '1' })).toThrow(/ASTRO_KEY/);
  });

  test('refuses a Workers Builds build whose key is empty', () => {
    expect(() => assertAstroKey({ WORKERS_CI: '1', ASTRO_KEY: '' })).toThrow(/ASTRO_KEY/);
  });

  test('passes a Workers Builds build that carries a key', () => {
    expect(() => assertAstroKey({ WORKERS_CI: '1', ASTRO_KEY: 'a-key' })).not.toThrow();
  });

  test('passes a build off Workers Builds, which has no key to hold', () => {
    // GitHub Actions sets `CI` and never `WORKERS_CI`, and a local build sets
    // neither. Both keep Astro's per-build random key.
    expect(() => assertAstroKey({})).not.toThrow();
    expect(() => assertAstroKey({ CI: 'true' })).not.toThrow();
  });
});
