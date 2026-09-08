/**
 * The bindings THIS Worker declares, from workers/mcp/wrangler.jsonc.
 *
 * It replaces `Env & Pick<CorpusEnv, ...>`. That intersection borrowed the
 * SITE's generated `Env`, which declares `EMAIL`, `EVENTS`, `BROWSER`,
 * `ASSETS`, `MCP` and `RLME_TURNSTILE_SECRET_KEY` -- none of which are bound
 * here. `env.EVENTS.send(...)` typechecked and would have thrown at runtime,
 * and day 4 is exactly when the events queue (06 §3, day 6's work) looks
 * reachable. A type that names bindings the Worker does not have is worse
 * than no type.
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
  RATE_LIMITER: RateLimit;
  /** The `inference` bucket; see `limiterFor` in src/lib/mcp/limits.ts. */
  RATE_LIMITER_SEARCH: RateLimit;
  /** Day 5's, bound already. Nothing in day 4 may read it. */
  RLME_TOKEN_SIGNING_KEY: SecretsStoreSecret;
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
}

/**
 * The same list as runtime data, for the drift test. `CORPUS_REFRESH` and
 * `MCP_SEARCH_EMBEDDER` are excluded deliberately: they are test-only vars
 * that no deployed environment and no config declares, so `wrangler types`
 * will never emit them.
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
  'RATE_LIMITER',
  'RATE_LIMITER_SEARCH',
  'RLME_TOKEN_SIGNING_KEY',
  'RLME_AI_GATEWAY_ID',
  'SITE_ORIGIN',
] as const;
