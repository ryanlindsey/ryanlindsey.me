import JUDGE_PROMPT from '../../../prompts/judge.md?raw';
import { extractToolInput } from '../fit/engine';
import { JUDGE_VERDICT_JSON_SCHEMA, JudgeVerdict } from '../../../workers/mcp/src/judge-schema';
import { fenceFor } from '../fence';

// The LLM judge (04 §4). One Sonnet call, forced through a tool schema, scoring
// a subject against criteria.
//
// WHY IT RUNS IN A WORKER AT ALL. `evals/run.mjs` is a Node script on the
// owner's machine and holds no inference credential by design. There is no
// provider key for it to hold: `env.AI.run()` bills through AI Gateway's
// UNIFIED BILLING -- measured on day 1, `gatewayMetadata.keySource: "Unified"`,
// and true whether the call names the gateway or passes no gateway option at
// all (10 §5). The Worker's `AI` binding IS the credential, and a binding
// cannot leave Cloudflare. So the judge has to be reachable over HTTP, and the
// safest way to expose a frontier-model call is the mechanism day 5 already
// built: registration-time scope gating, so an anonymous `tools/list` cannot
// see it exists.
//
// An earlier version of this comment said the key "lives in AI Gateway BYOK".
// That is wrong and is corrected rather than deleted, because several places in
// the spec still say it: a BYOK provider key was configured on day 1 and has
// never been used. The conclusion was right for the wrong reason, and the right
// reason is stronger.
//
// IT KNOWS NOTHING ABOUT WHAT IT JUDGES, and that is a 09 §2 requirement rather
// than a design preference. A judge that held an opinion about the vocabulary
// 09 §2 governs would have to CARRY that vocabulary to hold it -- in a public
// repo, in a file this scan reads. It scores text against criteria; the
// criteria live in the eval case, which is data.

/** The same model as chat: 04 §4's scoring is a reading task, not a writing one. */
export const JUDGE_MODEL = 'anthropic/claude-sonnet-5';

/** Enough for a verdict and a handful of one-sentence reasons. */
export const JUDGE_MAX_TOKENS = 1024;

const EMIT_TOOL = 'emit_verdict';

/** The subject is fenced as data, the same boundary the fit engine and chat use. */

export class JudgeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeUnavailable';
  }
}

export interface JudgeEnv {
  AI: Ai;
  RLME_AI_GATEWAY_ID: string;
  /**
   * Test-only seam, the same shape as `FIT_ENGINE` and `CHAT_ENGINE`: no
   * deployed config declares it, `'off'` refuses before the model is called,
   * and an unrecognised value throws.
   */
  JUDGE_ENGINE?: string;
}

export async function judge(
  env: JudgeEnv,
  criteria: string,
  subject: string,
): Promise<JudgeVerdict> {
  if (env.JUDGE_ENGINE !== undefined && env.JUDGE_ENGINE !== 'off') {
    throw new Error(`unrecognised JUDGE_ENGINE: ${env.JUDGE_ENGINE}`);
  }
  if (env.JUDGE_ENGINE === 'off') {
    throw new JudgeUnavailable('The judge is not available in this environment.');
  }

  // BOTH are fenced, not just the subject. The criteria are written by whoever
  // wrote the eval case rather than by a stranger -- but a case file is data
  // this repo edits often, and a fence costs nothing. The subject's fence is
  // the one that matters: it is the model's own answer, which is exactly the
  // text most likely to contain a directive aimed at a reader.
  const criteriaFence = fenceFor(criteria);
  const subjectFence = fenceFor(subject);
  const user = [
    '# Criteria',
    '',
    `${criteriaFence}text`,
    criteria,
    criteriaFence,
    '',
    '# Subject',
    '',
    `${subjectFence}text`,
    subject,
    subjectFence,
  ].join('\n');

  let raw: Record<string, unknown>;
  try {
    raw = (await env.AI.run(
      JUDGE_MODEL,
      {
        max_tokens: JUDGE_MAX_TOKENS,
        system: JUDGE_PROMPT,
        messages: [{ role: 'user', content: user }],
        tools: [
          {
            name: EMIT_TOOL,
            description: 'Return the completed verdict.',
            input_schema: JUDGE_VERDICT_JSON_SCHEMA,
          },
        ],
        // FORCED, the same as the fit engine's: a judge that answers in prose
        // is a judge whose result has to be parsed out of English, and the
        // parse is where a "fail" quietly becomes a "pass".
        tool_choice: { type: 'tool', name: EMIT_TOOL },
        // 10 §5, measured: `temperature`, `top_p` and `top_k` are rejected with
        // `7003: User Input Error` through this binding. Absent, not optional.
      },
      { gateway: { id: env.RLME_AI_GATEWAY_ID, metadata: { surface: 'judge' } } },
    )) as Record<string, unknown>;
  } catch (error) {
    console.error('judge: the model call failed', error);
    throw new JudgeUnavailable('The judge could not be reached right now.');
  }

  // `extractToolInput` is REUSED from the fit engine rather than copied: it
  // already handles the content-block walk and the `tool_use` filter, and a
  // second copy would be a second place for the envelope to change under us.
  //
  // THE TOOL NAME IS PASSED, and it has to be. That helper used to close over
  // the fit engine's own `emit_fit_report` constant, so reusing it here skipped
  // every `emit_verdict` block and returned null -- every verdict in the first
  // full eval run came back as "the judge did not run". Reuse was right; reuse
  // without reading the callee was not.
  const parsed = JudgeVerdict.safeParse(extractToolInput(raw, EMIT_TOOL));
  if (!parsed.success) {
    // Refusing beats guessing. An unparseable verdict is a judge that did not
    // answer, and reporting it as a `fail` would turn a harness outage into a
    // red suite somebody spends an afternoon on.
    console.error('judge: the model did not return a usable verdict');
    throw new JudgeUnavailable('The judge returned nothing usable.');
  }
  return parsed.data;
}
