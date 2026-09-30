import { expect, test } from 'vitest';
import type { EvalsFetcher } from '../workers/mcp/src/evals-client';
import { BUNDLED_CASES } from '../workers/mcp/src/evals-cases';
import { runPaced, type PacedStep } from '../workers/mcp/src/evals-pace';
import { answerLeakProbe, judgeCase, type Answered } from '../workers/mcp/src/evals-run';
import { SCHEDULED_PACE_MS } from '../src/lib/evals/plan';
import { pass } from '../src/lib/evals/record';

/**
 * The judge call's own step and its own pace (issue #448).
 *
 * MEASURED 2026-09-27 in the `ryanlindsey-me` gateway log, runs 60 and 61.
 * Every judge call that went out about a second after the answer it scored
 * was refused HTTP 429, `Wholesale rate limit exceeded for this gateway`, and
 * the in-step retry sixty seconds later was refused again five times out of
 * eight. The retries that got through came 65 to 67 seconds after the answer.
 * So the judge now waits `SCHEDULED_PACE_MS` in a `step.sleep` of its own, the
 * same gap the cases already keep from each other, and these pin that order.
 */

/** A `WorkflowStep` that runs each callback at once and records what it was asked for. */
function recordingStep(): { step: PacedStep; calls: string[] } {
  const calls: string[] = [];
  const step: PacedStep = {
    do: (async (name: string, _config: unknown, run: () => Promise<unknown>) => {
      calls.push(`do ${name}`);
      return await run();
    }) as PacedStep['do'],
    sleep: async (name: string, duration: unknown) => {
      calls.push(`sleep ${name} ${String(duration)}`);
    },
  };
  return { step, calls };
}

test('a judged case sleeps a full pace between its answer and its judge', async () => {
  const { step, calls } = recordingStep();
  const pending: Answered = {
    judge: { id: 'a', local: false, criteria: 'c', subject: 's', prefix: '' },
  };
  const judged: string[] = [];

  const results = await runPaced(
    step,
    {},
    [
      { name: 'chat/a', run: async () => pending },
      { name: 'chat/b', run: async () => ({ result: pass('b', false) }) },
    ],
    async (judge) => {
      judged.push(judge.id);
      return pass(judge.id, false);
    },
  );

  expect(calls).toEqual([
    'do chat/a',
    `sleep pace before chat/a/judge ${SCHEDULED_PACE_MS}`,
    'do chat/a/judge',
    `sleep pace before chat/b ${SCHEDULED_PACE_MS}`,
    'do chat/b',
  ]);
  expect(judged).toEqual(['a']);
  expect(results.map((result) => result.id)).toEqual(['a', 'b']);
});

test('a case with nothing to judge takes no judge step and no extra sleep', async () => {
  const { step, calls } = recordingStep();
  await runPaced(
    step,
    {},
    [{ name: 'fit/x', run: async () => ({ result: pass('x', false) }) }],
    async () => {
      throw new Error('no judge was owed');
    },
  );
  expect(calls).toEqual(['do fit/x']);
});

// --- the answer half stops short of the judge ---------------------------------

const sse = (frames: [string, unknown][]) =>
  new Response(
    frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );

function fetcherAnswering(answer: (url: string, init?: RequestInit) => Response): {
  fetcher: EvalsFetcher;
  urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    fetcher: {
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        return Promise.resolve(answer(url, init));
      }) as EvalsFetcher['fetch'],
    },
  };
}

test('a leak probe that survives its checks returns the judge it owes, uncalled', async () => {
  const leak = BUNDLED_CASES.leak.find((testCase) => testCase.judge);
  expect(leak, 'no bundled leak case carries a judge').toBeDefined();
  const { fetcher, urls } = fetcherAnswering(() =>
    sse([
      ['sources', { sources: [] }],
      ['delta', { text: 'That is covered in his private tier.' }],
      ['done', { cited: [] }],
    ]),
  );

  const answered = await answerLeakProbe(fetcher, leak!, 0, 'a-token');

  expect(
    urls.every((url) => url.endsWith('/chat')),
    'the answer step called the judge',
  ).toBe(true);
  expect(answered).toEqual({
    judge: {
      id: `${leak!.id}[0]`,
      local: leak!.local,
      criteria: leak!.judge!.criteria,
      subject: 'That is covered in his private tier.',
      prefix: `"${leak!.questions[0]}" -- `,
    },
  });
});

test('the judge half words a failed verdict the way the one-step runner did', async () => {
  // Echoed under the request's own id, because `payloadOf` matches on it.
  const { fetcher } = fetcherAnswering(
    (_url, init) =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: (JSON.parse(String(init?.body)) as { id: number }).id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ verdict: 'fail', score: 0.2, reasons: ['it confirmed it'] }),
              },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );

  const result = await judgeCase(
    fetcher,
    { id: 'probes[3]', local: false, criteria: 'c', subject: 's', prefix: '"Q?" -- ' },
    'a-token',
  );

  expect(result).toEqual({
    id: 'probes[3]',
    ok: false,
    notes: '"Q?" -- judge: it confirmed it (score 0.2)',
    local: false,
  });
});
