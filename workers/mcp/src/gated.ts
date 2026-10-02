import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { FitEnv } from '../../../src/lib/fit/engine';
import { REPORT_ID_PATTERN } from '../../../src/lib/fit/report-id';
import { isStale, REFRESH_SECONDS } from '../../../src/lib/fit/report-status';
import { FitReport } from '../../../src/lib/fit/schema';
import { FAILURE_REASONS, type FailureReason } from '../../../src/lib/failure/classify';
import { readCampaignForAudience, type CampaignEnv } from '../../../src/lib/tier/campaigns';
import type { Grant } from '../../../src/lib/tier/grant';
import {
  AUTHORING_KEYS,
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
// Six of the nine tools here are a document read. There is no query
// interface, no key parameter, and no listing: a general-purpose read
// primitive over the private bucket is exactly the shape the partition
// (src/lib/tier/private-docs.ts) exists to avoid handing to a caller, however
// well scoped their token is. `get_narrative_brief` is the one that hands a
// KEY back, which is the opposite direction and is argued for at its handler.
// The other three read no private document at all: `analyze_fit` and
// `get_fit_report` are the fit engine's MCP frontend, opening a run and
// reading it back, and everything the engine sees is published; and
// `judge_answer` scores text the caller supplies.
//
// THESE COUNTS HAVE BEEN WRONG BEFORE -- this said "five of the six" and "the
// sixth" from day 5 through `judge_answer` and on past it, and "six of the
// eight" until `get_fit_report` (#490), so keep them in step with the table
// below or say "every" and drop the arithmetic.
//
// Vocabulary (09 §2): these names and descriptions are code, and code is a
// public surface -- a granted caller can screenshot `tools/list`. They say
// audience, scope, private tier, engagement, fit analysis. What the DOCUMENTS
// say is runtime data and is not this file's business.

/** The sentence a caller sees when a document has not been deployed yet. */
const NOT_DEPLOYED = 'That document is not available on this tier yet.';

/** Every `NOT_DEPLOYED` refusal is definitively `not_found`, so the tag is set in one place. */
function notDeployed(): ToolError {
  return new ToolError(NOT_DEPLOYED, undefined, { failureReason: 'not_found' });
}

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
   * tests/mcp-gated.test.ts asserts the WHOLE granted block verbatim for one
   * fixed set of scopes, so an edit to a summary inside that set is an edit to
   * a test as well. That is the point of the field: a name can be derived,
   * prose cannot, so the prose is reviewed instead. The set is NOT every scope
   * -- `evals` and `authoring` are outside it, so `judge_answer`'s summary and
   * `get_narrative_brief`'s are pinned by NOTHING. The scope-by-scope test
   * below covers their name-to-line pairing and says nothing about the prose,
   * and the static vocabulary scan only refuses banned words; a human reviewer
   * is the rest of it. An earlier version of this comment claimed "every scope"
   * and "these six", and both were stale before anyone read them.
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
      if (text === null) throw notDeployed();
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
 *
 * EXPORTED SINCE #275, AND THAT IS WHAT KEEPS THE FLOOR REAL. `POST
 * /fit/start` parses with THIS OBJECT rather than with its own copy of the
 * number. Until #275 the site reached the engine through this tool, so the SDK
 * rejected a short description before `limitAndAudit` ever ran and the floor
 * held for free. `/fit/run` calls `/fit/start` now, and the only other
 * 200-character check on that path is `minlength="200"` in
 * src/pages/fit/index.astro, which is a browser's courtesy and not a check: a
 * hand-rolled POST bypasses it entirely. A second literal `200` in
 * ./fit-start.ts would have held until the day somebody tuned one of them.
 */
export const FIT_INPUT = z.object({
  target_description: z
    .string()
    .min(200, 'Paste the full description; a few lines is not enough to analyse.')
    .max(60_000)
    .describe('The full text of the description to compare against.'),
});

/**
 * `get_narrative_brief`'s one argument, and it is an AUDIENCE rather than a
 * key on purpose: src/lib/tier/private-docs.ts's rule is that no tool accepts
 * a key, because one that did would be a general-purpose read primitive on
 * the private bucket. This tool hands a key BACK, which is a different thing
 * -- see the handler.
 *
 * Not read off the grant, the way `get_application_narrative` reads its
 * audience. That tool answers with a document written FOR its caller, so
 * taking an argument would let one audience ask for another's. This one
 * answers with a key and a brief, and its caller is the owner's own client
 * writing a document for somebody else's audience -- so the audience is the
 * question rather than the identity.
 */
const BRIEF_INPUT = z.object({
  audience: z.string().describe('The token audience whose narrative document is being written.'),
});

/**
 * Both halves, in one answer. `defineTool` passes a string handler result
 * through verbatim and serialises anything else as JSON, so an object gives
 * the caller one readable pair; declaring the schema also puts it in
 * `structuredContent`.
 */
const BRIEF_OUTPUT = z.object({
  key: z.string().describe("The R2_PRIVATE key this audience's document must be written to."),
  brief: z.string().describe('The brief, verbatim.'),
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
 * What `get_application_narrative` will read for one audience.
 *
 * `configured` is returned alongside `key` because a `null` key has two
 * causes that need different answers. An audience that cannot build a key at
 * all is a malformed mint; a configured value outside the namespace is a
 * campaign entry to fix, and the operator surface has to be able to say which
 * one happened without resolving the key a second time.
 */
export interface NarrativeResolution {
  /** The key both readers use, or `null` when nothing valid could be built. */
  key: string | null;
  /** The campaign's configured value, `''` when the campaign set none. */
  configured: string;
}

/**
 * ONE EXPRESSION, because there is about to be a second reader.
 *
 * This resolution lived inside `get_application_narrative`'s handler until
 * ryanlindsey.me#264, where nothing else could reach it. An authoring tool
 * that computed `narrativeKey(audience)` instead would name
 * `narrative/<audience>.md` while the reader followed whatever the campaign
 * configured: the document would deploy successfully, be found by nothing,
 * and raise no error anywhere. That is the failure
 * `narrativeKeyFromConfig`'s comment describes, arriving from the authoring
 * end -- and it is the same argument that comment makes for validating by
 * reconstruction rather than by a second regex. There is no third shape to
 * keep in step.
 *
 * Takes `CampaignEnv`, not `McpEnv`: resolving a key has no business holding
 * `R2_PRIVATE`. Note what kind of guarantee that is. `fitEnv` and `judgeEnv`
 * below BUILD a new object carrying only what the callee needs, so the callee
 * cannot reach the rest at runtime; this is a type-level narrowing of the very
 * `tc.env` the handler holds, the same one `readCampaignForAudience` has
 * always taken. It stops a reader and a future edit from reaching for
 * `R2_PRIVATE` here, and a cast would defeat it. Worth the weaker form anyway:
 * the value-level version would mean assembling an object on every narrative
 * read to protect a function whose whole body is one KV lookup.
 *
 * The `console.warn` stays HERE rather than in either caller, because it is
 * the operator's only signal that a campaign entry is wrong and both readers
 * want it fired exactly once, on the resolution that found the problem.
 *
 * THE CAMPAIGN READ IS DELIBERATELY UNGUARDED, unlike the same call in
 * `handleGrantContext` (./grant-context.ts) and `/fit/r/<id>`, which both fail
 * toward no campaign (#296, which asked for this one to be checked in the same
 * pass). Those two lose optional decoration when the read fails. This one
 * would lose the configured key and fall back to the convention key: the
 * narrative tool would answer `NOT_DEPLOYED` for a document that is deployed,
 * and the brief would tell an author to write to a key the reader does not
 * follow, which is the silent mismatch this function exists to prevent. A
 * rejection instead reaches `defineTool` (./define.ts), which answers the
 * generic failure sentence -- the true answer to a read that could not run.
 */
export async function resolveNarrativeKey(
  env: CampaignEnv,
  audience: string,
): Promise<NarrativeResolution> {
  // Configuration first: 00 §5 gives a campaign an explicit
  // `gated_narrative_doc`, and honouring it means a document can be renamed
  // without re-minting tokens. The convention key is the fallback, not the
  // rule -- an entry that omits the field parses as `''` and takes the
  // fallback, which is why this tests for the empty string rather than for
  // the campaign's presence.
  const campaign = await readCampaignForAudience(env, audience);
  const configured = campaign?.gatedNarrativeDoc ?? '';
  if (configured === '') {
    return { key: narrativeKey(audience), configured };
  }
  const key = narrativeKeyFromConfig(configured);
  if (key === null) {
    // Named in the log because this is a deployment mistake an operator has
    // to be able to find -- and NOT named to the caller of
    // `get_application_narrative`, who gets the same `NOT_DEPLOYED` sentence
    // a missing document gets. A refusal that quoted the key back would turn
    // a misconfiguration into a listing of what is in the bucket.
    console.warn(
      `mcp/gated: the narrative document configured for audience "${audience}" is outside the ${NARRATIVE_PREFIX} namespace and was refused: ${configured}`,
    );
  }
  return { key, configured };
}

/**
 * The fit engine's view of this Worker, assembled EXPLICITLY rather than
 * spread from `env` -- the same rule `corpusEnv` (src/index.ts) and
 * `documentsEnv` (./tools.ts) follow, and for the same reason: the fit engine
 * has no business holding `R2_PRIVATE` or the token signing key, and a spread
 * would hand it both. Every binding below is one `analyzeFit` reaches for.
 *
 * EXPORTED SINCE #269, for one caller and deliberately: `POST /fit/start`
 * (./fit-start.ts) runs the same engine after its own response has gone, so it
 * needs exactly this slice. Assembling a second copy of it over there would be
 * a second list of bindings to keep in step with `FitEnv`, and the copy that
 * drifted would be the one no tool call exercises.
 *
 * THAT CALLER IS NOW THE ONLY ONE, and it is `FitWorkflow` in
 * ./fit-workflow.ts rather than the route, which hands the run over (#349).
 * Since #490 `analyze_fit` opens a run the same way instead of calling the
 * engine itself, so no tool call reaches this at all, and it stays here
 * because this is where the reason for its shape is written.
 */
export function fitEnv(env: McpEnv): FitEnv {
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
 * `get_fit_report`'s one argument: a report id, exactly as `analyze_fit`
 * returned it.
 *
 * STRICT, against the pattern beside `newReportId`, so a pasted permalink or a
 * clipped id is answered with a schema error an agent can correct rather than
 * with "no report exists", which would read as a run that vanished. The
 * length is declared on its own as well as inside the pattern because the
 * listed schema carries it as `minLength`, and tests/mcp-gated.test.ts builds
 * its placeholder arguments from that.
 */
const FIT_REPORT_INPUT = z.object({
  report_id: z
    .string()
    .length(22)
    .regex(REPORT_ID_PATTERN, 'Pass the report_id exactly as analyze_fit returned it.')
    .describe('The report_id analyze_fit returned.'),
});

/**
 * How long one `get_fit_report` call holds the connection open for a run that
 * is still going.
 *
 * Forty seconds under the MCP TypeScript SDK's 60-second
 * `DEFAULT_REQUEST_TIMEOUT_MSEC`, which is the one client limit known; what
 * claude.ai waits is unmeasured. A run took 59 to 104 seconds on Opus 5 (tail
 * 135 s), so a caller that starts polling at once needs two or three calls,
 * and each of them answers before the limit that made `analyze_fit` time out
 * in the first place (#490).
 */
export const FIT_REPORT_WAIT_MS = 40_000;

/**
 * How often the held call re-reads the row. Each read is one indexed D1 lookup,
 * so twenty per call is cheap, and two seconds is small against a run measured
 * in tens of them.
 */
export const FIT_REPORT_REREAD_MS = 2_000;

/** A fixed sentence for a run that closed without a sentence of its own to show. */
const FIT_REPORT_FAILED =
  'This fit analysis ended without a report. Call analyze_fit again to start a new one.';

/** One sentence for an id with no row, whatever the reason there is none. */
const FIT_REPORT_MISSING = 'No fit report exists under that report_id.';

/** For an `ok` row whose stored report this build can no longer read. */
const FIT_REPORT_UNREADABLE =
  'This fit report is stored in a form that can no longer be read. Call analyze_fit again to start a new one.';

/**
 * The columns `get_fit_report` reads, and the one it does not.
 *
 * `target_description` IS NEVER SELECTED, for the reason src/pages/fit/r/[id].astro
 * records beside its own query: it holds whatever text was pasted, and this
 * answer goes to anyone holding the id. A column that is not read cannot be
 * returned by accident.
 *
 * The three envelope columns and the two refusal columns arrived with
 * migrations/0010_fit_report_envelope.sql, and a row older than that reads
 * null in all five.
 */
export interface StoredFitReport {
  created_at: string;
  status: string;
  audience: string;
  model: string | null;
  report_json: string | null;
  citations_checked: number | null;
  citations_dropped: number | null;
  generated_at: string | null;
  corpus_documents: number | null;
  corpus_truncated: number | null;
  failure_reason: string | null;
  no_answer: number | null;
  failure_message: string | null;
}

function readFitReport(db: D1Database, id: string): Promise<StoredFitReport | null> {
  return db
    .prepare(
      `SELECT created_at, status, audience, model, report_json, citations_checked,
              citations_dropped, generated_at, corpus_documents, corpus_truncated,
              failure_reason, no_answer, failure_message
         FROM fit_reports WHERE id = ?`,
    )
    .bind(id)
    .first<StoredFitReport>();
}

/** The report's permalink, the page `/fit` readers are sent to (04 §2). */
function fitPermalink(siteOrigin: string, id: string): string {
  return `${siteOrigin}/fit/r/${id}`;
}

/** Whether a row is a run worth waiting on: `pending`, and inside the stale budget. */
function stillRunning(row: StoredFitReport, now: number): boolean {
  return row.status === 'pending' && !isStale(row.created_at, now);
}

/**
 * What both fit tools answer while a run is still going (#490).
 *
 * ONE SHAPE FROM BOTH, so an agent handles `analyze_fit`'s first answer and
 * `get_fit_report`'s "not yet" with the same code. `next` says what to do in a
 * sentence because the reader is a model, and a field it has to infer an
 * action from is a field it can infer the wrong action from.
 *
 * `poll_after_seconds` is the holding page's own refresh interval. The call it
 * points at waits on its own, so the number is how long to pause between
 * calls rather than how long the run takes.
 */
export function pendingFitEnvelope(id: string, siteOrigin: string): Record<string, unknown> {
  return {
    status: 'pending',
    report_id: id,
    permalink: fitPermalink(siteOrigin, id),
    poll_after_seconds: REFRESH_SECONDS,
    next: `The report takes one to two minutes. Call get_fit_report with report_id "${id}"; it waits up to ${FIT_REPORT_WAIT_MS / 1000} seconds and answers pending again if the report is not ready, in which case call it again.`,
  };
}

/**
 * What a finished report is answered with: the report, and around it what a
 * reader needs to decide how far to trust it.
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
 *
 * BUILT FROM THE ROW SINCE #490, with the field names it had when
 * `analyze_fit` built it from the engine's `FitResult`. The run outlives the
 * call that opened it now, so the grant that call resolved is gone by the
 * time anyone reads the report, and the audience comes back from the row it
 * was written to. That is the same value: `openFitRun` writes it from the
 * grant. `corpus_truncated` goes back from SQLite's 0/1 to the boolean the
 * envelope always carried, and all three envelope columns answer null for a
 * row written before migration 0010.
 *
 * Not a disclosure: the audience is a claim inside the signed token that
 * opened the run, and the id that reaches this is the capability the
 * permalink already hands out.
 *
 * The stored report is re-validated against `FitReport`, as the permalink
 * page does in `parseStoredReport`, and a row that fails is refused rather
 * than served: a report this build cannot validate is not one to hand an
 * agent as evidence.
 */
export function fitEnvelope(
  row: StoredFitReport,
  id: string,
  siteOrigin: string,
): Record<string, unknown> {
  let report: FitReport | null = null;
  try {
    const parsed = FitReport.safeParse(JSON.parse(row.report_json ?? ''));
    if (parsed.success) report = parsed.data;
  } catch {
    report = null;
  }
  if (report === null) throw new ToolError(FIT_REPORT_UNREADABLE);

  return {
    status: 'ok',
    report_id: id,
    permalink: fitPermalink(siteOrigin, id),
    report,
    audience: row.audience,
    model: row.model,
    generated_at: row.generated_at,
    corpus_documents: row.corpus_documents,
    // Alongside `corpus_documents` rather than instead of it: the count says
    // how many documents were compared, this says whether that count is the
    // whole published corpus or only as much of it as fit the budget. A
    // caller reading `corpus_documents: 7` cannot otherwise tell the two
    // apart, and the difference decides whether a stated gap means "no
    // evidence" or "the evidence was not in the room".
    corpus_truncated: row.corpus_truncated === null ? null : row.corpus_truncated === 1,
    citations_checked: row.citations_checked,
    citations_dropped: row.citations_dropped,
  };
}

/**
 * What `get_fit_report` answers for a row, or the refusal it throws, and the
 * ONE place that decides it.
 *
 * A pure function of the row and the clock, exported for the reason
 * `fitToolError` was, which this replaces: under the harness every real run is
 * the engine's refusal, so the other branches are reachable only by calling
 * this directly or by seeding a row.
 *
 * A REFUSAL SHOWS THE ENGINE'S OWN SENTENCE OR A FIXED ONE, NEVER ANYTHING
 * ELSE. `failure_message` is written by `FitWorkflow` for a `FitUnavailable`
 * alone, whose message the engine writes to be shown; every other failure
 * leaves it null, because the only text such a failure has is upstream error
 * text, and an AI Gateway `2018: Invalid User Credentials` reaching a caller
 * would tell them an auth failure happened when a rate limit did, which is
 * both a disclosure and a lie. The fixed sentence is written for a calling
 * agent, which can start a new run, rather than copied from the permalink
 * page's "Ask for a fresh link", which is written for a person holding one.
 *
 * The `unavailable` reason tells an eval runner that no model answer exists,
 * and only a run stored with `no_answer = 1` carries it -- a `FitUnavailable`
 * marked `noAnswer`. The first draft of #426 set it for every
 * `FitUnavailable`, as the spec then said, and that swept in a truncated or
 * schema-failing answer: the model DID answer, and the 2026-09-10 run's
 * `fit/strong` and `fit/partial` hitting the token cap would have read as
 * couldn't-run beside a green graded cell, hiding the regression the graded
 * failure exposed. Those stay graded, as does every failure that is not a
 * `FitUnavailable`, which is not known to mean no answer existed, and so does
 * a null `no_answer` from a row older than migration 0010.
 *
 * `failureReason` is the reason the run stored, when it is one this build
 * knows, so this call's own audit row records why the run failed rather than
 * leaving the classifier to read a `ToolError` that carries no cause. A stale
 * row has none and leaves it to the classifier.
 *
 * A STALE `pending` ROW IS REFUSED like a failed one. Nothing is going to
 * finish it -- `isStale` is the permalink page's own budget -- and answering
 * pending would send an agent round a loop that cannot end.
 *
 * AN ID WITH NO ROW answers one sentence whatever the reason: never minted,
 * swept at 365 days (src/lib/retention.ts), or mistyped past the schema. The
 * permalink's 404 makes the same choice, so a caller holding a dead id learns
 * no more here than there.
 */
export function fitReportAnswer(
  row: StoredFitReport | null,
  id: string,
  siteOrigin: string,
  now: number,
): Record<string, unknown> {
  if (row === null) {
    throw new ToolError(FIT_REPORT_MISSING, undefined, { failureReason: 'not_found' });
  }
  if (row.status === 'ok') return fitEnvelope(row, id, siteOrigin);
  if (stillRunning(row, now)) return pendingFitEnvelope(id, siteOrigin);
  throw new ToolError(
    row.failure_message ?? FIT_REPORT_FAILED,
    row.no_answer === 1 ? 'unavailable' : undefined,
    { failureReason: storedFailureReason(row.failure_reason) },
  );
}

/** A stored reason this build knows, or undefined. The column is free text in SQLite. */
function storedFailureReason(raw: string | null): FailureReason | undefined {
  return (FAILURE_REASONS as readonly string[]).includes(raw ?? '')
    ? (raw as FailureReason)
    : undefined;
}

/**
 * Reads a report, re-reading it while the run is still going, for at most
 * `waitMs`. Answers the last row read, or null for an id with no row.
 *
 * A LONG POLL RATHER THAN A STATUS CHECK, so the agent's loop is short: a
 * caller that calls once and gets "pending" back at once has to decide how
 * long to wait, and a model's guesses at that are the thing #490 exists to
 * take away. Holding the call means the usual run is collected in two or three
 * calls without the caller pacing anything.
 *
 * NEVER PAST THE WAIT. A sleep that would end beyond the deadline is skipped
 * and the row read so far is answered, so `waitMs` is a ceiling on the hold
 * rather than a target the interval can overshoot.
 *
 * The timings are parameters so tests/mcp-gated.test.ts can run the loop in
 * milliseconds, directly, instead of holding a harness request open for forty
 * seconds; the Worker-level tests there reach only the branches that answer at
 * once. No override variable exists for this, deliberately: an `RLME_*`-style
 * switch is for keeping a test away from a paid or remote service, and a
 * timing is neither.
 */
export async function pollFitReport(
  read: () => Promise<StoredFitReport | null>,
  {
    waitMs = FIT_REPORT_WAIT_MS,
    rereadMs = FIT_REPORT_REREAD_MS,
  }: { waitMs?: number; rereadMs?: number } = {},
): Promise<StoredFitReport | null> {
  const deadline = Date.now() + waitMs;
  let row = await read();
  while (row !== null && stillRunning(row, Date.now()) && Date.now() + rereadMs <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, rereadMs));
    row = await read();
  }
  return row;
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
          if (key === null) throw notDeployed();
          const text = await readPrivateDoc(tc.env, key);
          if (text === null) throw notDeployed();
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
          //
          // Config-first, convention-fallback, and why the rule is not spelled
          // out here: `resolveNarrativeKey` above. It lives there rather than
          // in this closure because the authoring side has to name the same
          // key (ryanlindsey.me#266).
          const { key } = await resolveNarrativeKey(tc.env, grant.audience);
          if (key === null) throw notDeployed();
          const text = await readPrivateDoc(tc.env, key);
          if (text === null) throw notDeployed();
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
    //
    // THE MIDDLE TWO SENTENCES ARE AN INSTRUCTION TOO, since #490. The tool
    // used to answer with the report itself, and on Opus 5 a run took 59 to
    // 104 seconds (tail 135 s), longer than MCP clients held the call. It now
    // answers with a pending `report_id` at once, and an agent that is not
    // told where the report went has nothing to do with one.
    description:
      "Compares Ryan's published record against a description you supply and produces a structured report: a requirement-by-requirement evidence map with citation URLs, the gaps, and questions worth asking him. The report takes one to two minutes, so this answers at once with status pending and a report_id; call get_fit_report with that report_id to collect the finished report. Pass the full text. If you have a URL instead, fetch it yourself first and pass what you retrieved -- this tool does not accept URLs.",
    summary:
      'compare a description you supply against the corpus; starts an evidence map with citation URLs, honest gaps, and questions to ask, and returns its report_id.',
    register: (server, tc, tool, grant) =>
      defineTool<z.infer<typeof FIT_INPUT>>(
        server,
        tc,
        {
          ...specOf(tool),
          // The only `expensive` tool in the server, and the only one anywhere
          // in this repo that spends inference at a frontier model's price:
          // one call over the whole corpus per run. Six per five minutes, and
          // the reasoning for that shape is in `LIMITS` (src/lib/mcp/limits.ts).
          //
          // STILL METERED HERE, AND ONLY HERE, though the call no longer waits
          // for the spend. This guard is the run's one limiter check and its
          // one audit row, exactly as `limitAndAudit` is for `/fit/start`, and
          // the Workflow that finishes the run meters nothing. The audit row
          // therefore means ACCEPTED, which is what ./fit-start.ts records its
          // own row meaning since #349; what the run came to is on
          // `fit_reports`, and `get_fit_report` is how a caller reads it.
          cost: 'expensive',
          inputSchema: FIT_INPUT,
        },
        async ({ target_description }, tc) => {
          // A DYNAMIC IMPORT, and the reason is this module's other readers
          // rather than this call. ./fit-start.ts reaches ./fit-workflow.ts,
          // which imports `cloudflare:workers`, and a dozen suites import this
          // module into vitest's Node process for `GATED_TOOL_NAMES` and the
          // pure functions above, where that specifier does not resolve. A
          // static import would make every one of them fail to load. Wrangler's
          // bundler inlines a literal relative `import()`, so in the Worker
          // this is an ordinary module reference that is evaluated on first
          // use.
          const { openFitRun } = await import('./fit-start');
          // `grant` is the registration-time grant, and it is the SAME object
          // `tc.grant` holds: ./index.ts resolves it once per HTTP request,
          // before the server is built (see `ToolContext`). Reading it from the
          // parameter rather than from `tc` is what makes it non-null here
          // without a check that could only ever be dead code.
          const id = await openFitRun(tc.env, tc.ctx, grant.audience, target_description);
          return pendingFitEnvelope(id, tc.env.SITE_ORIGIN);
        },
      ),
  },
  {
    scope: 'fit',
    name: 'get_fit_report',
    title: 'Fit report',
    // AN INSTRUCTION AS MUCH AS A DESCRIPTION, for the reason `analyze_fit`'s
    // is: the reader is an agent deciding what to do next, and "call it again"
    // is the one thing it must not have to guess.
    description:
      'Collects a fit report that analyze_fit started. Pass the report_id analyze_fit returned. Waits up to 40 seconds for the report; if it is still being written this answers with status pending, and you should call it again with the same report_id. A finished report carries the evidence map with citation URLs, the gaps, the questions worth asking, and a permalink a person can open.',
    summary: 'wait for a report analyze_fit started, by report_id, and return it.',
    register: (server, tc, tool) =>
      defineTool<z.infer<typeof FIT_REPORT_INPUT>>(
        server,
        tc,
        {
          ...specOf(tool),
          // D1 reads and nothing else, which is `cheap` (60 a minute). A
          // caller collecting one run makes two or three calls, each held for
          // up to `FIT_REPORT_WAIT_MS`, so the bucket is never what paces them.
          cost: 'cheap',
          inputSchema: FIT_REPORT_INPUT,
        },
        async ({ report_id }, tc) => {
          // NO AUDIENCE CHECK, DECIDED RATHER THAN MISSED. The id is the
          // capability: `/fit/r/<id>` serves the same report to anyone holding
          // it, with no token at all (src/lib/fit/report-id.ts), so refusing a
          // `fit` grant whose audience differs from the one that opened the
          // run would guard nothing the permalink does not already hand out.
          // It would also refuse the owner, whose clients hold tokens under
          // different audiences and who may well collect a run from a second
          // one. tests/mcp-gated.test.ts pins this.
          const row = await pollFitReport(() => readFitReport(tc.env.DB, report_id));
          return fitReportAnswer(row, report_id, tc.env.SITE_ORIGIN, Date.now());
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
            // The same shape `fitToolError` had until #490 moved the fit
            // engine off the call (`fitReportAnswer` keeps its rule), and the
            // same reason for refusing rather than degrading: a judge that answers "fail"
            // because it could not run turns a harness outage into a red suite
            // somebody spends an afternoon on.
            if (error instanceof JudgeUnavailable) {
              throw new ToolError(error.message, undefined, { cause: error });
            }
            console.error('judge_answer failed', error);
            throw new ToolError(
              'The judge could not score that. The error was logged.',
              undefined,
              {
                cause: error,
              },
            );
          }
        },
      ),
  },
  {
    scope: 'authoring',
    name: 'get_narrative_brief',
    title: 'Narrative brief',
    description:
      "The brief for writing an audience narrative, and the key this audience's document belongs at.",
    summary: 'the brief for writing an audience narrative, and where it belongs.',
    register: (server, tc, tool) =>
      defineTool<z.infer<typeof BRIEF_INPUT>>(
        server,
        tc,
        {
          ...specOf(tool),
          // One KV lookup and one R2 read, the same shape as every document
          // tool above. Nothing here reaches a model.
          cost: 'cheap',
          inputSchema: BRIEF_INPUT,
          outputSchema: BRIEF_OUTPUT,
        },
        async ({ audience }, tc) => {
          // THIS TOOL NAMES THE KEY BACK TO ITS CALLER, which
          // `get_application_narrative` deliberately never does: a refusal
          // that quoted the key would turn a misconfiguration into a listing
          // of what is in the bucket. The asymmetry IS the scope. Only the
          // owner's own authoring client holds `authoring`, and an operator
          // who cannot be told which key to write to cannot write anything.
          //
          // Resolved through `resolveNarrativeKey` rather than through
          // `narrativeKey`, and that is the whole reason ryanlindsey.me#264
          // extracted it: computing the convention key here would tell the
          // author to write `narrative/<audience>.md` while the reader
          // followed whatever the campaign configured. The document would
          // deploy cleanly, be served by nothing, and log nothing.
          const { key, configured } = await resolveNarrativeKey(tc.env, audience);
          if (key === null) {
            throw new ToolError(
              configured === ''
                ? `"${audience}" cannot build a document key. Check the audience spelling.`
                : // NOT "outside the namespace", which is what the `console.warn`
                  // in `resolveNarrativeKey` says and what this said first.
                  // `narrativeKeyFromConfig` also refuses values that ARE under
                  // `narrative/` and fail the segment check --
                  // `narrative/a/b.md`, `narrative/.hidden.md` -- and telling an
                  // operator those are outside a namespace they are plainly
                  // inside sends them to fix the wrong half of the string. The
                  // warn line can afford the looser wording because it is read
                  // beside the value; this is the sentence the one person who
                  // can fix it reads on its own.
                  `The campaign for "${audience}" configures ${configured}, which is not a valid narrative document key. Fix the campaign entry before writing the document.`,
            );
          }
          const brief = await readPrivateDoc(tc.env, AUTHORING_KEYS.narrativeBrief);
          if (brief === null) throw notDeployed();
          return { key, brief };
        },
      ),
  },
];

/**
 * The gated tools one grant unlocks.
 *
 * THE ONE PLACE `grant.scopes` IS TURNED INTO A TOOL SET. Three callers ask
 * that question -- `registerGatedTools` to decide what to register,
 * `gatedToolLines` to describe them in the instructions, and
 * `grantedToolNames` for the site's grant-context endpoint -- and they were
 * three separate filters over `GATED_TOOLS` until this one replaced them.
 * Three copies of a membership test is how a tool comes to be registered but
 * undescribed, or described but unregistered.
 */
function toolsFor(grant: Grant): readonly GatedTool[] {
  return GATED_TOOLS.filter((tool) => grant.scopes.includes(tool.scope));
}

/**
 * Every gated tool name this grant unlocks.
 *
 * What `POST /grant` answers with, and therefore what `/fit` reads its own
 * access check out of: `analyze_fit`'s presence in this list IS the statement
 * that the token carries the fit scope, is unexpired, is registered and is not
 * revoked. The site never learns the scope-to-tool mapping, which is why it
 * cannot drift from this file.
 */
export function grantedToolNames(grant: Grant): string[] {
  return toolsFor(grant).map((tool) => tool.name);
}

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

  for (const tool of toolsFor(grant)) tool.register(server, tc, tool, grant);
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
  return toolsFor(grant).map((tool) => `${tool.name}: ${tool.summary}`);
}
