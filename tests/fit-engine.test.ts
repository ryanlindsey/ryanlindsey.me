import { expect, test } from 'vitest';
import {
  analyzeFit,
  BREAKER_KEY,
  extractToolInput,
  FitUnavailable,
  type FitEnv,
} from '../src/lib/fit/engine';

// Everything here runs against a STUB `Ai`, injected at the call site. The
// harness's `AI` binding is a service binding to workers/mock-ai, so
// `env.AI.run()` is a TypeError there by design (tests/workers.ts, and that
// Worker's own doc comment) -- the repo's established answer is to inject a
// fake rather than teach the mock to impersonate Workers AI. Nothing in this
// file boots a Worker or spends a neuron, which is also why it is fast.

const REPORT = {
  overall_read: 'A generic read.',
  requirement_map: [
    {
      requirement: 'Runs platform teams',
      strength: 'strong',
      evidence: [{ claim: 'Led a platform group', citation_url: 'https://site.test/resume' }],
    },
  ],
  gaps: [{ requirement: 'Field service', why: 'Not evidenced.' }],
  questions_to_ask: ['How is on-call staffed?'],
};

/**
 * A site stand-in serving one document and the `/llms.txt` that indexes it.
 *
 * THE CORPUS THIS PRODUCES IS EXACTLY ONE DOCUMENT, and not for the reason the
 * shape suggests. `fetchDocumentIndex` (src/lib/mcp/documents.ts) prepends
 * `RESUME_SOURCE` to every index it parses, so `/resume.md` is fetched whatever
 * the body below says. The Resume link IN the body is inert: `corpusSources`
 * (src/lib/corpus.ts) resolves each href against the module constant
 * `SITE_ORIGIN` -- the literal `https://ryanlindsey.me` -- and drops anything
 * on another origin, so a `site.test` link never becomes a source. Adding a
 * `https://site.test/writing/foo.md` line here would therefore change nothing;
 * a second document needs the real origin, which tests/fit-context.test.ts
 * uses for that reason. The body is still served because `fetchDocumentIndex`
 * THROWS on a non-ok `/llms.txt`, so the route has to exist.
 *
 * The one document is addressed by `env.SITE_ORIGIN` rather than by that
 * constant (`pageUrlFor`), which is what makes `https://site.test/resume` the
 * single URL a citation may name below.
 */
function siteFetcher(): Pick<Fetcher, 'fetch'> {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
      if (path === '/llms.txt') {
        return new Response(
          '# Ryan Lindsey\n\n> summary\n\n## Resume\n\n- [Resume (Markdown)](https://site.test/resume.md): the résumé.\n',
        );
      }
      if (path === '/resume.md') return new Response('---\ntitle: R\n---\n\nrésumé body\n');
      return new Response('not found', { status: 404 });
    },
  };
}

function env(over: Partial<FitEnv> = {}): FitEnv {
  return {
    SITE: siteFetcher(),
    SITE_ORIGIN: 'https://site.test',
    RLME_AI_GATEWAY_ID: 'ryanlindsey-me',
    KV_CONFIG: { get: async () => null } as unknown as KVNamespace,
    AI: {
      run: async () => ({
        content: [{ type: 'tool_use', name: 'emit_fit_report', input: REPORT }],
      }),
    } as unknown as Ai,
    ...over,
  };
}

test('extractToolInput finds the forced tool call among other content blocks', () => {
  // MEASURED SHAPE, not assumed: the binding returns Anthropic's own message
  // body, and a forced tool call arrives as a `tool_use` block that may sit
  // beside a `text` block the model emitted anyway.
  expect(
    extractToolInput({
      content: [
        { type: 'text', text: 'here you go' },
        { type: 'tool_use', name: 'emit_fit_report', input: { a: 1 } },
      ],
    }),
  ).toEqual({ a: 1 });
});

test('extractToolInput returns null for every shape that is not a tool call', () => {
  const bad: unknown[] = [
    null,
    undefined,
    {},
    { content: [] },
    { content: [{ type: 'text', text: 'x' }] },
    'string',
  ];
  for (const shape of bad) {
    expect(extractToolInput(shape)).toBeNull();
  }
});

test('a valid response becomes a validated report with a citation audit', async () => {
  const result = await analyzeFit(env(), 'A target description.');
  expect(result.report.requirement_map).toHaveLength(1);
  // The citation names a real corpus URL, so nothing is dropped.
  expect(result.citations).toEqual({ checked: 1, dropped: 0 });
  expect(result.model).toBeTruthy();
  expect(result.corpusDocuments).toBe(1);
  expect(Date.parse(result.generatedAt)).not.toBeNaN();
});

test('the target description and the prompt both reach the model call', async () => {
  // The engine's whole job is to put three things in front of a model: the
  // versioned prompt, the corpus, and the description. Nothing else in this
  // file would notice if one of them silently stopped being passed -- the stub
  // answers the same regardless.
  //
  // `FIT_PROMPT` is the one to guard, because it reaches the engine through a
  // DIFFERENT loader in each environment (Vite's `?raw` here, a `type: "Text"`
  // rule in workers/mcp/wrangler.jsonc when deployed), and the way that breaks
  // is silent: an asset-style loader resolves the import to a URL or a path
  // rather than to the file's contents, the model is handed a one-line system
  // prompt that is a filename, and every other test in this file still passes
  // because none of them look at what was sent.
  let seen: Record<string, unknown> = {};
  await analyzeFit(
    env({
      AI: {
        run: async (_model: unknown, input: Record<string, unknown>) => {
          seen = input;
          return { content: [{ type: 'tool_use', input: REPORT }] };
        },
      } as unknown as Ai,
    }),
    'Runs a distributed platform group.',
  );

  expect(String(seen.system)).toContain('Fit analysis prompt');
  expect(String(seen.system)).toContain('emit_fit_report');
  const messages = seen.messages as { content: string }[];
  expect(messages[0]!.content).toContain('Runs a distributed platform group.');
  expect(messages[0]!.content).toContain('https://site.test/resume');
});

test('a fabricated citation is dropped and counted', async () => {
  const fabricated = structuredClone(REPORT);
  fabricated.requirement_map[0]!.evidence[0]!.citation_url = 'https://invented.example/nope';
  const result = await analyzeFit(
    env({
      AI: {
        run: async () => ({ content: [{ type: 'tool_use', input: fabricated }] }),
      } as unknown as Ai,
    }),
    'A target description.',
  );
  expect(result.citations.dropped).toBe(1);
  expect(result.report.requirement_map[0]!.strength).toBe('none');
});

test('a response that does not match the schema is a FitUnavailable, not a partial report', async () => {
  // Fails CLOSED. Half a report rendered as a whole one is the failure this
  // whole feature cannot afford -- the reader has no way to see what is
  // missing.
  const result = analyzeFit(
    env({
      AI: {
        run: async () => ({ content: [{ type: 'tool_use', input: { nope: true } }] }),
      } as unknown as Ai,
    }),
    'A target description.',
  );
  await expect(result).rejects.toBeInstanceOf(FitUnavailable);
});

test('a model error becomes a FitUnavailable whose message names no internals', async () => {
  const result = analyzeFit(
    env({
      AI: {
        run: async () => {
          throw new Error('AiError: 2018 Invalid User Credentials');
        },
      } as unknown as Ai,
    }),
    'A target description.',
  );
  await expect(result).rejects.toBeInstanceOf(FitUnavailable);
  await expect(result).rejects.toThrow(/^(?!.*2018).*$/s);
});

test('the breaker refuses before any inference is spent', async () => {
  let called = false;
  await expect(
    analyzeFit(
      env({
        KV_CONFIG: {
          get: async (key: string) => (key === BREAKER_KEY ? 'on' : null),
        } as unknown as KVNamespace,
        AI: {
          run: async () => {
            called = true;
            return {};
          },
        } as unknown as Ai,
      }),
      'A target description.',
    ),
  ).rejects.toBeInstanceOf(FitUnavailable);
  expect(called, 'the breaker must be checked BEFORE the model call').toBe(false);
});

test('an empty target description is refused without spending inference', async () => {
  let called = false;
  await expect(
    analyzeFit(
      env({
        AI: {
          run: async () => {
            called = true;
            return {};
          },
        } as unknown as Ai,
      }),
      '   ',
    ),
  ).rejects.toBeInstanceOf(FitUnavailable);
  expect(called).toBe(false);
});

test('the FIT_ENGINE seam refuses without touching the corpus, and rejects any other value', async () => {
  // Same shape as `CORPUS_REFRESH` and `MCP_SEARCH_EMBEDDER`: no deployed
  // config declares it, `'off'` is the only accepted value, and anything else
  // THROWS rather than guessing -- a typo that silently disabled the engine in
  // production is the failure this shape exists to make impossible.
  let fetched = false;
  const watched = (): Pick<Fetcher, 'fetch'> => ({
    fetch: async () => {
      fetched = true;
      return new Response('not found', { status: 404 });
    },
  });

  await expect(
    analyzeFit(env({ FIT_ENGINE: 'off', SITE: watched() }), 'A target description.'),
  ).rejects.toBeInstanceOf(FitUnavailable);
  expect(fetched, 'a refused run must not even fetch the corpus').toBe(false);

  const bogus = analyzeFit(env({ FIT_ENGINE: 'yes' }), 'A target description.');
  await expect(bogus).rejects.toThrow(/FIT_ENGINE/);
  await expect(bogus).rejects.not.toBeInstanceOf(FitUnavailable);
});
