import {
  CLIENT_INFO_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
  type ReadResourceResult,
  type ResourceTemplate,
  type ServerContext,
  type Variables,
} from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { hashArgs, recordToolCall, type AuditRow } from '../../../src/lib/mcp/audit';
import { checkLimit, retryHint, type ToolCost } from '../../../src/lib/mcp/limits';
import { hasScope, type Grant } from '../../../src/lib/tier/grant';
import type { Scope } from '../../../src/lib/tier/token';
import type { McpEnv } from './env';

// The registration seam, in its own module so the tool modules and the server
// module can both import it without importing each other.
//
// It used to live in ./server.ts, which made ./tools.ts import back from the
// module that imports it. That cycle was safe only while nothing in either
// module's TOP-LEVEL scope touched the other -- an invariant guarded by a
// comment and by nothing else, in a file four later tasks each add tools to.
// The first module-scope expression to reach across it (a `new ToolError(...)`
// constant, a shared `defineTool` wrapper, a `satisfies` against a value
// export) would throw at Worker module evaluation, and every request would
// then 500 with a stack pointing at the cycle rather than at the line that
// broke it. This module has no import back from either of them, so the graph
// cannot close.
/**
 * What a tool handler is given besides its arguments.
 *
 * `request` is the ORIGINAL HTTP request, not the JSON-RPC message: it is
 * where `CF-Connecting-IP` and `User-Agent` live. It is optional because
 * `McpRequestContext.requestInfo` is HTTP-only -- a stdio-served instance
 * would have none -- and a tool must not assume it is there.
 */
export interface ToolContext {
  env: McpEnv;
  ctx: ExecutionContext;
  request: Request | undefined;
  /**
   * The resolved grant, or `null` for a public caller. Resolved ONCE per HTTP
   * request in ./index.ts, before the server is built -- not per tool call,
   * because a single request's tier must not be able to change between two
   * tools in the same batch.
   */
  grant: Grant | null;
}

/** A failure whose message is safe to show the caller. Anything else is not. */
export class ToolError extends Error {}

/**
 * What `args_hash` says when the call failed before the hash could be taken.
 * Deliberately not 64 hex characters, so /ops can tell it apart from a digest
 * rather than reading it as one.
 */
const ARGS_HASH_UNAVAILABLE = 'unavailable';

/**
 * The caller's identity, as far as it is genuinely knowable.
 *
 * MEASURED against @modelcontextprotocol/server 2.0.0 and this harness rather
 * than assumed, because the obvious answer is wrong. `clientInfo` arrives in
 * `initialize`, and this server is stateless: `createMcpHandler` builds a
 * fresh `McpServer` per HTTP request, so a 2025-era client's handshake is not
 * carried into the `tools/call` that follows it. The 2026-07-28 revision
 * moved the same facts into a per-request `_meta` envelope, which the SDK
 * lifts onto `ctx.mcpReq.envelope` under the two exported key constants --
 * that, and only that, is a real per-call source for them.
 *
 * So: `user-agent` comes off the HTTP request and is nearly always there;
 * the other three are present only for a client that sends the modern
 * envelope, and are written NULL otherwise. Filling them in from anywhere
 * else would put a guess in an audit column, which is worse than a blank.
 */
function clientIdentity(
  request: Request | undefined,
  serverCtx: ServerContext | undefined,
): Pick<AuditRow, 'clientName' | 'clientVersion' | 'userAgent' | 'protocolVersion'> {
  // `RequestMetaEnvelope` is an intentionally empty type at the SDK's neutral
  // layer, so the envelope is read as the string-keyed bag it is on the wire.
  // The context is optional because this is called from the audit path, which
  // has to be able to write a row even when the failure it is recording
  // happened before the context was resolved -- and `mcpReq` is
  // optional-chained too, not just `serverCtx`: a `ServerContext` whose
  // `mcpReq` is itself absent is exactly the shape a request that failed
  // before that field was populated would have, and a bare `serverCtx?.mcpReq
  // .envelope` throws in precisely that case, escaping `guarded`'s `catch` and
  // handing the caller a raw internal message -- the one outcome that
  // function's own comment says nothing may do.
  const envelope = (serverCtx?.mcpReq?.envelope ?? {}) as Record<string, unknown>;
  const clientInfo = envelope[CLIENT_INFO_META_KEY] as
    { name?: unknown; version?: unknown } | undefined;
  const protocolVersion = envelope[PROTOCOL_VERSION_META_KEY];

  return {
    clientName: typeof clientInfo?.name === 'string' ? clientInfo.name : null,
    clientVersion: typeof clientInfo?.version === 'string' ? clientInfo.version : null,
    userAgent: request?.headers.get('user-agent') ?? null,
    protocolVersion: typeof protocolVersion === 'string' ? protocolVersion : null,
  };
}

/**
 * What one surface has to supply to be guarded, and nothing more.
 *
 * Every member here is a place the SDK genuinely forces the two registration
 * paths apart: a tool answers a refusal as a RESULT and a resource has to
 * THROW one, a tool's payload is `content` and a resource's is `contents`, a
 * tool's safe-message marker is `ToolError` and a resource's is
 * `ProtocolError`. Everything BETWEEN those differences is `guarded` below,
 * once.
 */
interface CallContract<C, R> {
  /** The name the audit row records, and the name the limiter keys on. */
  auditName: string;
  /** Which limiter bucket this draws from (src/lib/mcp/limits.ts). */
  cost: ToolCost;
  /** `mcp/<surface>` in the log line a failure writes. */
  surface: 'tool' | 'resource';
  /**
   * Reads the SDK's positional parameters into this surface's own call
   * payload. Runs INSIDE the guard's try: both surfaces' parameter shapes are
   * measured rather than declared, so a read that turns out to be wrong has
   * to be audited like any other failure rather than escaping unrecorded.
   */
  read: (params: unknown[]) => C;
  /**
   * What `args_hash` is taken over. Separate from `read` because the payload
   * and its hashable form are not always the same object: `canonicalize`
   * (src/lib/mcp/audit.ts) walks own enumerable properties, and a `URL`'s are
   * all on its prototype, so hashing one directly would digest `{}` and give
   * every URI in the table the same `args_hash`.
   */
  hashable: (call: C) => unknown;
  /** The handler, and the wrapping of whatever it returns. */
  run: (call: C) => Promise<R>;
  /**
   * How this surface answers a refusal. May THROW instead of returning: a
   * surface with no error-result shape has no other way to say it.
   */
  refuse: () => R;
  /**
   * How this surface answers a failure, having already logged it. Same
   * licence to throw, and the same obligation either way -- only a message
   * this Worker wrote deliberately may reach the caller.
   */
  fail: (error: unknown) => R;
}

/**
 * The obligations every call to this Worker carries, in ONE place.
 *
 * Rate limiting and the audit trail (03 §3) are cross-cutting, and the only
 * way they stay true of every call is for there to be one implementation of
 * them. `defineTool` and `defineResource` are two registration paths because
 * the SDK gives tools and resources different contracts -- but they are two
 * thin adapters over this function, not two copies of it.
 *
 * The sharpest reason it is one function rather than two similar ones is four
 * lines down, and day 5 is where it paid: `tier`, `audience` and `grantJti`
 * WERE hard-coded to the public tier and are now resolved from the request's
 * token. Written twice, that change could have landed on one surface and
 * missed the other, and the miss would have been silent -- an audit trail
 * that records `public` for a scoped call is worse than one that records
 * nothing, because it reads as evidence. There was one row builder to change,
 * and this is it. It stays one.
 */
async function guarded<C, R>(
  tc: ToolContext,
  contract: CallContract<C, R>,
  params: unknown[],
): Promise<R> {
  const started = Date.now();

  // Both are resolved inside the try below, so both need a value the audit
  // path can fall back on. `args_hash` is NOT NULL, and a row saying the hash
  // could not be computed is worth more than a call that vanishes.
  let argsHash = ARGS_HASH_UNAVAILABLE;
  let serverCtx: ServerContext | undefined;

  const audit = (outcome: AuditRow['outcome']) => {
    // `audit('error')` runs inside the `catch` below, which is the LAST place
    // in this function anything can still catch a throw -- so building the
    // row here must not itself throw, or the failure escapes `guarded`
    // entirely and the SDK copies its message straight to the caller, same as
    // the escape this whole function exists to close. `clientIdentity` cannot
    // throw once `mcpReq` is optional-chained (see its own comment), but this
    // is wrapped anyway so a future change to it, or to anything else added
    // here, has nowhere to reopen that gap.
    let identity: Pick<AuditRow, 'clientName' | 'clientVersion' | 'userAgent' | 'protocolVersion'>;
    try {
      identity = clientIdentity(tc.request, serverCtx);
    } catch (identityError) {
      console.error('mcp/audit: failed to read client identity', identityError);
      identity = { clientName: null, clientVersion: null, userAgent: null, protocolVersion: null };
    }

    tc.ctx.waitUntil(
      recordToolCall(tc.env.DB, {
        calledAt: new Date().toISOString(),
        tool: contract.auditName,
        argsHash,
        // Day 5: resolved from the request's token, in ONE place, exactly as
        // this function's own comment promised. `tier` is derived from the
        // grant's presence rather than passed alongside it, so a caller
        // cannot hand this builder a grant and a mismatched tier.
        tier: tc.grant ? 'private' : 'public',
        audience: tc.grant?.audience ?? null,
        grantJti: tc.grant?.jti ?? null,
        ...identity,
        outcome,
        durationMs: Date.now() - started,
      }),
    );
  };

  // ONE try around the whole body, deliberately: everything before the
  // handler can throw too -- a limiter object that rejects, a deploy whose
  // `migrations` never created the `RateLimiter` class so `env.RATE_LIMITER`
  // resolves to nothing -- and a throw that escapes here
  // breaks both of this seam's guarantees at once. The call would go
  // unaudited, so the table would under-report exactly the failures worth
  // seeing; and the SDK answers an escaped throw by copying its message
  // straight to the caller -- `createToolError(error.message)` for a tool,
  // `message: error.message` at the Protocol layer for a resource -- handing
  // a public caller the raw internal text. Nothing may leave this function
  // except through `run`, `refuse` or `fail`.
  try {
    // MEASURED for both surfaces: the `ServerContext` is the LAST parameter
    // the SDK passes, whatever it passes before it. Taken before `read` so
    // that a read which throws still audits a row with the caller's identity
    // on it.
    serverCtx = params[params.length - 1] as ServerContext;
    const call = contract.read(params);
    argsHash = await hashArgs(contract.hashable(call));

    // One `await` on the limiter object, before the handler and before
    // anything the handler would spend. See src/lib/mcp/limits.ts and
    // workers/mcp/src/rate-limiter.ts: this used to be a `ratelimits` binding
    // and is now a Durable Object, because the binding did not enforce in
    // production (#29). The seam did not move -- this line is still the only
    // place a call is limited, and it is still checked BEFORE the handler
    // runs, which is what makes a refusal cost nothing.
    const allowed = await checkLimit(
      tc.env,
      contract.cost,
      tc.request,
      contract.auditName,
      tc.grant,
    );
    if (allowed) {
      const answer = await contract.run(call);
      audit('ok');
      return answer;
    }

    audit('rate_limited');
    // Falls out of the try WITHOUT answering, deliberately: a refusal is
    // answered below instead. `refuse()` may throw rather than return -- a
    // surface with no error result has no other way to say it -- and a throw
    // raised in here would be caught below and audited a second time, as an
    // `error`. Falling out is also the only path that reaches the bottom of
    // this function: every other one returns from inside the try or the catch.
  } catch (error) {
    audit('error');
    console.error(`mcp/${contract.surface}: ${contract.auditName} failed`, error);
    return contract.fail(error);
  }

  return contract.refuse();
}

/**
 * The ONLY way a tool is registered.
 *
 * Rate limiting (03 §3) and the audit trail (03 §3) are cross-cutting
 * obligations, and the only way they stay true of every tool is for there to
 * be one registration path. Calling `server.registerTool` directly ships an
 * unaudited, unlimited tool -- which is why the review gate for this repo
 * treats that as a defect rather than a style difference.
 *
 * Everything a call is guarded BY lives in `guarded` above; what is here is
 * only what the tool surface does differently.
 */
export function defineTool<A>(
  server: McpServer,
  tc: ToolContext,
  spec: {
    name: string;
    title: string;
    description: string;
    cost: ToolCost;
    /**
     * The scope a grant must carry for this tool to run at all. Absent means
     * public -- every day-3 and day-4 tool, unchanged. Enforced inside
     * `guarded` (see `run` below), so a refusal is audited and limited like
     * any other call rather than answered off to the side.
     */
    scope?: Scope;
    inputSchema?: z.ZodObject<z.ZodRawShape>;
    outputSchema?: z.ZodObject<z.ZodRawShape>;
  },
  handler: (args: A, tc: ToolContext) => Promise<unknown>,
): void {
  /**
   * MEASURED, not assumed: the SDK's `createToolExecutor` calls a handler as
   * `(args, ctx)` when the tool has an `inputSchema` and as `(ctx)` alone
   * when it does not. The context is therefore always LAST -- which is why
   * `guarded` takes it from the end -- and the arguments are only there when
   * something was declared to parse them into. Taking the first parameter as
   * `args` unconditionally would hand a no-argument tool its own
   * `ServerContext` to hash, and since that object carries the JSON-RPC id,
   * every call would get a different `args_hash` and the audit table would
   * never show a repeated query.
   */
  const argsOf = (params: unknown[]) => (params.length > 1 ? params[0] : undefined) as A;

  const invoke = (...params: unknown[]): Promise<CallToolResult> =>
    guarded<A, CallToolResult>(
      tc,
      {
        auditName: spec.name,
        cost: spec.cost,
        surface: 'tool',
        read: argsOf,
        // A tool's arguments ARE its hashable form; `hashArgs` canonicalises
        // them, and `undefined` and `{}` deliberately hash the same.
        hashable: (args) => args,
        run: async (args) => {
          // The SECOND of two independent mechanisms. The first is
          // registration: `registerGatedTools` in ./gated.ts does not register
          // a gated tool at all unless the grant carries its scope, so a caller
          // without one cannot see this tool in `tools/list` or name it in
          // `tools/call`. (That logic was written to live in ./server.ts, which
          // is what this comment used to point at; day 5 Task 7 put it in its
          // own module and ./server.ts now only calls it.) This
          // check is what makes that true even if a future edit registers a
          // tool unconditionally by mistake -- "structural, not filtered"
          // (09 §3) is worth more than one guarantee.
          //
          // INSIDE the guard, not before it, and that placement is the whole
          // point. An early return in `invoke` would answer the same sentence
          // while writing no audit row and spending no limiter budget -- and
          // this is the one call an operator most needs to see, because
          // reaching it means either someone is probing for gated tool names
          // or mechanism 1 has regressed. Neither event may be silent, and
          // src/lib/mcp/limits.ts's own opening comment ("nothing here is
          // optional for a tool") would have become false the moment one tool
          // could route around `checkLimit`.
          //
          // So a refusal costs limiter budget, deliberately: an unscoped
          // caller hammering a gated name is exactly who should meet a bucket.
          // A `ToolError` because that is the only class whose message
          // `fail` copies to the caller -- the sentence is unchanged, and the
          // row it now leaves behind reads `outcome: 'error'`.
          //
          // BOTH HALVES OF THAT ARE PINNED, and were not until deferred minor
          // L624: tests/mcp-gated.test.ts reaches this branch by handing
          // `defineTool` a registrar that captures `invoke`, and asserts the
          // audit row AND the spent token against the bucket itself. The
          // regression named two paragraphs up -- this check moved to an early
          // return in `invoke` -- is the mutation those assertions were
          // measured against, and it turns both of them red.
          if (spec.scope !== undefined && !hasScope(tc.grant, spec.scope)) {
            throw new ToolError(`${spec.name} requires a scoped token.`);
          }
          const output = await handler(args, tc);
          return {
            // A STRING handler result is already text and is passed through
            // verbatim; anything else is serialised as JSON. Not a
            // convenience: `JSON.stringify` of a string returns a quoted JSON
            // literal with its newlines escaped, so a tool answering with a
            // markdown document would hand the caller
            // `"# Ryan Lindsey\n\n..."` -- one line, in quotes, with
            // backslash-n where the blank lines were. Measured in Task 6
            // against `get_resume`'s markdown format before this line existed.
            content: [
              {
                type: 'text' as const,
                text: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
              },
            ],
            ...(spec.outputSchema ? { structuredContent: output as Record<string, unknown> } : {}),
          };
        },
        // A tool RESULT, not a thrown transport error: the client should read
        // a sentence explaining what happened rather than lose the connection.
        refuse: () => ({
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Rate limit reached for ${spec.name}. Try again in ${retryHint(spec.cost)}.`,
            },
          ],
        }),
        // Only a ToolError's message reaches the caller. Anything else could
        // carry an internal path or a stack, and this surface is public.
        fail: (error) => {
          const text =
            error instanceof ToolError
              ? error.message
              : `${spec.name} failed. The error was logged.`;
          return { isError: true, content: [{ type: 'text' as const, text }] };
        },
      },
      params,
    );

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      // Spread rather than set: an `inputSchema: undefined` key resolves to
      // the deprecated raw-shape overload -- the trap day 3 recorded when it
      // registered `get_contact` with no schema at all.
      ...(spec.inputSchema ? { inputSchema: spec.inputSchema } : {}),
      ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
    },
    invoke,
  );
}

/**
 * The JSON-RPC code a REFUSED resource read answers with.
 *
 * MCP defines no rate-limit code, and no member of `ProtocolErrorCode` is
 * honest here: `InternalError` (-32603) would claim this server broke, and
 * `InvalidParams` (-32602) carrying a `uri` is specifically how the SDK spells
 * "resource not found" (`ResourceNotFoundError`) -- the one wrong answer a
 * client might act on, by dropping a URI that is perfectly fine. -32000 sits
 * in JSON-RPC 2.0's reserved implementation-defined server-error range
 * (-32000..-32099), and it is already the code this Worker's own transport
 * uses for its refusals: the `agents` handler answers a rejected Origin with
 * `{"code":-32000,"message":"Invalid Origin: <host>"}` (see ./index.ts).
 */
const RESOURCE_RATE_LIMITED = -32000;

/**
 * The ONLY way a resource is registered, and the one place the "there is
 * exactly one tool-registration path" rule does not apply.
 *
 * It does not apply because a resource is not a tool and CANNOT go through
 * `defineTool`: `resources/read` has its own handler shape (a `URL`, plus the
 * template's filled-in variables), its own result (`contents`, not
 * `content`), and no `isError` result to put a sentence in -- a failed read
 * is a JSON-RPC error. What the rule is FOR applies undiminished, though.
 * 03 §3 says every call is logged and every call is limited, and a resource
 * read is a read: `writing://{slug}` serves the same documents `get_post`
 * serves, and `get_post` is limited at 60/60s, so an unlimited resource path
 * to identical content would make that limiter decorative -- something a
 * client routes around rather than something that bounds it.
 *
 * So this is the resource equivalent of `defineTool`: not a parallel
 * implementation of the guarantees but the same one, through the same
 * `guarded` above, with only the three SDK-forced differences supplied here.
 * Registering a resource by calling `server.registerResource` directly is the
 * same defect as calling `server.registerTool` directly, for the same reason,
 * and the invariant then holds across the whole surface rather than over half
 * of it.
 */
export function defineResource(
  server: McpServer,
  tc: ToolContext,
  spec: {
    /**
     * The resource's client-visible name. The audit trail and the limiter
     * both know it as `resource:<name>` -- derived once, below, so the two
     * cannot drift apart. The prefix is what keeps the buckets separate: no
     * tool this Worker registers has a colon in its name, so a resource
     * shares a bucket with neither a tool nor the other resource.
     */
    name: string;
    title: string;
    description: string;
    /** Applied to the listing AND to every `contents` entry this emits. */
    mimeType: string;
    cost: ToolCost;
    /** A fixed URI, or a template whose `list` enumerates what it covers. */
    uri: string | ResourceTemplate;
  },
  handler: (uri: URL, variables: Variables, tc: ToolContext) => Promise<string>,
): void {
  const audited = `resource:${spec.name}`;

  /**
   * MEASURED against @modelcontextprotocol/server 2.0.0, and the mirror image
   * of the note in `defineTool`: the SDK calls a fixed resource's callback as
   * `(uri, ctx)` and a template's as `(uri, variables, ctx)`. The URI is
   * therefore always FIRST and the context always LAST, with the variables in
   * between and only for a template -- so `guarded` takes the context from the
   * end rather than from a fixed position, exactly as it does for a tool.
   */
  const invoke = (...params: unknown[]): Promise<ReadResourceResult> =>
    guarded<{ uri: URL; variables: Variables }, ReadResourceResult>(
      tc,
      {
        auditName: audited,
        cost: spec.cost,
        surface: 'resource',
        read: (params) => ({
          uri: params[0] as URL,
          variables: (params.length > 2 ? params[1] : {}) as Variables,
        }),
        // The whole of `resources/read`'s params is `{ uri }`, hashed the same
        // way a tool's arguments are, so /ops can see the same document read
        // twice without the table storing which document it was. `uri.href`
        // rather than the `URL`: see `CallContract.hashable`.
        hashable: ({ uri }) => ({ uri: uri.href }),
        run: async ({ uri, variables }) => {
          const text = await handler(uri, variables, tc);
          return { contents: [{ uri: uri.href, mimeType: spec.mimeType, text }] };
        },
        // THROWN, where a tool returns an error result: `resources/read` has
        // no `isError` shape, and answering with `contents` would hand the
        // client a refusal notice dressed as the document it asked for.
        //
        // `spec.name`, not `audited`: the caller knows this resource by the
        // name `resources/list` gave it, and the `resource:` prefix is an
        // internal key-space convention it has no way to have seen.
        refuse: () => {
          throw new ProtocolError(
            RESOURCE_RATE_LIMITED,
            `Rate limit reached for ${spec.name}. Try again in ${retryHint(spec.cost)}.`,
          );
        },
        // Only a `ProtocolError` -- one this Worker constructed deliberately,
        // such as the `ResourceNotFoundError` a miss raises -- reaches the
        // caller. MEASURED: the Protocol layer copies `error.message` onto the
        // JSON-RPC error response verbatim for anything thrown out of a
        // request handler, so an internal path or a stack would be published
        // as-is.
        fail: (error) => {
          if (error instanceof ProtocolError) throw error;
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `${spec.name} could not be read. The error was logged.`,
          );
        },
      },
      params,
    );

  const config = { title: spec.title, description: spec.description, mimeType: spec.mimeType };
  // The two branches are IDENTICAL on purpose, and neither is redundant:
  // `registerResource` is overloaded on its URI argument -- `(name, string,
  // config, ReadResourceCallback)` and `(name, ResourceTemplate, config,
  // ReadResourceTemplateCallback)` -- and a `string | ResourceTemplate` union
  // matches neither overload. The `typeof` narrows the union so an overload
  // can be picked; it exists for the type checker, not for the runtime.
  if (typeof spec.uri === 'string') server.registerResource(spec.name, spec.uri, config, invoke);
  else server.registerResource(spec.name, spec.uri, config, invoke);
}
