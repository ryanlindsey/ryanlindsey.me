/**
 * PDF metadata stamping (issue #182), asserted against a real Chrome-written
 * PDF rather than against a synthesized one.
 *
 * WHY THE FIXTURE IS A REAL RENDER. The module is an incremental-update writer:
 * it appends to bytes somebody else produced, and every interesting failure is
 * a disagreement with what that producer actually wrote -- an xref offset that
 * lands one byte off, a catalog whose original entries were dropped, a trailer
 * that forgets `/Prev`. A hand-built two-object PDF exercises none of that,
 * because it is the module's own idea of a PDF being checked against itself.
 *
 * tests/fixtures/resume-sheet-sample.pdf is `/resume.print/` printed by
 * headless Chrome 153 on 2026-09-15, from the same `dist/client` the harness
 * boots. Measured on it: 3 pages, 80,893 bytes, PDF 1.4, a classic
 * cross-reference table, `Optimized: no`, no metadata stream, and all five
 * faces embedded as subset CID TrueType. That is the shape issue #182 records
 * against the deployed file, and the shape the append depends on.
 *
 * ASSERTED BLACK-BOX, ON THE BYTES. These tests re-read the stamped output by
 * searching raw bytes, not by calling the module's own parsing helpers. A test
 * that resolved the catalog through `stampPdfMetadata`'s xref walker would
 * agree with a walker that is wrong in the same direction; the point of the
 * offset test below is that it recomputes, independently, what the spec says
 * those numbers have to mean.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';
import {
  RESUME_PDF_LANGUAGE,
  resumePdfMetadata,
  stampPdfMetadata,
  type PdfMetadataFields,
} from '../src/lib/resume-pdf-metadata';
import type { Resume } from '../src/lib/resume';

const fixture = new Uint8Array(
  readFileSync(new URL('./fixtures/resume-sheet-sample.pdf', import.meta.url)),
);

// The real record, read with `yaml` for the reason tests/resume-sheet.test.ts's
// header gives: `astro:content` is an Astro-only virtual module and this suite
// runs under a plain `vitest run`.
const resume = parse(
  readFileSync(new URL('../src/content/resume/ryan-lindsey.yaml', import.meta.url), 'utf8'),
) as Resume;

const fields = resumePdfMetadata(resume);

/** Byte-for-byte text view. latin1 is the only 1:1 byte/char mapping. */
const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

/**
 * The UTF-16BE-with-BOM hex string PDF requires for a value that is not pure
 * ASCII, spelled the way the module writes it. Built here rather than imported
 * so the encoding is asserted, not assumed.
 */
const utf16BeHex = (value: string): string => {
  let hex = 'FEFF';
  for (const unit of Buffer.from(value, 'utf16le')) void unit;
  const buf = Buffer.from(value, 'utf16le').swap16();
  hex += buf.toString('hex').toUpperCase();
  return `<${hex}>`;
};

/** The `<<...>>` beginning at `open`, with nesting and literal strings respected. */
const matchDict = (text: string, open: number): string => {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    if (text[i] === '(') {
      let parens = 0;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '(') parens++;
        else if (text[i] === ')' && --parens === 0) {
          i++;
          break;
        }
        i++;
      }
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
      if (depth === 0) return text.slice(open, i);
      continue;
    }
    i++;
  }
  throw new Error('unbalanced dictionary');
};

/** The dictionary containing `needle` — for a key that sits inside one. */
const dictAround = (text: string, needle: string): string => {
  const at = text.indexOf(needle);
  expect(at, `expected to find ${needle}`).toBeGreaterThan(-1);
  return matchDict(text, text.lastIndexOf('<<', at));
};

/**
 * The dictionary that FOLLOWS `needle` — for `trailer`, where the keyword comes
 * first and the dictionary after it. Searching backwards from the keyword the
 * way dictAround does finds the last object in the file instead.
 */
const dictAfter = (text: string, needle: string): string => {
  const at = text.indexOf(needle);
  expect(at, `expected to find ${needle}`).toBeGreaterThan(-1);
  return matchDict(text, text.indexOf('<<', at));
};

/** Everything `stampPdfMetadata` appended, byte-for-byte. */
const appendedRegion = (stamped: Uint8Array, original: Uint8Array): string =>
  latin1(stamped.subarray(original.length));

/**
 * The same region decoded as UTF-8, which is the only correct reading of the
 * XMP packet: XMP is defined as UTF-8, so the em dash in the title is three
 * bytes there and would come back as three characters through latin1.
 */
const appendedUtf8 = (stamped: Uint8Array, original: Uint8Array): string =>
  Buffer.from(stamped.subarray(original.length)).toString('utf8');

/**
 * The smallest file this module will accept, carrying one Info value that is
 * NOT ASCII: a raw 0xE9 byte inside a literal string, which is legal PDF and
 * which Chrome happens never to emit. Built here rather than committed as a
 * second fixture because its whole point is the one byte, and a binary file
 * would hide it.
 */
const tinyPdf = (): Uint8Array => {
  const objects = [
    '<</Creator (café)\n/Producer (tiny)>>',
    '<</Type /Catalog\n/Pages 3 0 R>>',
    '<</Type /Pages\n/Kids [4 0 R]\n/Count 1>>',
    '<</Type /Page\n/Parent 3 0 R\n/MediaBox [0 0 612 792]>>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((dict, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${dict}\nendobj\n`;
  });

  const startxref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body +=
    `trailer\n<</Size ${objects.length + 1}\n/Root 2 0 R\n/Info 1 0 R>>\n` +
    `startxref\n${startxref}\n%%EOF\n`;

  // latin1, so the 0xE9 above is one byte in the file rather than two.
  return new Uint8Array(Buffer.from(body, 'latin1'));
};

const stamped = stampPdfMetadata(fixture, fields);

describe('the append never rewrites what is already there', () => {
  test('the stamped file opens with the original bytes, unchanged', () => {
    expect(stamped.length).toBeGreaterThan(fixture.length);
    expect(Buffer.from(stamped.subarray(0, fixture.length))).toEqual(Buffer.from(fixture));
  });

  test('the original catalog survives, superseded rather than edited', () => {
    const before = latin1(fixture).split('/Type /Catalog').length - 1;
    const after = latin1(stamped).split('/Type /Catalog').length - 1;
    expect(before).toBe(1);
    expect(after).toBe(2);
  });

  test('the page tree is untouched, so the page count cannot have moved', () => {
    const count = (bytes: Uint8Array): string => {
      const text = latin1(bytes);
      const matches = [...text.matchAll(/\/Type \/Pages\b/g)];
      expect(matches).toHaveLength(1);
      return /\/Count (\d+)/.exec(dictAround(text, '/Type /Pages'))![1];
    };
    expect(count(fixture)).toBe('3');
    expect(count(stamped)).toBe('3');
  });
});

/**
 * The three characters a PDF literal string must escape, restated here
 * rather than imported from the module under test: an expectation built by
 * calling the function it is checking proves only that the function is
 * itself. `pdfString` in src/lib/resume-pdf-metadata.ts backslash-escapes
 * the same three characters, and that escaping is correct PDF syntax -- a
 * literal string is delimited by parentheses, so an unescaped one inside the
 * value would terminate the string early and corrupt the dictionary.
 *
 * This assertion passed VACUOUSLY until 2026-09-16, when the skills section
 * gained keywords carrying parentheses ("MCP servers (Model Context
 * Protocol)"). Until then no value in the record contained a character
 * needing an escape, so the unescaped form happened to match the escaped
 * one. Author and Subject carry no parens or backslashes today either, but
 * they are strings from the same record read through the same `pdfString`,
 * so they get the same treatment rather than waiting for their own name to
 * grow one.
 */
const pdfLiteral = (value: string): string => value.replace(/([\\()])/g, '\\$1');

describe('the information dictionary', () => {
  const info = () => dictAround(appendedRegion(stamped, fixture), '/Author');

  test('Author, Subject and Keywords come from the record', () => {
    expect(fields.author).toBe(resume.basics.name);
    expect(fields.subject).toBe(resume.basics.label);

    const dict = info();
    expect(dict).toContain(`/Author (${pdfLiteral(resume.basics.name)})`);
    expect(dict).toContain(`/Subject (${pdfLiteral(resume.basics.label)})`);
    expect(dict).toContain(`/Keywords (${pdfLiteral(fields.keywords.join(', '))})`);
  });

  test('every skill in the record reaches Keywords', () => {
    for (const skill of resume.skills) {
      expect(fields.keywords).toContain(skill.name);
      for (const keyword of skill.keywords) expect(fields.keywords).toContain(keyword);
    }
  });

  test('a value that is not pure ASCII is written as a UTF-16BE hex string', () => {
    // The title carries an em dash, from `${label} — ${name}` in
    // src/pages/resume.print.astro. A literal `(...)` string would be read as
    // PDFDocEncoding and render the dash as garbage.
    expect(fields.title).toContain('—');
    expect(info()).toContain(`/Title ${utf16BeHex(fields.title)}`);
  });

  test("Chrome's own Creator and Producer are carried forward", () => {
    // Provenance the render is the only source of. Dropping it would make the
    // stamped file claim nothing about what drew it.
    const dict = info();
    expect(dict).toContain('/Producer (Skia/PDF m153)');
    expect(dict).toContain('/Creator (Chromium)');
  });

  test('a carried-over value keeps its bytes when it is not ASCII', () => {
    // The fixture cannot catch this: every value Chrome wrote into its Info
    // dictionary is ASCII, so a writer that re-encoded carried bytes as UTF-8
    // would round trip them unchanged and look correct. A single raw 0xE9 is
    // enough to tell the two apart -- re-encoded, it comes back as 0xC3 0xA9.
    const stampedTiny = stampPdfMetadata(tinyPdf(), {
      ...fields,
      title: 'T',
      author: 'A',
      subject: 'S',
      keywords: ['k'],
    });
    const appended = appendedRegion(stampedTiny, tinyPdf());
    expect(appended).toContain('/Creator (café)');
    expect(appended).not.toContain('Ã©');
  });

  test('CreationDate and ModDate are normalized to meta.lastModified', () => {
    const expected = `(D:${resume.meta.lastModified.replaceAll('-', '')}000000+00'00')`;
    const dict = info();
    expect(dict).toContain(`/CreationDate ${expected}`);
    expect(dict).toContain(`/ModDate ${expected}`);
    // The render's own timestamps must not survive into the stamped values.
    expect(dict).not.toContain('D:20260915');
  });
});

describe('the XMP packet', () => {
  const xmp = () => appendedUtf8(stamped, fixture);

  test('carries the Dublin Core equivalent of every Info field', () => {
    const packet = xmp();
    expect(packet).toContain(`<rdf:li xml:lang="x-default">${fields.title}</rdf:li>`);
    expect(packet).toContain(`<rdf:li>${fields.author}</rdf:li>`);
    expect(packet).toContain(`<rdf:li xml:lang="x-default">${fields.subject}</rdf:li>`);
    for (const keyword of fields.keywords) expect(packet).toContain(`<rdf:li>${keyword}</rdf:li>`);
  });

  test('declares the language', () => {
    expect(fields.language).toBe(RESUME_PDF_LANGUAGE);
    expect(xmp()).toContain(`<dc:language>`);
    expect(xmp()).toContain(`<rdf:li>${RESUME_PDF_LANGUAGE}</rdf:li>`);
  });

  test('points dc:identifier at the structured record', () => {
    // Where the machine-readable résumé lives, rather than a copy of it
    // embedded in the file (epic #180, decision 6: metadata only).
    expect(fields.identifier).toBe(`${resume.basics.url}/resume.json`);
    expect(fields.identifier).toBe('https://ryanlindsey.me/resume.json');
    expect(xmp()).toContain(`<dc:identifier>${fields.identifier}</dc:identifier>`);
  });

  test('identifies itself as PDF/UA-1, which clause 5 requires of any such file', () => {
    // Without this schema veraPDF reports a violation before it has looked at
    // the structure at all, so the file cannot be clean without it. It is a
    // statement of the target: scripts/resume-gate.mjs runs veraPDF report-only
    // because Chrome gives the link annotations no alternate description, and
    // this module appends rather than rewrites, so it cannot add one.
    expect(xmp()).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
    expect(xmp()).toContain('<pdfuaid:part>1</pdfuaid:part>');
  });

  test('is stored uncompressed, so the bytes stay readable without a parser', () => {
    const dict = dictAround(xmp(), '/Subtype /XML');
    expect(dict).toContain('/Type /Metadata');
    expect(dict).not.toContain('/Filter');
  });

  test('the catalog points at it', () => {
    const region = appendedRegion(stamped, fixture);
    const catalog = dictAround(region, '/Type /Catalog');
    const metadata = /\/Metadata (\d+) 0 R/.exec(catalog);
    expect(metadata).not.toBeNull();
    expect(region).toContain(`${metadata![1]} 0 obj`);
  });

  test('the original catalog entries all survive into the new one', () => {
    const before = dictAround(latin1(fixture), '/Type /Catalog');
    const after = dictAround(appendedRegion(stamped, fixture), '/Type /Catalog');
    for (const key of before.match(/\/[A-Za-z]+/g) ?? []) expect(after).toContain(key);
    expect(after).toContain('/StructTreeRoot');
    expect(after).toContain('/Lang');
  });
});

describe('the cross-reference section', () => {
  /**
   * Re-derives, from the spec rather than from the module, what the appended
   * xref section claims: every subsection entry must be a 20-byte record whose
   * offset lands exactly on `<objectNumber> <generation> obj`.
   */
  const readAppendedXref = (bytes: Uint8Array) => {
    const text = latin1(bytes);
    const start = parseInt(text.slice(text.lastIndexOf('startxref') + 9).trim(), 10);
    expect(text.startsWith('xref', start)).toBe(true);
    let cursor = start + 'xref'.length;
    const entries: { object: number; offset: number; type: string }[] = [];
    for (;;) {
      const header = /^\s*(\d+)\s+(\d+)\s*\n/.exec(text.slice(cursor, cursor + 64));
      if (!header) break;
      const first = Number(header[1]);
      cursor += header[0].length;
      for (let i = 0; i < Number(header[2]); i++) {
        const record = text.slice(cursor, cursor + 20);
        expect(record).toMatch(/^\d{10} \d{5} [nf][ \r\n]{2}$/);
        entries.push({
          object: first + i,
          offset: Number(record.slice(0, 10)),
          type: record[17],
        });
        cursor += 20;
      }
      if (text.startsWith('trailer', cursor)) break;
    }
    const trailer = dictAfter(text.slice(cursor), 'trailer');
    return { entries, trailer, start };
  };

  test('every offset it publishes lands on the object it names', () => {
    const text = latin1(stamped);
    const { entries } = readAppendedXref(stamped);
    const inUse = entries.filter((entry) => entry.type === 'n');
    expect(inUse.length).toBeGreaterThanOrEqual(3);
    for (const entry of inUse) {
      expect(text.startsWith(`${entry.object} 0 obj`, entry.offset)).toBe(true);
    }
  });

  test('it chains to the previous section rather than replacing it', () => {
    const originalStart = parseInt(
      latin1(fixture)
        .slice(latin1(fixture).lastIndexOf('startxref') + 9)
        .trim(),
      10,
    );
    const { trailer } = readAppendedXref(stamped);
    expect(trailer).toContain(`/Prev ${originalStart}`);
  });

  test('it keeps /Root and grows /Size by exactly the two new objects', () => {
    const originalTrailer = dictAfter(latin1(fixture), 'trailer');
    const { trailer } = readAppendedXref(stamped);
    const size = (dict: string) => Number(/\/Size (\d+)/.exec(dict)![1]);
    const root = (dict: string) => /\/Root (\d+ \d+ R)/.exec(dict)![1];

    expect(root(trailer)).toBe(root(originalTrailer));
    expect(size(trailer)).toBe(size(originalTrailer) + 2);
  });

  test('the file still ends with %%EOF', () => {
    expect(latin1(stamped).trimEnd().endsWith('%%EOF')).toBe(true);
  });
});

describe('stamping is repeatable', () => {
  test('two runs over identical input produce identical bytes', () => {
    // Nothing in the output may be read off the clock: the whole point of
    // normalizing the dates is that a rebuild of unchanged content is a no-op
    // for anything downstream that compares bytes.
    expect(Buffer.from(stampPdfMetadata(fixture, fields))).toEqual(Buffer.from(stamped));
  });

  test('stamping twice appends again and leaves the first result intact', () => {
    const twice = stampPdfMetadata(stamped, fields);
    expect(twice.length).toBeGreaterThan(stamped.length);
    expect(Buffer.from(twice.subarray(0, stamped.length))).toEqual(Buffer.from(stamped));
  });

  test('the twice-stamped catalog carries exactly one /Metadata', () => {
    // The failure this catches: re-emitting the current catalog verbatim and
    // appending a second /Metadata key, which is a duplicate key in one
    // dictionary and undefined behavior for the reader that meets it.
    const twice = stampPdfMetadata(stamped, fields);
    const catalog = dictAround(appendedRegion(twice, stamped), '/Type /Catalog');
    expect(catalog.match(/\/Metadata /g)).toHaveLength(1);
  });

  test('the twice-stamped file still resolves its own cross-reference section', () => {
    const twice = stampPdfMetadata(stamped, fields);
    const text = latin1(twice);
    const start = parseInt(text.slice(text.lastIndexOf('startxref') + 9).trim(), 10);
    expect(text.startsWith('xref', start)).toBe(true);
    // /Prev must now chain to the FIRST stamp's section, not the original's.
    const firstStamp = parseInt(
      latin1(stamped)
        .slice(latin1(stamped).lastIndexOf('startxref') + 9)
        .trim(),
      10,
    );
    expect(dictAfter(text.slice(start), 'trailer')).toContain(`/Prev ${firstStamp}`);
  });
});

describe('resumePdfMetadata', () => {
  test('derives every field from the record it is given', () => {
    const synthetic: Resume = {
      basics: {
        name: 'A Person',
        label: 'A Role',
        summary: 'A summary.',
        url: 'https://example.invalid',
        location: { city: 'Town', region: 'ST', countryCode: 'US' },
        profiles: [],
      },
      work: [],
      education: [],
      skills: [{ name: 'Group', keywords: ['one', 'two'] }],
      projects: [],
      meta: { version: '1.0.0', lastModified: '2020-01-02' },
    } as Resume;

    expect(resumePdfMetadata(synthetic)).toEqual({
      title: 'A Role — A Person',
      author: 'A Person',
      subject: 'A Role',
      keywords: ['Group', 'one', 'two'],
      date: '2020-01-02',
      language: 'en',
      identifier: 'https://example.invalid/resume.json',
    } satisfies PdfMetadataFields);
  });

  test('de-duplicates a keyword that two skill groups share', () => {
    const shared = {
      ...resume,
      skills: [
        { name: 'First', keywords: ['CI/CD', 'shared'] },
        { name: 'Second', keywords: ['shared', 'API design'] },
      ],
    } satisfies Resume;
    expect(resumePdfMetadata(shared).keywords).toEqual([
      'First',
      'CI/CD',
      'shared',
      'Second',
      'API design',
    ]);
  });
});
