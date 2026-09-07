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
import { limiterFor, limitKeyFor, type ToolCost } from '../../../src/lib/mcp/limits';
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
  // happened before the context was resolved.
  const envelope = (serverCtx?.mcpReq.envelope ?? {}) as Record<string, unknown>;
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
 * The ONLY way a tool is registered.
 *
 * Rate limiting (03 §3) and the audit trail (03 §3) are cross-cutting
 * obligations, and the only way they stay true of every tool is for there to
 * be one registration path. Calling `server.registerTool` directly ships an
 * unaudited, unlimited tool -- which is why the review gate for this repo
 * treats that as a defect rather than a style difference.
 */
export function defineTool<A>(
  server: McpServer,
  tc: ToolContext,
  spec: {
    name: string;
    title: string;
    description: string;
    cost: ToolCost;
    inputSchema?: z.ZodObject<z.ZodRawShape>;
    outputSchema?: z.ZodObject<z.ZodRawShape>;
  },
  handler: (args: A, tc: ToolContext) => Promise<unknown>,
): void {
  /**
   * MEASURED, not assumed: the SDK's `createToolExecutor` calls a handler as
   * `(args, ctx)` when the tool has an `inputSchema` and as `(ctx)` alone
   * when it does not. The context is therefore always LAST and the arguments
   * are only there when something was declared to parse them into. Taking the
   * first parameter as `args` unconditionally would hand a no-argument tool
   * its own `ServerContext` to hash -- and since that object carries the
   * JSON-RPC id, every call would get a different `args_hash` and the audit
   * table would never show a repeated query.
   */
  const invoke = async (...params: unknown[]): Promise<CallToolResult> => {
    const started = Date.now();

    // Both are resolved inside the try below, so both need a value the audit
    // path can fall back on. `args_hash` is NOT NULL, and a row saying the
    // hash could not be computed is worth more than a call that vanishes.
    let argsHash = ARGS_HASH_UNAVAILABLE;
    let serverCtx: ServerContext | undefined;

    const audit = (outcome: AuditRow['outcome']) =>
      tc.ctx.waitUntil(
        recordToolCall(tc.env.DB, {
          calledAt: new Date().toISOString(),
          tool: spec.name,
          argsHash,
          // Day 5 resolves these two from the request's token. Hard-coded
          // here so the public tier cannot accidentally write an audience.
          tier: 'public',
          audience: null,
          ...clientIdentity(tc.request, serverCtx),
          outcome,
          durationMs: Date.now() - started,
        }),
      );

    // ONE try around the whole body, deliberately: everything before the
    // handler can throw too -- a limiter binding that rejects, a
    // misconfigured deploy missing RATE_LIMITER_SEARCH -- and a throw that
    // escapes here breaks both of this seam's guarantees at once. The call
    // would go unaudited, so the table would under-report exactly the
    // failures worth seeing; and the SDK's own `tools/call` wrapper answers
    // an escaped throw with `createToolError(error.message)`, handing the raw
    // internal message to a public caller. Nothing may leave this function
    // except through the catch below.
    try {
      // MEASURED: see the note above. Context last, arguments first and only
      // when there is more than one parameter.
      serverCtx = params[params.length - 1] as ServerContext;
      const args = (params.length > 1 ? params[0] : undefined) as A;
      argsHash = await hashArgs(args);

      const { success } = await limiterFor(tc.env, spec.cost).limit({
        key: limitKeyFor(tc.request, spec.name),
      });
      if (!success) {
        audit('rate_limited');
        // A tool RESULT, not a thrown transport error: the client should read
        // a sentence explaining what happened rather than lose the connection.
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Rate limit reached for ${spec.name}. Try again in a minute.`,
            },
          ],
        };
      }

      const output = await handler(args, tc);
      audit('ok');
      return {
        // A STRING handler result is already text and is passed through
        // verbatim; anything else is serialised as JSON. Not a convenience:
        // `JSON.stringify` of a string returns a quoted JSON literal with its
        // newlines escaped, so a tool answering with a markdown document would
        // hand the caller `"# Ryan Lindsey\n\n..."` -- one line, in quotes,
        // with backslash-n where the blank lines were. Measured in Task 6
        // against `get_resume`'s markdown format before this line existed.
        content: [
          {
            type: 'text' as const,
            text: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
          },
        ],
        ...(spec.outputSchema ? { structuredContent: output as Record<string, unknown> } : {}),
      };
    } catch (error) {
      audit('error');
      // Only a ToolError's message reaches the caller. Anything else could
      // carry an internal path or a stack, and this surface is public.
      console.error(`mcp/tool: ${spec.name} failed`, error);
      const text =
        error instanceof ToolError ? error.message : `${spec.name} failed. The error was logged.`;
      return { isError: true, content: [{ type: 'text' as const, text }] };
    }
  };

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
 * So this is the resource equivalent of `defineTool`, deliberately built from
 * the same parts: the same `limiterFor`/`limitKeyFor`, the same
 * `hashArgs`/`recordToolCall`, the same three outcomes, and the same refusal
 * to let an internal error message reach a public caller. Registering a
 * resource by calling `server.registerResource` directly is the same defect
 * as calling `server.registerTool` directly, for the same reason, and the
 * invariant then holds across the whole surface rather than over half of it.
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
   * between and only for a template -- so the context is taken from the end
   * rather than from a fixed position, exactly as `defineTool` takes its own.
   */
  const invoke = async (...params: unknown[]): Promise<ReadResourceResult> => {
    const started = Date.now();

    const uri = params[0] as URL;
    const serverCtx = params[params.length - 1] as ServerContext;
    const variables = (params.length > 2 ? params[1] : {}) as Variables;

    // `args_hash` is NOT NULL, and a row saying the hash could not be computed
    // is worth more than a read that vanishes from the table.
    let argsHash = ARGS_HASH_UNAVAILABLE;
    // Identity-compared in the catch below, so the refusal this function
    // raises itself is not audited a second time as an `error`.
    let refusal: ProtocolError | undefined;

    const audit = (outcome: AuditRow['outcome']) =>
      tc.ctx.waitUntil(
        recordToolCall(tc.env.DB, {
          calledAt: new Date().toISOString(),
          tool: audited,
          argsHash,
          // Hard-coded for the same reason `defineTool` hard-codes them: day 5
          // resolves both from the request's token, and until then the public
          // tier must not be able to write an audience.
          tier: 'public',
          audience: null,
          ...clientIdentity(tc.request, serverCtx),
          outcome,
          durationMs: Date.now() - started,
        }),
      );

    // ONE try around the whole body, for the reasons `defineTool` gives at
    // length: everything before the handler can throw too, and a throw that
    // escapes here would break both guarantees at once -- an unaudited read,
    // and a raw internal message copied onto the wire.
    try {
      // The whole of `resources/read`'s params is `{ uri }`, hashed the same
      // way a tool's arguments are, so /ops can see the same document read
      // twice without the table storing which document it was.
      argsHash = await hashArgs({ uri: uri.href });

      const { success } = await limiterFor(tc.env, spec.cost).limit({
        key: limitKeyFor(tc.request, audited),
      });
      if (!success) {
        audit('rate_limited');
        // THROWN, where `defineTool` returns an error result: `resources/read`
        // has no `isError` shape, and answering with `contents` would hand the
        // client a refusal notice dressed as the document it asked for.
        // `spec.name`, not `audited`: the caller knows this resource by the
        // name `resources/list` gave it, and the `resource:` prefix is an
        // internal key-space convention it has no way to have seen.
        refusal = new ProtocolError(
          RESOURCE_RATE_LIMITED,
          `Rate limit reached for ${spec.name}. Try again in a minute.`,
        );
        throw refusal;
      }

      const text = await handler(uri, variables, tc);
      audit('ok');
      return { contents: [{ uri: uri.href, mimeType: spec.mimeType, text }] };
    } catch (error) {
      // The limiter's own refusal: already audited above, and its message was
      // written for the caller. Identity, and guarded against `refusal` still
      // being undefined -- a handler that threw `undefined` must not be
      // mistaken for a refusal and skip its audit row.
      if (refusal !== undefined && error === refusal) throw error;

      audit('error');
      console.error(`mcp/resource: ${audited} failed`, error);
      // Only a `ProtocolError` -- one this Worker constructed deliberately,
      // such as the `ResourceNotFoundError` a miss raises -- reaches the
      // caller. MEASURED: the Protocol layer copies `error.message` onto the
      // JSON-RPC error response verbatim for anything thrown out of a request
      // handler, so an internal path or a stack would be published as-is.
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `${spec.name} could not be read. The error was logged.`,
      );
    }
  };

  const config = { title: spec.title, description: spec.description, mimeType: spec.mimeType };
  // Branched rather than passed through: `registerResource` is overloaded on
  // the URI argument, and a `string | ResourceTemplate` union matches neither
  // overload.
  if (typeof spec.uri === 'string') server.registerResource(spec.name, spec.uri, config, invoke);
  else server.registerResource(spec.name, spec.uri, config, invoke);
}
