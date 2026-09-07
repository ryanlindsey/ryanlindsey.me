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
