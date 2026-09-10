import { describe, expect, test, vi } from 'vitest';
import { RETENTION, enforceRetention, retentionCutoff } from '../src/lib/retention';

/**
 * Retention enforcement (06 §2), against a fake D1 rather than the harness.
 *
 * A FAKE, DELIBERATELY. What is under test is which statement runs against which
 * table with which cutoff, and a real database would answer that question only
 * indirectly -- by leaving rows behind, which proves the delete ran but not that
 * it ran with the boundary the published policy claims. The fake lets the cutoff
 * itself be asserted, which is the number /ai-policy prints.
 *
 * WHAT THIS DOES NOT PROVE, stated rather than implied: that the cron fires, and
 * that `scheduled()` survives the Astro adapter's build. src/worker.ts's own
 * comment records that the second of those is unproven locally by design. Task
 * 13's live check is where both are settled.
 */
describe('retentionCutoff', () => {
  test('subtracts whole days and returns an ISO instant', () => {
    expect(retentionCutoff(new Date('2026-09-09T05:47:00.000Z'), 30)).toBe(
      '2026-08-10T05:47:00.000Z',
    );
  });
});

describe('RETENTION', () => {
  test('states the three windows /ai-policy publishes, and no others', () => {
    expect(RETENTION).toEqual([
      { table: 'chat_turns', column: 'created_at', days: 30 },
      { table: 'mcp_tool_calls', column: 'called_at', days: 365 },
      { table: 'fit_reports', column: 'created_at', days: 365 },
    ]);
  });
});

describe('enforceRetention', () => {
  // The two mocks below DECLARE their parameters even though the bodies ignore
  // them. `vi.fn(() => …)` types `mock.calls` as the empty tuple, so
  // `calls[0]?.[0]` is a ts(2493) rather than the argument this suite is
  // entirely about -- and `npm test` would not have said so, because vitest does
  // not typecheck. `npm run check` is what catches it.
  const fakeDb = () => {
    const run = vi.fn(async () => ({ meta: { changes: 2 } }));
    const bind = vi.fn((_cutoff: string) => ({ run }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    return { db: { prepare } as never, prepare, bind, run };
  };

  test('deletes from each table with its own column and cutoff', async () => {
    const { db, prepare, bind } = fakeDb();
    await enforceRetention(db, new Date('2026-09-09T05:47:00.000Z'));
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(prepare.mock.calls[0]?.[0]).toBe('DELETE FROM chat_turns WHERE created_at < ?');
    expect(bind.mock.calls[0]?.[0]).toBe('2026-08-10T05:47:00.000Z');
    expect(prepare.mock.calls[1]?.[0]).toBe('DELETE FROM mcp_tool_calls WHERE called_at < ?');
  });

  test('reports how many rows each table lost', async () => {
    const { db } = fakeDb();
    await expect(enforceRetention(db, new Date('2026-09-09T05:47:00.000Z'))).resolves.toEqual({
      chat_turns: 2,
      mcp_tool_calls: 2,
      fit_reports: 2,
    });
  });

  test('one failing table does not stop the others', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValue({ meta: { changes: 1 } });
    const db = { prepare: () => ({ bind: () => ({ run }) }) } as never;
    await expect(enforceRetention(db, new Date())).resolves.toEqual({
      chat_turns: -1,
      mcp_tool_calls: 1,
      fit_reports: 1,
    });
  });
});
