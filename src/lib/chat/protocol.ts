// Two wire formats meet here, and keeping them apart is this module's whole job.
//
// UPSTREAM is the model's own SSE, as the Workers AI binding hands it back for
// a streaming Anthropic model. DOWNSTREAM is ours -- three named events, each
// with one JSON line, designed to be read by ~40 lines of client script.
//
// They are NOT passed through into each other. Re-emitting the model's frames
// would put its envelope (stop reasons, usage, block indices, whatever the
// provider adds next) on a public wire and make the browser parse a format we
// do not control. Ours carries what the page renders and nothing else.

/**
 * One downstream frame.
 *
 * `JSON.stringify` is what keeps the framing safe: SSE terminates a frame at a
 * blank line and a field at a newline, and a JSON string literal cannot contain
 * a raw newline -- so any newline in the payload arrives as `\n`, two
 * characters, and the frame stays one line of data. This is the reason the
 * payload is always an object rather than sometimes a bare string.
 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Pulls every text delta out of a buffer of upstream SSE, and hands back the
 * incomplete tail.
 *
 * STREAM PARSING IS BUFFER PARSING: a chunk boundary lands wherever the network
 * puts it, routinely mid-frame and occasionally mid-UTF-8-sequence. So this
 * takes a string, returns what it could not yet parse as `rest`, and the caller
 * concatenates the next chunk onto it. Splitting on '\n\n' and dropping the
 * remainder is the bug that produces a chat which loses a word every few
 * hundred characters and passes every test written against a single chunk.
 *
 * TOLERANT BY DESIGN. Unknown events are skipped, unparseable data lines are
 * skipped, and `[DONE]`-style sentinels are ignored. The set of events a
 * provider sends grows; the set this needs is one.
 */
export function parseModelSse(buffer: string): { text: string; rest: string; done: boolean } {
  const frames = buffer.split('\n\n');
  // The last element is either an incomplete frame or '' after a clean break.
  const rest = frames.pop() ?? '';
  let text = '';
  let done = false;

  for (const frame of frames) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const event = parsed as { type?: unknown; delta?: { type?: unknown; text?: unknown } };
      if (event.type === 'message_stop') done = true;
      if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        text += event.delta.text;
      }
    }
  }

  return { text, rest, done };
}
