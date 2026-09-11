import type { RateLimiterObject } from '../../../src/lib/mcp/limits';

/**
 * The bindings THIS Worker declares, from workers/mcp/wrangler.jsonc.
 *
 * It replaces `Env & Pick<CorpusEnv, ...>`. That intersection borrowed the
 * SITE's generated `Env`, which declares `EMAIL`, `BROWSER`, `ASSETS`, `MCP`
 * and `RLME_TURNSTILE_SECRET_KEY` -- none of which are bound here. A type that
 * names bindings the Worker does not have is worse than no type.
 *
 * DAY 6 GAVE THIS WORKER `EVENTS` FOR REAL (06 §3). The paragraph here used to
 * name it as the worked example of the problem -- `env.EVENTS.send(...)`
 * typechecked against the borrowed type and would have thrown at runtime,
 * because day 4 is exactly when the events queue looks reachable and is not.
 * It is reachable now: the gated-tier events (a fit run, any gated tool call)
 * are observed on THIS Worker, because this is the one that resolves the grant
 * and knows the audience. The lesson the old example taught is unchanged and
 * is what the test below enforces -- the binding is in the type because it is
 * in the config, not because it is convenient.
 *
 * tests/mcp-env.test.ts regenerates the binding list with `wrangler types`
 * and fails if this drifts from the config in either direction.
 */
export interface McpEnv {
  DB: D1Database;
  KV_CONFIG: KVNamespace;
  KV_CACHE: KVNamespace;
  R2_ASSETS: R2Bucket;
  R2_PRIVATE: R2Bucket;
  AE: AnalyticsEngineDataset;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  /**
   * The high-intent events queue (06 §3). Produced here, consumed on the site
   * Worker -- a queue is the seam that lets one Worker report an event another
   * one acts on, which is what keeps the `EMAIL` binding and the destination
   * secret off this Worker entirely.
   */
  EVENTS: Queue;
  /**
   * The rate limiter (03 §3), a Durable Object namespace rather than the
   * `RateLimit` binding it was until #29 -- see workers/mcp/src/rate-limiter.ts
   * for the production measurement that forced the change. `RATE_LIMITER_SEARCH`
   * is GONE rather than renamed: two bindings existed only because a
   * `ratelimits` binding carries its limit in its own config, and a Durable
   * Object separates buckets by NAME, which `limitKeyFor` was already doing.
   */
  RATE_LIMITER: DurableObjectNamespace<RateLimiterObject>;
  /** Read only through `signingKey` in src/lib/tier/grant.ts. */
  RLME_TOKEN_SIGNING_KEY: SecretsStoreSecret;
  /**
   * The site Worker (`ryanlindsey-me`), over a service binding -- how every
   * published document is read. See workers/mcp/wrangler.jsonc for why this
   * exists (issue #28) and `DocumentsEnv.SITE` in src/lib/mcp/documents.ts for
   * what is done with it. `Fetcher` is what a service binding types as; the two
   * consumers narrow it to `Pick<Fetcher, 'fetch'>` themselves.
   */
  SITE: Fetcher;
  RLME_AI_GATEWAY_ID: string;
  SITE_ORIGIN: string;
  /** Test-only seam; see `CorpusEnv.CORPUS_REFRESH` in src/lib/corpus.ts. */
  CORPUS_REFRESH?: string;
  /**
   * Test-only seam, the same shape and the same reasoning as `CORPUS_REFRESH`
   * above and `RESUME_PDF_RENDERER` before it: `'on'` (the deployed default,
   * which comes from the var being ABSENT rather than from a default branch)
   * or `'stub'`. No deployed environment sets it -- wrangler.jsonc does not
   * declare it -- and an unrecognised value throws rather than guessing.
   *
   * `'stub'` is set on this Worker by tests/workers.ts. It exists because the
   * harness overrides `AI` to a local service Worker (workers/mock-ai), which
   * hands this Worker a `Fetcher` rather than an `Ai`, so `env.AI.run()` is a
   * TypeError there by design -- see that Worker's own doc comment, which
   * rules out teaching it to impersonate Workers AI and says code needing its
   * embedding path exercised should inject a fake at the call site instead.
   * Under `'stub'`, `search_writing` skips the embedding call and queries with
   * a fixed vector, which is enough to reach the limiter and the Vectorize
   * binding but proves nothing about retrieval: the query-side embedding call
   * is asserted directly in tests/mcp-search.test.ts, and the round trip
   * against the live index is verified by hand.
   */
  MCP_SEARCH_EMBEDDER?: string;
  /**
   * Test-only seam, the third of the same shape: it selects where
   * `signingKey` (src/lib/tier/grant.ts) gets the token signing key from.
   * ABSENT is the deployed behaviour -- read `RLME_TOKEN_SIGNING_KEY` out of
   * Secrets Store -- and `'test'` is the only other accepted value, selecting
   * a committed constant whose own name says it is not a secret. Anything
   * else throws rather than guessing.
   *
   * `'test'` is set on this Worker by tests/workers.ts, and it exists because
   * miniflare simulates `secrets_store_secrets` against a LOCAL store that
   * credential-free CI has never populated: `RLME_TOKEN_SIGNING_KEY.get()`
   * throws `Secret "RLME_TOKEN_SIGNING_KEY" not found` under the harness
   * (MEASURED, day 5 Task 2). tests/mcp-env.test.ts asserts that no
   * wrangler.jsonc declares this var, which is what keeps the deployed
   * behaviour coming from its absence.
   */
  RLME_TOKEN_KEY_SOURCE?: string;
  /**
   * Test-only seam, the fourth of the same shape, and declared here because
   * `fitEnv` (./gated.ts) hands it to `analyzeFit` (src/lib/fit/engine.ts),
   * whose own `FitEnv` is where the accepted values are written down. ABSENT
   * is the deployed behaviour -- run the engine -- and `'off'` is the only
   * other accepted value, making `analyzeFit` refuse before it reads KV, the
   * corpus or the model. Anything else throws rather than guessing.
   *
   * `'off'` is set on this Worker by tests/workers.ts, for the same reason
   * `MCP_SEARCH_EMBEDDER` is `'stub'` there: the harness overrides `AI` to a
   * service Worker, so `env.AI.run` is a TypeError here by design. Under the
   * seam, `analyze_fit` exercises everything AROUND the model call -- the
   * scope gate, the argument schema, the limiter, the audit row and the error
   * shape -- and the call itself is covered with a stub `Ai` in
   * tests/fit-engine.test.ts.
   */
  FIT_ENGINE?: string;

  /**
   * Day 6. The Turnstile secret, bound on THIS Worker as well as on the site.
   *
   * Not a new secret -- the same Secrets Store entry the site Worker already
   * binds. `POST /chat` (./chat.ts) verifies its own bot check, because a
   * Turnstile response token is the one thing the site can hand across a
   * service binding that this Worker can check for itself. It is a real
   * binding, so it is in `MCP_BINDING_NAMES` below as well.
   */
  RLME_TURNSTILE_SECRET_KEY: SecretsStoreSecret;

  /**
   * Test-only seam; see `TurnstileEnv.RLME_TURNSTILE_MODE` in
   * src/lib/turnstile.ts, where the accepted values are written down. `'stub'`
   * skips the secret read and the network call while STILL refusing an absent
   * token, which is what keeps ./chat.ts's `bot-check` branch reachable under
   * the harness.
   */
  RLME_TURNSTILE_MODE?: string;

  /**
   * Test-only seam, the fifth of the same shape; see `ChatEnv.CHAT_ENGINE` in
   * src/lib/chat/engine.ts. ABSENT runs the engine; `'off'` refuses after the
   * question's shape checks and before the breaker, the corpus or the model;
   * anything else throws.
   */
  CHAT_ENGINE?: string;

  /**
   * Test-only seam, the sixth of the same shape; see `JudgeEnv.JUDGE_ENGINE` in
   * src/lib/judge/engine.ts. ABSENT runs the judge; `'off'` refuses before the
   * model is called; anything else throws. Set on this Worker by
   * tests/workers.ts for the same reason `FIT_ENGINE` is.
   */
  JUDGE_ENGINE?: string;
}

/**
 * The same list as runtime data, for the drift test. `CORPUS_REFRESH`,
 * `MCP_SEARCH_EMBEDDER`, `RLME_TOKEN_KEY_SOURCE`, `FIT_ENGINE`,
 * `RLME_TURNSTILE_MODE`, `CHAT_ENGINE` and `JUDGE_ENGINE` are excluded deliberately: they are
 * test-only vars that no deployed environment and no config declares, so
 * `wrangler types` will never emit them. This list is the CONFIG's bindings,
 * and tests/mcp-env.test.ts fails in both directions if it drifts -- so adding
 * a seam here would break that test rather than document the seam.
 *
 * `RLME_TURNSTILE_SECRET_KEY` IS here, because it is a real binding day 6 added
 * to workers/mcp/wrangler.jsonc rather than a seam.
 */
export const MCP_BINDING_NAMES = [
  'DB',
  'KV_CONFIG',
  'KV_CACHE',
  'R2_ASSETS',
  'R2_PRIVATE',
  'AE',
  'AI',
  'VECTORIZE',
  'EVENTS',
  'RATE_LIMITER',
  'RLME_TOKEN_SIGNING_KEY',
  'SITE',
  'RLME_AI_GATEWAY_ID',
  'SITE_ORIGIN',
  'RLME_TURNSTILE_SECRET_KEY',
] as const;
