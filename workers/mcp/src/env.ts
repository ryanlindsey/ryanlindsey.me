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
}

/**
 * The same list as runtime data, for the drift test. `CORPUS_REFRESH` is
 * excluded deliberately: it is a test-only var that no deployed environment
 * and no config declares, so `wrangler types` will never emit it.
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
