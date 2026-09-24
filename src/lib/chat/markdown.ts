// The chat answer's markdown, as a tree and never as HTML (#403).
//
// DELIBERATELY SMALL. Paragraphs, bold, italic, inline code and two kinds of
// list are the whole language. Everything else a model might write -- a
// heading, a fence, a quote, a link -- stays as the characters it was written
// in, because a grounded answer a few paragraphs long has no use for them and
// every construct parsed is one more thing that can turn model text into
// structure.
//
// A LINK IS NEVER A NODE. The only links in an answer are citations, and a
// citation carries a number and nothing else; src/lib/chat/render.ts resolves
// the number against the `sources` frame. No URL the model wrote can reach an
// href, which is the client half of the guarantee src/lib/chat/context.ts
// describes.
//
// Parses ONE FINISHED BLOCK at a time. src/lib/chat/reveal.ts only hands over text that
// ended at a blank line, so this never sees half of a `**bold` mid-stream, and
// the hard part of streaming markdown does not exist here.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'citation'; n: number };

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'bullets'; items: Inline[][] }
  | { kind: 'numbered'; start: number; items: Inline[][] };

/**
 * One alternation, tried left to right at each position, which is what gives
 * inline code precedence: a backtick span is consumed whole before the
 * emphasis branches can see the asterisks inside it.
 *
 * The emphasis branches need a non-space just inside each delimiter, and the
 * single-character ones refuse a word character or another delimiter just
 * outside, so `2 * 3`, `**` left open and `snake_case_name` stay text.
 */
const INLINE =
  /`([^`\n]+)`|\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])|\[(\d+)\]/g;

const CITATION = /\[(\d+)\]/g;

function pushText(out: Inline[], text: string): void {
  if (text === '') return;
  const previous = out.at(-1);
  if (previous?.kind === 'text') previous.text += text;
  else out.push({ kind: 'text', text });
}

/** Text with its citations, the only thing allowed inside emphasis. */
function citationsIn(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(CITATION)) {
    pushText(out, text.slice(last, match.index));
    out.push({ kind: 'citation', n: Number(match[1]) });
    last = match.index + match[0].length;
  }
  pushText(out, text.slice(last));
  return out;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    pushText(out, text.slice(last, match.index));
    const [, code, strong, star, underscore, citation] = match;
    if (code !== undefined) out.push({ kind: 'code', text: code });
    else if (strong !== undefined) out.push({ kind: 'strong', children: citationsIn(strong) });
    else if (star !== undefined || underscore !== undefined)
      out.push({ kind: 'em', children: citationsIn(star ?? underscore ?? '') });
    else out.push({ kind: 'citation', n: Number(citation) });
    last = match.index + match[0].length;
  }
  pushText(out, text.slice(last));
  return out;
}

const BULLET = /^[-*] +(.+)$/;
const isMatch = (match: RegExpExecArray | null): match is RegExpExecArray => match !== null;
const NUMBERED = /^(\d+)\. +(.+)$/;

/** The lines as one list, or null unless every line is an item of one kind. */
function listOf(lines: string[]): Block | null {
  const bullets = lines.map((line) => BULLET.exec(line));
  if (bullets.every(isMatch)) {
    return { kind: 'bullets', items: bullets.map((match) => parseInline(match[1])) };
  }

  const numbered = lines.map((line) => NUMBERED.exec(line));
  if (numbered.every(isMatch)) {
    return {
      kind: 'numbered',
      start: Number(numbered[0][1]),
      items: numbered.map((match) => parseInline(match[2])),
    };
  }

  return null;
}

/**
 * One finished block as one or two blocks.
 *
 * A LIST IS EVERY LINE FROM ITS FIRST ITEM TO THE END. Prose lines before
 * that are a lead-in paragraph, because "Here are three:" on the line above
 * the items is how models most often write a list; the spec's first rule,
 * that any prose made the whole block a paragraph, rendered that as one run
 * of text with the dashes in it (final review, #403). Prose AFTER an item
 * still makes the whole block a paragraph, which renders the dashes as text
 * rather than guessing where the list ends.
 */
export function parseBlocks(source: string): Block[] {
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return [];

  const whole = listOf(lines);
  if (whole !== null) return [whole];

  const first = lines.findIndex((line) => BULLET.test(line) || NUMBERED.test(line));
  const tail = first > 0 ? listOf(lines.slice(first)) : null;
  if (tail !== null) {
    return [{ kind: 'paragraph', children: parseInline(lines.slice(0, first).join(' ')) }, tail];
  }

  return [{ kind: 'paragraph', children: parseInline(lines.join(' ')) }];
}
