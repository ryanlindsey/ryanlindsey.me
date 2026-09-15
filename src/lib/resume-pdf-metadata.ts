import type { Resume } from './resume';

/*
 * Stamps Info-dictionary and XMP metadata onto a PDF that Chrome already wrote
 * (issue #182, epic #180).
 *
 * WHY THIS EXISTS AT ALL. `Page.printToPDF` sets `Title`, `Creator` and
 * `Producer` and nothing else. There is no CDP parameter for `Author`,
 * `Subject`, `Keywords` or XMP, so a rendered sheet carries none of them and
 * the deployed file never has.
 *
 * WHY THERE IS NO PDF LIBRARY HERE. Chrome writes PDF 1.4 with a classic
 * cross-reference table and uncompressed objects. Verified 2026-09-14 against
 * the deployed file and again 2026-09-15 against
 * tests/fixtures/resume-sheet-sample.pdf: `pdfinfo` reports `PDF version: 1.4`
 * and `Optimized: no`, and `/Count`, `/MediaBox` and `/Creator` are readable in
 * the raw bytes. That makes an INCREMENTAL UPDATE the right tool, and an
 * incremental update is append-only by definition.
 *
 * So this module appends: a new Info dictionary, an XMP stream, a new catalog
 * pointing at that stream, then a cross-reference section whose `/Prev` points
 * at the old one. Not one byte already in the file is rewritten, which is why
 * the tagged-content tree, the embedded font programs and the link annotations
 * cannot be damaged by this code -- it never addresses them. A library that
 * re-serializes the whole document could damage all three, and nothing in CI
 * would say so, because the assertions that would catch it are about visual
 * output nobody diffs.
 *
 * The prefix-identity assertion in tests/resume-pdf-metadata.test.ts is the
 * executable form of that argument. It is the design, not a detail.
 *
 * WHAT IT DOES NOT HANDLE, deliberately: cross-reference STREAMS and object
 * streams, which is PDF 1.5+ and what a "linearized" or "optimized" writer
 * emits. Chrome emits neither. Meeting one throws, rather than half-parsing
 * into a file that looks stamped and is corrupt.
 */

/**
 * The language the sheet declares. Tracks `<html lang>` in
 * src/pages/resume.print.astro; the résumé record has no language field, and
 * inventing one there to feed this would be a schema change nothing else reads.
 */
export const RESUME_PDF_LANGUAGE = 'en';

/** Where the structured record lives, relative to `basics.url`. */
export const RESUME_JSON_PATH = '/resume.json';

export interface PdfMetadataFields {
  title: string;
  author: string;
  subject: string;
  keywords: readonly string[];
  /** YYYY-MM-DD. Both `CreationDate` and `ModDate` are set from this. */
  date: string;
  language: string;
  /** Absolute URL of the machine-readable résumé. */
  identifier: string;
}

/**
 * Every field read off the résumé record, never written here. The failure this
 * shape exists to prevent is the one the epic opens with: a PDF whose contents
 * disagreed with the record it came from, shipped and stayed shipped because
 * nothing compared the two. A hand-authored keyword list would go stale the
 * first time `skills` changed, and no test would notice.
 *
 * `Subject` is `basics.label` rather than `basics.summary`. Subject is the
 * subject of the document, and the summary is a description of it; the summary
 * would also make `Subject` and `dc:description` a paragraph in a field readers
 * render on one line. The summary is on the sheet and in /resume.json, which
 * `dc:identifier` points at.
 */
export function resumePdfMetadata(resume: Resume): PdfMetadataFields {
  const { basics, skills, meta } = resume;

  if (!basics.url) {
    throw new Error('basics.url is required: dc:identifier is built from it');
  }

  // Group names carry as much signal as the keywords under them ("Agentic
  // engineering" is a term someone searches for), so both go in, in record
  // order. De-duplicated because two groups may legitimately share a keyword
  // and a repeated term in /Keywords is noise.
  const keywords: string[] = [];
  for (const skill of skills) {
    for (const value of [skill.name, ...skill.keywords]) {
      if (!keywords.includes(value)) keywords.push(value);
    }
  }

  return {
    // The same spelling src/pages/resume.print.astro gives its <title>, so the
    // stamped title and the rendered one cannot disagree.
    title: `${basics.label} — ${basics.name}`,
    author: basics.name,
    subject: basics.label,
    keywords,
    date: meta.lastModified,
    language: RESUME_PDF_LANGUAGE,
    identifier: `${basics.url}${RESUME_JSON_PATH}`,
  };
}

/* -------------------------------------------------------------------------- *
 * Reading the file
 * -------------------------------------------------------------------------- */

const encoder = new TextEncoder();

/**
 * The inverse of decodeLatin1, and the ONLY correct encoder for the PDF syntax
 * this module emits.
 *
 * Every carried-over value -- `/Creator`, `/Producer`, anything else Chrome put
 * in the Info dictionary -- arrives here as latin1-decoded characters, one per
 * original byte. Running those through `TextEncoder` would re-encode each byte
 * above 0x7F as the two bytes of its UTF-8 form, silently corrupting a value
 * this module promised only to carry. The XMP packet is the one exception: it
 * is genuinely UTF-8 and is encoded as such, then pushed as bytes.
 *
 * Throws rather than truncating on a code unit that cannot be a byte, so a
 * future edit that interpolates a non-ASCII literal into PDF syntax fails here
 * instead of writing a file that is wrong in a way only a hex dump shows.
 */
function encodeLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new Error(
        `cannot write U+${code.toString(16).toUpperCase()} as a PDF syntax byte: ` +
          'text outside latin1 belongs in a PDF string object or the XMP packet',
      );
    }
    bytes[i] = code;
  }
  return bytes;
}

/**
 * Bytes as characters, one for one. latin1 is the only encoding that round
 * trips arbitrary bytes through a JavaScript string, which is what lets the
 * scanning below use string indices as BYTE OFFSETS -- the whole cross-
 * reference format is byte offsets, so anything that re-encodes (`TextDecoder`
 * with utf-8, say) silently shifts every number this module writes.
 */
function decodeLatin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

const WHITESPACE = new Set([' ', '\t', '\r', '\n', '\f', '\0']);
const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

function skipWhitespace(text: string, start: number): number {
  let i = start;
  for (;;) {
    while (i < text.length && WHITESPACE.has(text[i])) i++;
    if (text[i] !== '%') return i;
    while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
  }
}

/** `text[start]` is `(`. Returns the index just past the closing `)`. */
function skipLiteralString(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new Error('unterminated literal string');
}

/**
 * `text[start]` begins `<<`. Returns the index just past the matching `>>`.
 *
 * Literal strings are skipped whole rather than scanned, because `>>` inside
 * `(...)` is text, not a delimiter -- and a link annotation's `/URI` is exactly
 * where such a string turns up.
 */
function skipDictionary(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const char = text[i];
    if (char === '%') {
      i = skipWhitespace(text, i);
      continue;
    }
    if (char === '(') {
      i = skipLiteralString(text, i);
      continue;
    }
    if (text.startsWith('<<', i)) {
      depth++;
      i += 2;
      continue;
    }
    if (text.startsWith('>>', i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    if (char === '<') {
      const close = text.indexOf('>', i);
      if (close === -1) throw new Error('unterminated hex string');
      i = close + 1;
      continue;
    }
    i++;
  }
  throw new Error('unterminated dictionary');
}

/** The index just past one object value beginning at `start`. */
function skipValue(text: string, start: number): number {
  const i = skipWhitespace(text, start);
  if (text.startsWith('<<', i)) return skipDictionary(text, i);
  if (text[i] === '(') return skipLiteralString(text, i);
  if (text[i] === '<') {
    const close = text.indexOf('>', i);
    if (close === -1) throw new Error('unterminated hex string');
    return close + 1;
  }
  if (text[i] === '[') {
    let depth = 0;
    let j = i;
    while (j < text.length) {
      if (text[j] === '(') {
        j = skipLiteralString(text, j);
        continue;
      }
      if (text.startsWith('<<', j)) {
        j = skipDictionary(text, j);
        continue;
      }
      if (text[j] === '[') depth++;
      else if (text[j] === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    throw new Error('unterminated array');
  }

  // A bare token: a name, a number, a keyword. `12 0 R` is three tokens and one
  // value, so a number is only finished once the reference form is ruled out.
  let j = i;
  if (text[j] === '/') j++;
  while (j < text.length && !WHITESPACE.has(text[j]) && !DELIMITERS.has(text[j])) j++;
  const token = text.slice(i, j);
  if (/^\d+$/.test(token)) {
    const reference = /^\s+\d+\s+R\b/.exec(text.slice(j));
    if (reference) return j + reference[0].length;
  }
  return j;
}

/**
 * One dictionary's entries as `[name, rawValueSource]`, values kept verbatim.
 * Verbatim is the point: a carried-over entry is re-emitted exactly as Chrome
 * wrote it, so this module never has to understand a value in order to preserve
 * it.
 */
function dictionaryEntries(inner: string): [string, string][] {
  const entries: [string, string][] = [];
  let i = 0;
  for (;;) {
    i = skipWhitespace(inner, i);
    if (i >= inner.length) return entries;
    if (inner[i] !== '/') {
      throw new Error(`expected a name at offset ${i} of a dictionary`);
    }
    let keyEnd = i + 1;
    while (
      keyEnd < inner.length &&
      !WHITESPACE.has(inner[keyEnd]) &&
      !DELIMITERS.has(inner[keyEnd])
    ) {
      keyEnd++;
    }
    const key = inner.slice(i, keyEnd);
    const valueStart = skipWhitespace(inner, keyEnd);
    const valueEnd = skipValue(inner, valueStart);
    entries.push([key, inner.slice(valueStart, valueEnd).trim()]);
    i = valueEnd;
  }
}

/** The dictionary body of the indirect object at `offset`, without `<<`/`>>`. */
function objectDictionaryAt(text: string, offset: number, expected: number): string {
  const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(text.slice(offset, offset + 64));
  if (!header) throw new Error(`no object header at offset ${offset}`);
  if (Number(header[1]) !== expected) {
    throw new Error(`offset ${offset} holds object ${header[1]}, expected ${expected}`);
  }
  const open = text.indexOf('<<', offset);
  if (open === -1) throw new Error(`object ${expected} has no dictionary`);
  return text.slice(open + 2, skipDictionary(text, open) - 2);
}

interface XrefSection {
  entries: [number, number][];
  trailer: string;
}

/** One classic cross-reference section, starting at the `xref` keyword. */
function readXrefSection(text: string, start: number): XrefSection {
  if (!text.startsWith('xref', start)) {
    // A cross-reference STREAM lands here. See the module header: Chrome does
    // not write them, and guessing is worse than stopping.
    throw new Error(
      `expected a classic cross-reference table at ${start}; ` +
        'cross-reference streams (PDF 1.5+) are not supported',
    );
  }
  const entries: [number, number][] = [];
  let i = start + 'xref'.length;
  for (;;) {
    i = skipWhitespace(text, i);
    if (text.startsWith('trailer', i)) break;
    const header = /^(\d+)\s+(\d+)[ \t]*(\r\n|\r|\n)/.exec(text.slice(i, i + 64));
    if (!header) throw new Error(`malformed cross-reference subsection at ${i}`);
    const first = Number(header[1]);
    const count = Number(header[2]);
    i += header[0].length;
    for (let n = 0; n < count; n++) {
      const record = text.slice(i, i + 20);
      if (!/^\d{10} \d{5} [nf]/.test(record)) {
        throw new Error(`malformed cross-reference entry for object ${first + n}`);
      }
      if (record[17] === 'n') entries.push([first + n, Number(record.slice(0, 10))]);
      i += 20;
    }
  }
  const open = text.indexOf('<<', i);
  if (open === -1) throw new Error('cross-reference section has no trailer dictionary');
  return { entries, trailer: text.slice(open + 2, skipDictionary(text, open) - 2) };
}

interface ResolvedXref {
  /** Object number to byte offset, newest definition winning. */
  offsets: Map<number, number>;
  /** The newest trailer's entries. */
  trailer: [string, string][];
}

/**
 * Walks the `/Prev` chain from the newest section backwards, which is the only
 * way to resolve an object in a file that has already been updated once.
 *
 * NEWEST WINS, so entries are only recorded the first time an object number is
 * seen. Searching the raw bytes for the last `N 0 obj` instead would be shorter
 * and wrong: that string also occurs inside uncompressed content streams, and
 * the file is full of them.
 */
function resolveXref(text: string, start: number): ResolvedXref {
  const offsets = new Map<number, number>();
  const visited = new Set<number>();
  let trailer: [string, string][] | null = null;
  let at: number | null = start;

  while (at !== null) {
    if (visited.has(at)) throw new Error('cross-reference chain loops');
    visited.add(at);
    const section = readXrefSection(text, at);
    for (const [object, offset] of section.entries) {
      if (!offsets.has(object)) offsets.set(object, offset);
    }
    const entries = dictionaryEntries(section.trailer);
    trailer ??= entries;
    const previous = entries.find(([key]) => key === '/Prev')?.[1];
    at = previous === undefined ? null : Number(previous);
  }

  if (trailer === null) throw new Error('no trailer dictionary found');
  return { offsets, trailer };
}

/* -------------------------------------------------------------------------- *
 * Writing the update
 * -------------------------------------------------------------------------- */

/**
 * A PDF text string. Pure-ASCII values stay in literal `(...)` form so they
 * remain readable in the raw bytes -- the same property this module relies on
 * when reading -- and anything else becomes a UTF-16BE hex string with a BOM,
 * which is what the em dash in the title requires. A literal string is
 * PDFDocEncoded, and PDFDocEncoding has no em dash.
 */
function pdfString(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return `(${value.replace(/([\\()])/g, '\\$1')})`;
  }
  let hex = 'FEFF';
  for (const unit of utf16CodeUnits(value)) {
    hex += unit.toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

function* utf16CodeUnits(value: string): Generator<number> {
  for (let i = 0; i < value.length; i++) yield value.charCodeAt(i);
}

/** `D:YYYYMMDD000000+00'00'`, the PDF date form, from a YYYY-MM-DD date. */
function pdfDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`expected a YYYY-MM-DD date, got ${JSON.stringify(date)}`);
  }
  // Midnight UTC rather than the render's clock. This is what makes two runs
  // over identical input produce identical bytes, which is the property the
  // whole build depends on: a rebuild that changes the PDF's bytes for no
  // content reason republishes the artifact for no reason.
  return `D:${date.replaceAll('-', '')}000000+00'00'`;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

const xml = (value: string): string => value.replace(/[&<>"]/g, (char) => XML_ESCAPES[char]);

/**
 * The XMP packet. Dublin Core carries the same four values the Info dictionary
 * does, because they are the same facts and a reader that trusts one over the
 * other must not find them disagreeing.
 *
 * `dc:identifier` is the reason this packet is worth writing at all: it tells
 * an agent holding the PDF where the structured record is, without embedding a
 * copy that would go stale the moment the YAML changed (epic #180, decision 6:
 * metadata only, no embedded attachment).
 *
 * THE pdfuaid DESCRIPTION STATES THE TARGET, NOT A PASSING GRADE. ISO 14289-1
 * clause 5 requires a PDF/UA file to identify itself through this schema, and
 * without it veraPDF reports a violation before it has looked at anything else
 * -- so the file cannot be clean without it. It is its own rdf:Description
 * because the schema is a separate namespace from Dublin Core, which is how
 * every reference packet writes it.
 *
 * MEASURED 2026-09-15, AND THE SHEET DOES NOT YET MEET WHAT THIS CLAIMS. Chrome
 * writes each Link annotation with a /StructParent and no /Contents, and there
 * is no /Alt anywhere in the file, so clause 7.18.5 wants an alternate
 * description that none of the seven links has. That cannot be repaired here:
 * this module appends and never rewrites, which is the guarantee that keeps the
 * tag tree, the embedded fonts and those same annotations safe, and fixing the
 * links would mean giving it up. The honest arrangement is this declaration
 * plus the report-only veraPDF step in checks.yml: the target is stated, the
 * gap is printed on every run, and neither is quietly true. Do not make that
 * step blocking until the link descriptions exist.
 */
function xmpPacket(fields: PdfMetadataFields): string {
  const keywords = fields.keywords
    .map((keyword) => `     <rdf:li>${xml(keyword)}</rdf:li>`)
    .join('\n');

  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <dc:format>application/pdf</dc:format>
   <dc:title>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${xml(fields.title)}</rdf:li>
    </rdf:Alt>
   </dc:title>
   <dc:creator>
    <rdf:Seq>
     <rdf:li>${xml(fields.author)}</rdf:li>
    </rdf:Seq>
   </dc:creator>
   <dc:description>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${xml(fields.subject)}</rdf:li>
    </rdf:Alt>
   </dc:description>
   <dc:subject>
    <rdf:Bag>
${keywords}
    </rdf:Bag>
   </dc:subject>
   <dc:language>
    <rdf:Bag>
     <rdf:li>${xml(fields.language)}</rdf:li>
    </rdf:Bag>
   </dc:language>
   <dc:identifier>${xml(fields.identifier)}</dc:identifier>
   <xmp:CreateDate>${xml(fields.date)}</xmp:CreateDate>
   <xmp:ModifyDate>${xml(fields.date)}</xmp:ModifyDate>
   <xmp:MetadataDate>${xml(fields.date)}</xmp:MetadataDate>
   <pdf:Keywords>${xml(fields.keywords.join(', '))}</pdf:Keywords>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
   <pdfuaid:part>1</pdfuaid:part>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

/** The keys this module owns. Anything else in the old Info dict is carried. */
const STAMPED_INFO_KEYS = new Set([
  '/Title',
  '/Author',
  '/Subject',
  '/Keywords',
  '/CreationDate',
  '/ModDate',
]);

/** A 20-byte classic cross-reference entry. */
function xrefEntry(offset: number): string {
  return `${String(offset).padStart(10, '0')} 00000 n \n`;
}

/** Contiguous runs of object numbers, so the section can name its subsections. */
function contiguousRuns(numbers: number[]): number[][] {
  const runs: number[][] = [];
  for (const value of [...numbers].sort((a, b) => a - b)) {
    const current = runs[runs.length - 1];
    if (current && current[current.length - 1] === value - 1) current.push(value);
    else runs.push([value]);
  }
  return runs;
}

/**
 * Appends an incremental update carrying `fields`.
 *
 * Returns new bytes whose first `input.length` bytes are the input, unchanged.
 * Stamping an already-stamped file appends a second update rather than editing
 * the first, and resolves the catalog through the newest cross-reference
 * section, so the result carries exactly one `/Metadata` entry either way.
 */
export function stampPdfMetadata(input: Uint8Array, fields: PdfMetadataFields): Uint8Array {
  const text = decodeLatin1(input);

  const marker = text.lastIndexOf('startxref');
  if (marker === -1) throw new Error('no startxref: this is not a PDF this module can update');
  const previousXref = Number(/^\s*(\d+)/.exec(text.slice(marker + 'startxref'.length))?.[1]);
  if (!Number.isInteger(previousXref)) throw new Error('unreadable startxref offset');

  const { offsets, trailer } = resolveXref(text, previousXref);
  const lookup = (key: string): string => {
    const value = trailer.find(([name]) => name === key)?.[1];
    if (value === undefined) throw new Error(`trailer has no ${key}`);
    return value;
  };

  const size = Number(lookup('/Size'));
  const rootNumber = Number(/^(\d+)\s+\d+\s+R$/.exec(lookup('/Root'))?.[1]);
  const infoNumber = Number(/^(\d+)\s+\d+\s+R$/.exec(lookup('/Info'))?.[1]);
  if (!Number.isInteger(size) || !Number.isInteger(rootNumber)) {
    throw new Error('trailer /Size or /Root is not usable');
  }

  const newInfoNumber = size;
  const metadataNumber = size + 1;

  // -- the Info dictionary ---------------------------------------------------
  // Carried forward rather than replaced wholesale: /Creator and /Producer are
  // the render's own provenance ("Skia/PDF m153"), and this module is not their
  // source. Only the six keys it owns are dropped and rewritten.
  const carried = Number.isInteger(infoNumber)
    ? dictionaryEntries(objectDictionaryAt(text, offsets.get(infoNumber) ?? -1, infoNumber)).filter(
        ([key]) => !STAMPED_INFO_KEYS.has(key),
      )
    : [];

  const infoBody = [
    ...carried.map(([key, value]) => `${key} ${value}`),
    `/Title ${pdfString(fields.title)}`,
    `/Author ${pdfString(fields.author)}`,
    `/Subject ${pdfString(fields.subject)}`,
    `/Keywords ${pdfString(fields.keywords.join(', '))}`,
    `/CreationDate (${pdfDate(fields.date)})`,
    `/ModDate (${pdfDate(fields.date)})`,
  ].join('\n');

  // -- the XMP stream --------------------------------------------------------
  // Uncompressed, and that is a requirement rather than laziness: a metadata
  // stream is the one place a consumer is entitled to read without running a
  // filter, and PDF/A forbids compressing it.
  const packet = encoder.encode(xmpPacket(fields));

  // -- the catalog -----------------------------------------------------------
  // Re-emitted under its ORIGINAL object number, so `/Root` never moves. Every
  // entry Chrome wrote is copied verbatim; only /Metadata is replaced, which is
  // what keeps a second stamping from leaving two of them in one dictionary.
  const catalogEntries = dictionaryEntries(
    objectDictionaryAt(text, offsets.get(rootNumber) ?? -1, rootNumber),
  ).filter(([key]) => key !== '/Metadata');
  const catalogBody = [
    ...catalogEntries.map(([key, value]) => `${key} ${value}`),
    `/Metadata ${metadataNumber} 0 R`,
  ].join('\n');

  // -- assemble --------------------------------------------------------------
  const chunks: Uint8Array[] = [input];
  let cursor = input.length;
  const push = (value: Uint8Array | string): void => {
    const bytes = typeof value === 'string' ? encodeLatin1(value) : value;
    chunks.push(bytes);
    cursor += bytes.byteLength;
  };

  // An incremental update begins on its own line. Chrome ends the file with a
  // newline after %%EOF; a producer that does not would otherwise have its last
  // line joined to the first appended object.
  const lastByte = input[input.length - 1];
  if (lastByte !== 0x0a && lastByte !== 0x0d) push('\n');

  const objectOffsets = new Map<number, number>();

  objectOffsets.set(newInfoNumber, cursor);
  push(`${newInfoNumber} 0 obj\n<<\n${infoBody}\n>>\nendobj\n`);

  objectOffsets.set(metadataNumber, cursor);
  push(
    `${metadataNumber} 0 obj\n<</Type /Metadata\n/Subtype /XML\n/Length ${packet.byteLength}>>\nstream\n`,
  );
  push(packet);
  push('\nendstream\nendobj\n');

  objectOffsets.set(rootNumber, cursor);
  push(`${rootNumber} 0 obj\n<<\n${catalogBody}\n>>\nendobj\n`);

  const xrefOffset = cursor;
  const runs = contiguousRuns([...objectOffsets.keys()]);
  const section = runs
    .map(
      (run) =>
        `${run[0]} ${run.length}\n` +
        run.map((object) => xrefEntry(objectOffsets.get(object)!)).join(''),
    )
    .join('');

  push(
    `xref\n${section}trailer\n<</Size ${metadataNumber + 1}\n` +
      `/Root ${rootNumber} 0 R\n/Info ${newInfoNumber} 0 R\n` +
      `/Prev ${previousXref}\n>>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  const output = new Uint8Array(cursor);
  let at = 0;
  for (const chunk of chunks) {
    output.set(chunk, at);
    at += chunk.byteLength;
  }
  return output;
}
