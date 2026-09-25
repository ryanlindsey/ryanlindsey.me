import { expect, test, vi } from 'vitest';
import { limitAndAudit, type ToolContext } from '../workers/mcp/src/define';
import type { McpEnv } from '../workers/mcp/src/env';

// `limitAndAudit` is the one place in the MCP Worker that catches a handler
// throwing, so its log line is the only record a failure leaves. Worker
// observability drops the message of an error passed as a second argument
// (see `run` in workers/mcp/src/fit-workflow.ts), so the message has to be in
// the first one. No harness: the read throws before anything touches a binding.
test('the catch-all failure log carries the error message in its first argument', async () => {
  const dispatched: Promise<unknown>[] = [];
  const tc: ToolContext = {
    env: { DB: undefined } as unknown as McpEnv,
    ctx: {
      waitUntil: (promise: Promise<unknown>) => dispatched.push(promise),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    request: undefined,
    grant: null,
  };

  const logged: unknown[][] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  try {
    const outcome = await limitAndAudit(
      tc,
      {
        auditName: 'probe',
        cost: 'cheap',
        surface: 'tool',
        read: () => {
          throw new Error('the probe could not be read');
        },
        hashable: () => null,
      },
      async () => null,
    );
    expect(outcome.kind).toBe('failed');
    await Promise.allSettled(dispatched);
  } finally {
    spy.mockRestore();
  }

  const line = logged.find((args) => String(args[0]).startsWith('mcp/tool: probe failed'));
  expect(line, 'the catch-all wrote no failure line').toBeDefined();
  expect(String(line![0])).toContain('the probe could not be read');
});
