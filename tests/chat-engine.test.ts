import { describe, expect, test, vi } from 'vitest';
import {
  CHAT_MODEL,
  ChatUnavailable,
  MAX_QUESTION_CHARS,
  retrieve,
  startAnswer,
} from '../src/lib/chat/engine';
import { numberSources } from '../src/lib/chat/context';

/**
 * The engine, against stubs rather than the harness -- the pattern
 * tests/fit-engine.test.ts established, for the same reason: the harness's `AI`
 * is a service binding and its `VECTORIZE` throws `needs to be run remotely`.
 *
 * WHAT THESE DO NOT PROVE: that the model answers, that retrieval finds
 * anything, or that the stream frames as expected. The framing was MEASURED
 * against the live binding (see the note in src/lib/chat/engine.ts) rather than
 * asserted here, the endpoint's behaviour around the engine is
 * tests/chat-endpoint.test.ts, and the round trip is the chat eval suite.
 */
const source = numberSources([
  {
    type: 'post',
    slug: 'a-post',
    chunk: 0,
    url: 'https://ryanlindsey.me/writing/a-post',
    score: 0.8,
    excerpt: 'alpha',
    exact: true,
  },
]);

const kv = (values: Record<string, string | null> = {}) => ({
  get: vi.fn(async (key: string) => values[key] ?? null),
  put: vi.fn(async () => undefined),
});

/**
 * The binding's own shape, declared so `mock.calls` is a TYPED tuple.
 *
 * `vi.fn(async () => …)` infers a zero-parameter procedure, which makes
 * `mock.calls[0]` the empty tuple and every `calls[0]?.[1]` below a ts(2493)
 * -- and `npm test` would never say so, because vitest does not typecheck.
 * Declaring the signature once here is what lets the assertions read the model,
 * the input and the gateway options by position, which is the whole point of
 * this suite. The return is `unknown` so a test can swap in a non-stream
 * response without a cast fight.
 */
type AiRun = (
  model: string,
  input: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<unknown>;

/** The chat call's input, for the assertions that read inside it. */
interface ChatInput {
  max_tokens: number;
  system: string;
  messages: { role: string; content: string }[];
  stream: boolean;
}

const baseEnv = () => ({
  AI: { run: vi.fn<AiRun>(async () => new ReadableStream()) },
  VECTORIZE: {
    query: vi.fn(async (_vector: number[], _options: Record<string, unknown>) => ({
      matches: [] as { id: string; score: number }[],
    })),
  },
  KV_CONFIG: kv(),
  KV_CACHE: kv(),
  SITE: { fetch: vi.fn() },
  SITE_ORIGIN: 'https://ryanlindsey.me',
  RLME_AI_GATEWAY_ID: 'ryanlindsey-me',
});

/** The one model call this suite made, asserted to exist before it is read. */
const onlyCall = (run: ReturnType<typeof vi.fn<AiRun>>) => {
  const call = run.mock.calls[0];
  expect(call).toBeDefined();
  return call as Parameters<AiRun>;
};

describe('guards', () => {
  test('an unrecognised CHAT_ENGINE throws a plain Error, not a polite refusal', async () => {
    await expect(
      startAnswer({ ...baseEnv(), CHAT_ENGINE: 'maybe' } as never, 'hi', source),
    ).rejects.toThrow(/unrecognised CHAT_ENGINE/);
  });

  test("CHAT_ENGINE 'off' refuses before the model is called", async () => {
    const env = { ...baseEnv(), CHAT_ENGINE: 'off' };
    await expect(startAnswer(env as never, 'hi', source)).rejects.toBeInstanceOf(ChatUnavailable);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  test('an empty question refuses with the empty code', async () => {
    await expect(startAnswer(baseEnv() as never, '   ', source)).rejects.toMatchObject({
      code: 'empty',
    });
  });

  test('an over-long question refuses with the too-long code', async () => {
    const question = 'x'.repeat(MAX_QUESTION_CHARS + 1);
    await expect(startAnswer(baseEnv() as never, question, source)).rejects.toMatchObject({
      code: 'too-long',
    });
  });

  test('the shape checks outrank the seam, so a bad question says so even with the engine off', async () => {
    // The ordering tests/chat-endpoint.test.ts depends on: that whole suite runs
    // with CHAT_ENGINE 'off', so if the seam were checked first neither of the
    // two codes above could be reached by any test in this repo.
    const env = { ...baseEnv(), CHAT_ENGINE: 'off' };
    await expect(startAnswer(env as never, '   ', source)).rejects.toMatchObject({ code: 'empty' });
    await expect(
      startAnswer(env as never, 'x'.repeat(MAX_QUESTION_CHARS + 1), source),
    ).rejects.toMatchObject({ code: 'too-long' });
  });

  test('a tripped breaker refuses before the model, with the paused code', async () => {
    const env = { ...baseEnv(), KV_CONFIG: kv({ 'breaker:inference': '1' }) };
    await expect(startAnswer(env as never, 'hi', source)).rejects.toMatchObject({
      code: 'paused',
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  test('a breaker read that throws fails CLOSED', async () => {
    const env = baseEnv();
    env.KV_CONFIG.get = vi.fn(async () => {
      throw new Error('kv down');
    });
    await expect(startAnswer(env as never, 'hi', source)).rejects.toBeInstanceOf(ChatUnavailable);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  test('the engine holds no counter of its own — the cap is the limiter, at the endpoint', async () => {
    const env = baseEnv();
    await startAnswer(env as never, 'hi', source);
    // One KV read (the breaker) and NO write. A write here would mean a second,
    // approximate accounting of a number the Durable Object already counts
    // exactly (src/lib/mcp/limits.ts's `checkGlobalLimit`).
    expect(env.KV_CONFIG.get).toHaveBeenCalledTimes(1);
    expect(env.KV_CONFIG.put).not.toHaveBeenCalled();
  });

  test('no sources means no model call at all', async () => {
    const env = baseEnv();
    await expect(startAnswer(env as never, 'hi', [])).rejects.toMatchObject({
      code: 'no-answer',
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});

describe('the model call', () => {
  test('sends the system prompt, the numbered context, streaming, and the gateway id', async () => {
    const env = baseEnv();
    await startAnswer(env as never, 'what is this site?', source);
    const [model, rawInput, options] = onlyCall(env.AI.run);
    const input = rawInput as unknown as ChatInput;
    expect(model).toBe(CHAT_MODEL);
    expect(input.stream).toBe(true);
    expect(input.max_tokens).toBe(1024);
    expect(input.system).toContain('Chat — system prompt');
    expect(input.messages[0]?.content).toContain('## [1] a-post');
    expect(input.messages[0]?.content).toContain('what is this site?');
    expect(options?.gateway).toEqual({
      id: 'ryanlindsey-me',
      metadata: { surface: 'chat' },
    });
  });

  test('carries no sampling parameters, which this binding rejects with 7003', async () => {
    const env = baseEnv();
    await startAnswer(env as never, 'hi', source);
    const [, input] = onlyCall(env.AI.run);
    expect(input).not.toHaveProperty('temperature');
    expect(input).not.toHaveProperty('top_p');
    expect(input).not.toHaveProperty('top_k');
  });

  test('the question is fenced as data, and the fence grows past its own backticks', async () => {
    const env = baseEnv();
    await startAnswer(env as never, 'what about ``` this?', source);
    const [, rawInput] = onlyCall(env.AI.run);
    expect((rawInput as unknown as ChatInput).messages[0]?.content).toContain('````text');
  });

  test('a model call that throws becomes a ChatUnavailable, never a raw AiError', async () => {
    const env = baseEnv();
    env.AI.run = vi.fn<AiRun>(async () => {
      throw new Error('AiError: 2018 Invalid User Credentials');
    });
    const failure = await startAnswer(env as never, 'hi', source).catch((error) => error);
    expect(failure).toBeInstanceOf(ChatUnavailable);
    expect(String(failure)).not.toContain('2018');
  });

  test('a non-stream response is refused rather than returned as an answer', async () => {
    const env = baseEnv();
    env.AI.run = vi.fn<AiRun>(async () => ({ response: 'not a stream' }));
    await expect(startAnswer(env as never, 'hi', source)).rejects.toMatchObject({
      code: 'no-answer',
    });
  });

  test('it hands back the sources the model was actually shown, not everything retrieved', async () => {
    // The structural half of the citation guarantee: `included` is what the
    // endpoint frames, links and scores against. If `startAnswer` returned only
    // a stream, the caller's only option would be the full retrieval set, and a
    // budget-dropped source would be linked for the reader and counted as a
    // valid citation. See src/lib/chat/context.ts's `citationsIn`.
    const env = baseEnv();
    const { stream, included } = await startAnswer(env as never, 'hi', source);
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(included.map((entry) => entry.n)).toEqual([1]);
  });
});

describe('retrieve', () => {
  test('queries the public tier only, and asks for the documented top-k', async () => {
    const env = baseEnv();
    env.AI.run = vi.fn<AiRun>(async () => ({ data: [[0.1, 0.2]] }));
    await retrieve(env as never, 'hello');
    const call = env.VECTORIZE.query.mock.calls[0];
    expect(call).toBeDefined();
    const options = call?.[1] ?? {};
    expect(options.filter).toEqual({ tier: 'public' });
    expect(options.topK).toBe(8);
    expect(options.returnMetadata).toBe('indexed');
  });

  test('embeds the question QUERY-side, which is the half that silently degrades', async () => {
    const env = baseEnv();
    env.AI.run = vi.fn<AiRun>(async () => ({ data: [[0.1]] }));
    await retrieve(env as never, 'hello');
    // `queries`, not `documents`. The distinction is the one that degrades
    // retrieval silently and forever -- both spellings return a vector, and only
    // one of them matches how the corpus was embedded.
    const [, input] = onlyCall(env.AI.run);
    expect(input).toEqual({ queries: ['hello'] });
  });
});
