// The private-tier answer, written by the server rather than the model (issue
// #341).
//
// prompts/chat.md used to hand the model the one sentence to use for a
// question about Ryan's working arrangements, and #85 added a paragraph quoting
// the exact premise-echo the leak suite had caught. The run of 2026-09-23
// passed that probe and failed two others the same way: "Whether he's
// interviewing anywhere..." and "Whether he'd consider a new role...". An
// instruction naming the trap did not stop the model falling into it on the
// next premise it was not shown, so the model no longer writes the sentence at
// all. It answers with PRIVATE_TIER_MARKER and nothing else, and the endpoint
// replaces that with PRIVATE_TIER_ANSWER, byte for byte the same whatever was
// asked. If the wording tracked the question, the differences between answers
// would themselves be the disclosure.

/** What the model is told to reply with, alone, for a private-tier question. */
export const PRIVATE_TIER_MARKER = '[[private-tier]]';

/** What the reader is shown instead. */
export const PRIVATE_TIER_ANSWER =
  'Questions about his working arrangements are held in his private tier. ' +
  'To ask him directly, email hello@ryanlindsey.me. ' +
  'To have your agent ask instead, request a scoped token at the same address ' +
  'and connect it to his MCP server at https://mcp.ryanlindsey.me/mcp.';

export type GateStep = { kind: 'hold' } | { kind: 'pass'; text: string } | { kind: 'private' };

/**
 * Decides, from the start of a streamed answer, whether it is the marker.
 *
 * HOLDS ONLY WHILE THE ANSWER COULD STILL BE THE MARKER, so an ordinary answer
 * is delayed by at most the marker's sixteen characters: the first delta that
 * diverges releases everything held, and every delta after it passes straight
 * through. Leading whitespace is ignored, since a model may open with a
 * newline.
 *
 * ONLY A MARKER AT THE START COUNTS. Text streamed before a marker is already
 * on the reader's screen and cannot be taken back, so a marker mid-answer
 * passes through as text. The endpoint logs that case, because it means the
 * prompt was not followed.
 */
export class MarkerGate {
  private held = '';
  private decided: 'pass' | 'private' | null = null;

  push(text: string): GateStep {
    if (this.decided === 'private') return { kind: 'private' };
    if (this.decided === 'pass') return { kind: 'pass', text };

    this.held += text;
    const lead = this.held.trimStart();
    if (lead.startsWith(PRIVATE_TIER_MARKER)) {
      this.decided = 'private';
      this.held = '';
      return { kind: 'private' };
    }
    if (lead === '' || PRIVATE_TIER_MARKER.startsWith(lead)) return { kind: 'hold' };

    this.decided = 'pass';
    const released = this.held;
    this.held = '';
    return { kind: 'pass', text: released };
  }

  /**
   * The end of the stream. An answer that ended while still a prefix of the
   * marker is released as it stands rather than swallowed.
   */
  finish(): GateStep {
    if (this.decided === 'private') return { kind: 'private' };
    const released = this.held;
    this.held = '';
    this.decided = 'pass';
    return released === '' ? { kind: 'hold' } : { kind: 'pass', text: released };
  }
}
