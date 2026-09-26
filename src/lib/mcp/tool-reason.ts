// Why a tool refused, in a form a machine can read (#424).
//
// An eval runner scoring `analyze_fit` has to tell "no answer was produced"
// from "the answer was wrong": the first says nothing about the prompt, and
// grading it as a failure publishes an outage on /ops as a regression. The
// refusal's text cannot carry that distinction, because the text is written
// for people and is free to change wording; a key in the result's `_meta` is
// the contract instead.
//
// It lives under src/lib rather than beside `ToolError` in workers/mcp so the
// eval runners can import it without reaching into the MCP Worker.

/** The `_meta` key a refusal's reason travels under, namespaced per the MCP spec. */
export const TOOL_REASON_META_KEY = 'me.ryanlindsey/reason';

/**
 * `unavailable`: the tool produced no answer at all. Only a `FitUnavailable`
 * carries it (workers/mcp/src/gated.ts, `fitToolError`); a rate-limit refusal,
 * a schema refusal and an unwrapped throw carry no reason, and stay graded.
 */
export type ToolErrorReason = 'unavailable';
