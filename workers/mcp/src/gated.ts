import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  analyzeFit,
  FitUnavailable,
  type FitEnv,
  type FitResult,
} from '../../../src/lib/fit/engine';
import { readCampaignForAudience } from '../../../src/lib/tier/campaigns';
import type { Grant } from '../../../src/lib/tier/grant';
import {
  caseStudyDetailKey,
  narrativeKey,
  PROFILE_KEYS,
  readPrivateDoc,
} from '../../../src/lib/tier/private-docs';
import type { Scope } from '../../../src/lib/tier/token';
import { judge, JudgeUnavailable, type JudgeEnv } from '../../../src/lib/judge/engine';
import { defineTool, ToolError, type ToolContext } from './define';
import type { McpEnv } from './env';
import { JUDGE_INPUT } from './judge-schema';

// The private tier's tools (03 §2). Registered ONLY for a request whose grant
// carries the matching scope -- see ./server.ts. An unauthenticated caller's
// `McpServer` does not contain these tools, so `tools/list` cannot leak a name
// and `tools/call` answers the SDK's own unknown-tool error, which enumerates
// nothing.
//
// Five of the six tools here are a document read. There is no query interface,
// no key parameter, and no listing: a general-purpose read primitive over the
// private bucket is exactly the shape the partition
// (src/lib/tier/private-docs.ts) exists to avoid handing to a caller, however
// well scoped their token is. The sixth, `analyze_fit`, reads no private
// document at all -- it is the fit engine's MCP frontend, and everything it
// sees is published.
//
// Vocabulary (09 §2): these names and descriptions are code, and code is a
// public surface -- a granted caller can screenshot `tools/list`. They say
// audience, scope, private tier, engagement, fit analysis. What the DOCUMENTS
// say is runtime data and is not this file's business.

/** The sentence a caller sees when a document has not been deployed yet. */
const NOT_DEPLOYED = 'That document is not available on this tier yet.';

/**
 * One private-tier tool, declared once and read by both surfaces that need it.
 *
 * THE DUPLICATION THIS EXISTS TO KILL was a table of tool names in
 * ./server.ts, hand-maintained beside the registrations here and checked by
 * nothing. Rename a tool in this file and forget that one, and every granted
 * caller was sent an `initialize` map naming a tool `tools/list` does not
 * carry -- silently, on the one surface whose job is to say what a token is
 * for. `gatedToolLines` below builds those lines from these same entries, so
 * the name in the map and the name in the listing are now the same string
 * rather than two copies of it.
 */
interface GatedTool {
  /**
   * The scope a grant must carry. Read TWICE from this one field -- by
   * `registerGatedTools` to decide whether to register the tool, and by
   * `register` below to declare the scope `defineTool` re-checks at call time.
   * That is what makes the two mechanisms 09 §3 asks for impossible to put out
   * of step with each other: they are not two values that must agree, they are
   * one value read twice.
   */
  scope: Scope;
  /** As `tools/list` reports it, and as the granted instruction map names it. */
  name: string;
  /** As `tools/list` reports it. */
  title: string;
  /** As `tools/list` reports it. Sometimes an instruction -- see `analyze_fit`. */
  description: string;
  /**
   * The predicate half of the instruction line, which ./server.ts renders as
   * `${name}: ${summary}`. Deliberately not the `description`: that string is
   * written for an agent about to call the tool, and the map is a one-line
   * index of what a token opened.
   *
   * tests/mcp-gated.test.ts asserts the WHOLE granted block verbatim for a
   * grant carrying every scope, so an edit to any of these six is an edit to a
   * test as well. That is the point of the field: a name can be derived, prose
   * cannot, so the prose is reviewed instead.
   */
  summary: string;
  /**
   * Registers it, through `defineTool` and nothing else (03 §3). Handed the
   * entry it was declared in, so the name, title, description and scope that
   * reach `defineTool` ARE the ones the map above is built from.
   */
  register: (server: McpServer, tc: ToolContext, tool: GatedTool, grant: Grant) => void;
}

/**
 * The fields `defineTool` declares that come from the TABLE, spelled ONCE.
 *
 * Four sites -- `defineDocumentTool` below, plus the three tools registered
 * inline (`get_case_study_details`, `get_application_narrative`,
 * `analyze_fit`) -- used to write `name`, `title`, `description` and `scope`
 * out of the entry themselves (deferred minor L961). Four sites is four
 * places a future edit can register a name the instruction map is not
 * built from. tests/mcp-gated.test.ts's agreement test would catch it, which
 * makes that a NARROWER divergence site than the hand-maintained name list
 * `GATED_TOOL_NAMES` replaced -- narrower, not none. They read this instead,
 * so the registered spelling and the mapped one are one expression rather
 * than four copies of it.
 *
 * Returns ONLY those four, and that is what makes spreading the RESULT safe
 * where spreading the ENTRY is not: `defineTool` should be given what it
 * declares and nothing else, and a `GatedTool` also carries this module's
 * `summary` and `register`. `cost` and `inputSchema` are deliberately absent
 * -- they are not in the table, and each call site is the only thing that
 * knows its own.
 */
function specOf(tool: GatedTool): Pick<GatedTool, 'name' | 'title' | 'description' | 'scope'> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    scope: tool.scope,
  };
}

/**
 * One document tool. A local helper rather than three copies, and the shape
 * is the same every time: resolve a key, read it, hand back markdown.
 *
 * `scope` used to be FIXED to `'profile'` in here rather than taken from the
 * caller, because a helper taking a scope as an argument would let a future
 * tool declare one scope while being registered under another -- precisely the
 * divergence `defineTool`'s call-time check exists to catch. It now comes from
 * `tool.scope`, and the property is stronger rather than weaker: that is the
 * same field `registerGatedTools` reads to decide whether to register the tool
 * at all, so the two cannot say different things. Passing a scope that came
 * from anywhere else would reopen the hole.
 *
 * The four table-derived fields come from `specOf` rather than being written
 * out here, and the spread below is of THAT narrow object rather than of the
 * entry. The rule it used to be justified by is unchanged -- `defineTool`
 * should be given what it declares and nothing else, and spreading a
 * `GatedTool` would hand the SDK this module's `summary` and `register` as
 * well -- but a helper that returns only the four satisfies it without the
 * field-by-field copy, at every call site rather than at this one.
 */
function defineDocumentTool(
  server: McpServer,
  tc: ToolContext,
  tool: GatedTool,
  key: string,
): void {
  defineTool(
    server,
    tc,
    {
      ...specOf(tool),
      cost: 'cheap',
    },
    async (_args, tc) => {
      const text = await readPrivateDoc(tc.env, key);
      if (text === null) throw new ToolError(NOT_DEPLOYED);
      return text;
    },
  );
}

const CASE_STUDY_INPUT = z.object({
  slug: z.string().describe('The slug of a published case study, as list_case_studies reports it.'),
});

/**
 * The one argument `analyze_fit` takes, and the floor on it is load-bearing
 * rather than defensive.
 *
 * A frontier-model call over the whole corpus (`cost: 'expensive'`) spent on
 * two lines of text produces a confident report about almost nothing, and the
 * reader cannot tell that from a real one -- which is the same failure the
 * engine's truncation guard exists to prevent, arriving from the other end.
 * The message says what to do about it, because a schema error is answered to
 * the CALLING AGENT and it is the one that can fix this.
 *
 * The ceiling is the model's problem rather than a limit anyone will meet:
 * 60k characters is far more than a description and far less than the context
 * window.
 */
const FIT_INPUT = z.object({
  target_description: z
    .string()
    .min(200, 'Paste the full description; a few lines is not enough to analyse.')
    .max(60_000)
    .describe('The full text of the description to compare against.'),
});

/** The namespace a configured narrative document is confined to. */
const NARRATIVE_PREFIX = 'narrative/';
const NARRATIVE_SUFFIX = '.md';

/**
 * A campaign's configured `gated_narrative_doc`, or `null` if it names
 * anything but a document in the narrative namespace.
 *
 * THE SCOPES ARE THE REASON THIS EXISTS, and the reason is worth stating in
 * full because the obvious objection -- "that value is operator-authored, not
 * caller input" -- is true and does not settle it.
 *
 * `parseCampaign` (src/lib/tier/campaigns.ts) accepts any string here. Handed
 * to `readPrivateDoc` unchecked, a campaign entry naming
 * `profile/compensation.md` would serve a PROFILE-tier document to a token
 * carrying only `narrative`. That is not a traversal -- the key is perfectly
 * well formed -- it is a scope crossing, and it would defeat the least
 * privilege split the four scopes exist to draw (src/lib/tier/token.ts's
 * `SCOPES`: "a token minted for a fit demonstration should not also be able to
 * read reference contacts"). A typo in a hand-typed `wrangler kv key put` is
 * enough to cause it, and nothing downstream would notice: the tool would
 * answer 200 with the wrong tier's document.
 *
 * So the config path keeps exactly the property it was taken for -- a document
 * can be renamed without re-minting tokens -- and keeps it INSIDE the
 * namespace. Renaming is what it is for; reaching into another scope's
 * namespace never was.
 *
 * VALIDATED BY RECONSTRUCTION rather than by a second regex: the key is
 * accepted only if `narrativeKey` (the convention path) would have produced
 * that exact string for the segment inside it. So the set this admits is
 * precisely the set the convention could also have named -- there is no third
 * shape to keep in step -- and it inherits `safeSegment`'s refusal of slashes,
 * dots and percent-encoding for free. If the key template in
 * src/lib/tier/private-docs.ts ever changes, this equality stops holding and
 * every configured key is refused, which is the safe direction to fail in.
 */
function narrativeKeyFromConfig(configured: string): string | null {
  if (!configured.startsWith(NARRATIVE_PREFIX) || !configured.endsWith(NARRATIVE_SUFFIX)) {
    return null;
  }
  const segment = configured.slice(NARRATIVE_PREFIX.length, -NARRATIVE_SUFFIX.length);
  return narrativeKey(segment) === configured ? configured : null;
}

/**
 * The fit engine's view of this Worker, assembled EXPLICITLY rather than
 * spread from `env` -- the same rule `corpusEnv` (src/index.ts) and
 * `documentsEnv` (./tools.ts) follow, and for the same reason: the fit engine
 * has no business holding `R2_PRIVATE` or the token signing key, and a spread
 * would hand it both. Every binding below is one `analyzeFit` reaches for.
 */
function fitEnv(env: McpEnv): FitEnv {
  return {
    SITE: env.SITE,
    SITE_ORIGIN: env.SITE_ORIGIN,
    AI: env.AI,
    KV_CONFIG: env.KV_CONFIG,
    RLME_AI_GATEWAY_ID: env.RLME_AI_GATEWAY_ID,
    FIT_ENGINE: env.FIT_ENGINE,
  };
}

/**
 * The judge's slice of the environment, assembled explicitly for the same
 * reason `fitEnv` is: the judge has no business holding D1, R2 or the limiter.
 */
function judgeEnv(env: McpEnv): JudgeEnv {
  return {
    AI: env.AI,
    RLME_AI_GATEWAY_ID: env.RLME_AI_GATEWAY_ID,
    JUDGE_ENGINE: env.JUDGE_ENGINE,
  };
}

/**
 * What a caller is told when `analyzeFit` throws, and the ONE place that
 * decides it.
 *
 * Exported, and a named function rather than three lines inside the handler,
 * because the dangerous branch is otherwise untestable. The harness can only
 * ever reach the safe one: `FIT_ENGINE: 'off'` makes every call in
 * tests/mcp-gated.test.ts a `FitUnavailable`, so mutating the mapping to copy
 * `error.message` UNCONDITIONALLY left the whole suite green -- which is
 * exactly the Critical failure this mapping exists to prevent, an AI Gateway
 * `2018: Invalid User Credentials` reaching a stranger as a rate-limit
 * sentence. Pulled out here, both branches are one direct call each, with no
 * Worker in the way. tests/mcp-gated.test.ts calls them.
 *
 * THE GENERIC BRANCH LOGS, and that is not decoration: it is what makes its
 * own sentence true. `guarded` (./define.ts) logs whatever is THROWN, which
 * on this path is the replacement `ToolError` -- so without the line below the
 * original cause is discarded and "The error was logged." is a lie. It also
 * defeats a property src/lib/fit/engine.ts documents deliberately: a mis-set
 * `FIT_ENGINE` throws a plain `Error` rather than a `FitUnavailable`
 * SPECIFICALLY so an operator's typo is loud rather than dressed up as an
 * outage, and swallowing it here would have made it silent. The cost is one
 * duplicate log line per generic failure (this one, naming the cause, and
 * `guarded`'s, naming the wrapper), which is the cheap direction to be wrong
 * in.
 */
export function fitToolError(error: unknown): ToolError {
  // A `FitUnavailable`'s message is written by the engine, sentence by
  // sentence, to be shown -- see that class's own comment. Nothing else is:
  // an unwrapped throw could carry a gateway error code, an internal origin or
  // a stack, and a raw `2018` would tell a stranger a rate limit was hit
  // rather than that the engine is unavailable, which is both a disclosure and
  // a lie.
  if (error instanceof FitUnavailable) return new ToolError(error.message);
  console.error(
    'mcp/gated: analyze_fit failed with a cause the engine did not wrap; the caller was told nothing about it',
    error,
  );
  return new ToolError('Fit analysis failed. The error was logged.');
}

/**
 * What `analyze_fit` answers with, around the report itself.
 *
 * The envelope travels WITH the report rather than in a log, on purpose. A
 * reader deciding how much to trust this needs to know which model wrote it,
 * when, how much corpus it saw, and -- the load-bearing one -- how many
 * citations were dropped as unresolvable. Burying that in a log would make the
 * honesty contract (03 §4) unverifiable by the person it is for.
 *
 * `audience` is here because of what happens downstream. `/fit`'s form stores
 * every run in `fit_reports`, whose `audience` column is defined by
 * migrations/0002_private_tier.sql as the GRANT'S audience -- with a comment
 * saying a NULL there would be evidence the tier check was bypassed. The site
 * cannot supply it: `/fit` treats the token as opaque by design and never
 * verifies it, so before this field existed it wrote the literal `'web'` and
 * every browser-produced report claimed an audience named after a channel.
 * This is the only place that knows the answer, so this is where it is said.
 *
 * Not a disclosure: the audience is a claim inside the signed token the caller
 * is already holding.
 *
 * A separate, pure function so it can be tested without a model call -- the
 * whole success path of this tool is unreachable under the harness
 * (`FIT_ENGINE: 'off'`), which is exactly the condition under which a field
 * silently going missing would never be noticed.
 */
export function fitEnvelope(result: FitResult, audience: string): Record<string, unknown> {
  return {
    report: result.report,
    audience,
    model: result.model,
    generated_at: result.generatedAt,
    corpus_documents: result.corpusDocuments,
    // Alongside `corpus_documents` rather than instead of it: the count says
    // how many documents were compared, this says whether that count is the
    // whole published corpus or only as much of it as fit the budget. A
    // caller reading `corpus_documents: 7` cannot otherwise tell the two
    // apart, and the difference decides whether a stated gap means "no
    // evidence" or "the evidence was not in the room".
    corpus_truncated: result.corpusTruncated,
    citations_checked: result.citations.checked,
    citations_dropped: result.citations.dropped,
  };
}

/**
 * Every private-tier tool there is, in the order a granted caller meets them.
 *
 * The ARRAY's order is the order of both `tools/list` and the instruction map,
 * so two tokens carrying the same scopes in a different order are told the
 * same thing -- `grant.scopes` is only ever asked a membership question.
 */
const GATED_TOOLS: readonly GatedTool[] = [
  {
    scope: 'profile',
    name: 'get_availability',
    title: 'Availability',
    description: "Ryan's current working status and engagement timing.",
    summary: 'current working status and engagement timing.',
    register: (server, tc, tool) => defineDocumentTool(server, tc, tool, PROFILE_KEYS.availability),
  },
  {
    scope: 'profile',
    name: 'get_references',
    title: 'References',
    description: 'Reference contacts and the context for each.',
    summary: 'reference contacts and the context for each.',
    register: (server, tc, tool) => defineDocumentTool(server, tc, tool, PROFILE_KEYS.references),
  },
  {
    scope: 'profile',
    name: 'get_compensation_expectations',
    title: 'Compensation expectations',
    description: 'Compensation range and structure preferences.',
    summary: 'compensation range and structure preferences.',
    register: (server, tc, tool) => defineDocumentTool(server, tc, tool, PROFILE_KEYS.compensation),
  },
  {
    scope: 'documents',
    name: 'get_case_study_details',
    title: 'Case study, unredacted',
    description:
      'The unredacted layer of one case study: named metrics and organisational specifics the published version omits.',
    summary: 'the unredacted layer of one case study, by slug.',
    register: (server, tc, tool) =>
      defineTool<z.infer<typeof CASE_STUDY_INPUT>>(
        server,
        tc,
        {
          ...specOf(tool),
          cost: 'cheap',
          inputSchema: CASE_STUDY_INPUT,
        },
        async ({ slug }, tc) => {
          const key = caseStudyDetailKey(slug);
          // A refused key and a missing document answer the SAME sentence, on
          // purpose: a caller probing slugs learns nothing about which ones
          // exist, and the honest answer to both is "not available here".
          // tests/mcp-gated.test.ts asserts the two sentences are IDENTICAL
          // rather than merely both errors -- the weaker assertion would pass
          // with `safeSegment` deleted, since R2 is a flat keyspace and a
          // traversal-shaped key is simply a key that is not there.
          if (key === null) throw new ToolError(NOT_DEPLOYED);
          const text = await readPrivateDoc(tc.env, key);
          if (text === null) throw new ToolError(NOT_DEPLOYED);
          return text;
        },
      ),
  },
  {
    scope: 'narrative',
    name: 'get_application_narrative',
    title: 'Audience narrative',
    description:
      "The narrative written for this token's audience: why this engagement, and a first-90-days sketch.",
    summary: "the narrative written for this token's audience.",
    register: (server, tc, tool, grant) =>
      defineTool(
        server,
        tc,
        {
          ...specOf(tool),
          cost: 'cheap',
        },
        async (_args, tc) => {
          // The audience comes from the SIGNED claim, so a caller cannot ask
          // for someone else's narrative by changing an argument -- there is
          // no argument. That is why this tool takes none.
          //
          // Read off the `grant` PARAMETER, which `registerGatedTools`
          // narrowed non-null before it called this, rather than off
          // `tc.grant!`. Same object -- the closure captures the very `tc` it
          // is passed -- but the non-null-ness is then carried by the type
          // checker instead of asserted past it, so the guarantee is provable
          // rather than promised.
          const audience = grant.audience;
          // Configuration first: 00 §5 gives a campaign an explicit
          // `gated_narrative_doc`, and honouring it means a document can be
          // renamed without re-minting tokens. The convention key is the
          // fallback, not the rule -- an entry that omits the field parses as
          // `''` and takes the fallback, which is why this tests for the empty
          // string rather than for the campaign's presence.
          const campaign = await readCampaignForAudience(tc.env, audience);
          const configured = campaign?.gatedNarrativeDoc ?? '';
          let key: string | null;
          if (configured === '') {
            key = narrativeKey(audience);
          } else {
            key = narrativeKeyFromConfig(configured);
            if (key === null) {
              // Named in the log because this is a deployment mistake an
              // operator has to be able to find -- and NOT named to the
              // caller, who gets the same `NOT_DEPLOYED` sentence a missing
              // document gets. A refusal that quoted the key back would turn a
              // misconfiguration into a listing of what is in the bucket.
              console.warn(
                `mcp/gated: the narrative document configured for audience "${audience}" is outside the ${NARRATIVE_PREFIX} namespace and was refused: ${configured}`,
              );
            }
          }
          if (key === null) throw new ToolError(NOT_DEPLOYED);
          const text = await readPrivateDoc(tc.env, key);
          if (text === null) throw new ToolError(NOT_DEPLOYED);
          return text;
        },
      ),
  },
  {
    scope: 'fit',
    name: 'analyze_fit',
    title: 'Fit analysis',
    // THE LAST TWO SENTENCES ARE AN INSTRUCTION TO THE CALLING AGENT, not a
    // caveat. This tool takes no URLs -- the plan's "The caller fetches, not
    // the Worker" row, and 03 §4's SSRF reasoning behind it: a Worker that
    // fetched an arbitrary URL on a stranger's say-so would need a host
    // allowlist, and the allowlist is both the whole of the security value and
    // exactly the enumeration 09 §2 forbids a public repo to carry.
    //
    // An MCP client already has web access, so the description is where it is
    // told to use it. Without those sentences an agent holding a link has to
    // guess, and the likeliest guess is to pass the link AS the description --
    // producing a fit report about a string, which reads exactly like a fit
    // report about the document it names.
    description:
      "Compares Ryan's published record against a description you supply and returns a structured report: a requirement-by-requirement evidence map with citation URLs, the gaps, and questions worth asking him. Pass the full text. If you have a URL instead, fetch it yourself first and pass what you retrieved -- this tool does not accept URLs.",
    summary:
      'compare a description you supply against the corpus; returns an evidence map with citation URLs, honest gaps, and questions to ask.',
    register: (server, tc, tool, grant) =>
      defineTool<z.infer<typeof FIT_INPUT>>(
        server,
        tc,
        {
          ...specOf(tool),
          // The only `expensive` tool in the server, and the only one anywhere
          // in this repo that spends inference at a frontier model's price:
          // one call over the whole corpus per invocation. Six per five
          // minutes, and the reasoning for that shape is in `LIMITS`
          // (src/lib/mcp/limits.ts).
          cost: 'expensive',
          inputSchema: FIT_INPUT,
        },
        async ({ target_description }, tc) => {
          try {
            const result = await analyzeFit(fitEnv(tc.env), target_description);
            // `grant` is the registration-time grant, and it is the SAME
            // object `tc.grant` holds: ./index.ts resolves it once per HTTP
            // request, before the server is built (see `ToolContext`). Reading
            // it from the parameter rather than from `tc` is what makes it
            // non-null here without a check that could only ever be dead code.
            return fitEnvelope(result, grant.audience);
          } catch (error) {
            // The mapping is `fitToolError` above, where both branches are
            // reachable by a test. `instanceof` is sound at that call because
            // this one is in-process -- the engine and this tool are the same
            // bundle. It is NOT sound across the service binding /fit uses
            // (Task 13), where the instance is structured-cloned, which is why
            // `FitUnavailable` sets its own `name` and why that side has to
            // read it rather than reusing this.
            throw fitToolError(error);
          }
        },
      ),
  },
  {
    scope: 'evals',
    name: 'judge_answer',
    title: 'Judge an answer against criteria',
    description:
      'Scores a piece of text against a set of criteria and returns a pass/fail verdict with a score and reasons. Generic: it has no knowledge of what the text is for, and the criteria are supplied by the caller.',
    summary:
      'score text against criteria; returns a verdict, a score and the criteria that failed.',
    register: (server, tc, tool) =>
      defineTool<z.infer<typeof JUDGE_INPUT>>(
        server,
        tc,
        {
          ...specOf(tool),
          // One Sonnet call over two short strings. `conversation` rather than
          // `expensive`: this is the same order of spend as a chat turn, and an
          // eval run makes a dozen of them in a burst -- `expensive`'s six per
          // five minutes would make a full suite take half an hour to no
          // purpose, since the caller is the owner's own harness holding a
          // scoped token.
          cost: 'conversation',
          inputSchema: JUDGE_INPUT,
        },
        async ({ criteria, subject }, tc) => {
          try {
            return await judge(judgeEnv(tc.env), criteria, subject);
          } catch (error) {
            // The same shape as `fitToolError`, and the same reason for
            // refusing rather than degrading: a judge that answers "fail"
            // because it could not run turns a harness outage into a red suite
            // somebody spends an afternoon on.
            if (error instanceof JudgeUnavailable) throw new ToolError(error.message);
            console.error('judge_answer failed', error);
            throw new ToolError('The judge could not score that. The error was logged.');
          }
        },
      ),
  },
];

/**
 * Every gated tool's name, DERIVED from `GATED_TOOLS` rather than retyped.
 *
 * Exported for the tests (deferred minor L963). tests/mcp-gated.test.ts kept
 * its own hand-maintained copy of this list, which could not go stale loudly:
 * a seventh tool added to `GATED_TOOLS` and not to that copy was invisible to
 * BOTH tests that used it -- the one asserting no gated name appears without a
 * grant, and the one asserting every gated name appears with a full one. A
 * tool could therefore ship with neither of its two central properties tested,
 * which is the opposite of what those tests exist to promise.
 *
 * Deriving it here rather than exporting `GATED_TOOLS` itself keeps the tool
 * definitions -- handlers, schemas, scopes -- inside this module.
 */
export const GATED_TOOL_NAMES: readonly string[] = GATED_TOOLS.map((tool) => tool.name);

/**
 * Every private-tier tool, registered against the scopes the grant carries.
 *
 * The scope is checked HERE for registration and by `defineTool` again at call
 * time. Two mechanisms on purpose: 09 §3's "structural, not filtered" is a
 * claim worth more than one guarantee. `hasScope` is not imported here --
 * inside this function the grant is already narrowed non-null, so `.includes`
 * is the whole of the question, and `hasScope`'s null handling belongs to the
 * call-time check that has to cope with a grant it did not narrow.
 */
export function registerGatedTools(server: McpServer, tc: ToolContext): void {
  const grant = tc.grant;
  if (grant === null) return;

  for (const tool of GATED_TOOLS) {
    if (grant.scopes.includes(tool.scope)) tool.register(server, tc, tool, grant);
  }
}

/**
 * The lines a granted `initialize` advertises, DERIVED from the registrations
 * above rather than listed a second time in ./server.ts.
 *
 * What this buys, precisely: the loop below and the loop in
 * `registerGatedTools` ask the same question of the same field of the same
 * entries, so a tool cannot be advertised without being registered or renamed
 * in one place only. What it does not buy is a guarantee that `summary` still
 * DESCRIBES the tool -- prose cannot be derived from a registration. That
 * half is a review gate rather than a mechanism: tests/mcp-gated.test.ts pins
 * the whole granted block verbatim for an all-scope grant, so changing any
 * line is a deliberate act with a test to update.
 *
 * Takes the `Grant` rather than the `ToolContext` because that is all it
 * needs: no server, no bindings, and therefore nothing to register.
 */
export function gatedToolLines(grant: Grant): string[] {
  return GATED_TOOLS.filter((tool) => grant.scopes.includes(tool.scope)).map(
    (tool) => `${tool.name}: ${tool.summary}`,
  );
}
