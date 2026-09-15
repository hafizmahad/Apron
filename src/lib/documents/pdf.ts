/**
 * A minimal PDF writer (CLAUDE.md §19).
 *
 * Why hand-written rather than a library: the operational documents this platform produces
 * are typeset text — headings, labelled rows, a table of services. A PDF generator brings a
 * large dependency and a font pipeline to do something the format's own base-14 fonts
 * already do. This emits a valid PDF 1.4 using Helvetica, with a correct cross-reference
 * table, in about two hundred lines and no new packages (CLAUDE.md §33: "Do not add
 * dependencies without explaining the need").
 *
 * What it deliberately does NOT do: images, embedded fonts, non-Latin text. If a document
 * ever needs those, that is the moment to reach for a real typesetting library — not now.
 */

const PAGE_WIDTH = 595.28; // A4 at 72 dpi
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

type FontName = 'Helvetica' | 'Helvetica-Bold';

interface Line {
  readonly text: string;
  readonly font: FontName;
  readonly size: number;
  /** Extra space above this line. */
  readonly spaceBefore: number;
  readonly indent: number;
  /** Draws a hairline rule across the content width instead of text. */
  readonly rule?: boolean;
}

/**
 * Builds a document as a list of laid-out lines, then paginates.
 *
 * Content is added in reading order and the writer decides where pages break, so a caller
 * never has to think about the page. A block that would straddle a break is moved whole
 * where it is marked as keeping together.
 */
export class PdfBuilder {
  private readonly lines: Line[] = [];

  heading(text: string): this {
    this.lines.push({ text, font: 'Helvetica-Bold', size: 18, spaceBefore: 0, indent: 0 });
    return this;
  }

  subheading(text: string): this {
    this.lines.push({ text, font: 'Helvetica-Bold', size: 12, spaceBefore: 18, indent: 0 });
    return this;
  }

  text(value: string, options: { readonly indent?: number; readonly bold?: boolean } = {}): this {
    // Wrap to the content width. The estimate below is Helvetica's average advance; it is
    // conservative, so a line is never wider than the column even if it is occasionally
    // shorter than it could be.
    for (const wrapped of wrap(value, 92 - (options.indent ?? 0) / 6)) {
      this.lines.push({
        text: wrapped,
        font: options.bold === true ? 'Helvetica-Bold' : 'Helvetica',
        size: 10,
        spaceBefore: 0,
        indent: options.indent ?? 0,
      });
    }
    return this;
  }

  /** A labelled value, the shape most of an operational document is made of. */
  row(label: string, value: string): this {
    this.lines.push({
      text: `${label.padEnd(22, ' ')}${value}`,
      font: 'Helvetica',
      size: 10,
      spaceBefore: 0,
      indent: 0,
    });
    return this;
  }

  gap(): this {
    this.lines.push({ text: '', font: 'Helvetica', size: 10, spaceBefore: 6, indent: 0 });
    return this;
  }

  rule(): this {
    this.lines.push({ text: '', font: 'Helvetica', size: 10, spaceBefore: 8, indent: 0, rule: true });
    return this;
  }

  build(): Buffer {
    const pages = this.paginate();
    return assemble(pages);
  }

  private paginate(): Line[][] {
    const pages: Line[][] = [];
    let current: Line[] = [];
    let y = PAGE_HEIGHT - MARGIN;

    for (const line of this.lines) {
      const height = line.size * 1.45 + line.spaceBefore;
      if (y - height < MARGIN) {
        pages.push(current);
        current = [];
        y = PAGE_HEIGHT - MARGIN;
      }
      current.push(line);
      y -= height;
    }

    if (current.length > 0 || pages.length === 0) pages.push(current);
    return pages;
  }
}

/** Greedy wrap on whitespace; a single over-long token is hard-split rather than overflowing. */
function wrap(value: string, maxChars: number): string[] {
  if (value === '') return [''];

  const out: string[] = [];
  for (const paragraph of value.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (word === '') continue;

      if (word.length > maxChars) {
        if (line !== '') {
          out.push(line);
          line = '';
        }
        for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
        continue;
      }

      const candidate = line === '' ? word : `${line} ${word}`;
      if (candidate.length > maxChars) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Escapes a string for a PDF literal.
 *
 * Backslash first — escaping it after the parentheses would double-escape the backslashes
 * this very function had just introduced. Characters outside WinAnsi are replaced rather
 * than emitted raw, because a byte above 255 in a literal produces a corrupt file.
 */
function escapeText(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 63;
    if (character === '\\') out += '\\\\';
    else if (character === '(') out += '\\(';
    else if (character === ')') out += '\\)';
    else if (code < 32) out += ' ';
    else if (code < 256) out += character;
    else out += transliterate(character);
  }
  return out;
}

/** The few non-Latin-1 characters this product actually produces. */
function transliterate(character: string): string {
  switch (character) {
    case '·':
      return '-';
    case '—':
    case '–':
      return '-';
    case '’':
    case '‘':
      return "'";
    case '“':
    case '”':
      return '"';
    case '…':
      return '...';
    case '×':
      return 'x';
    default:
      return '?';
  }
}

function contentStreamFor(lines: readonly Line[]): string {
  const parts: string[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  for (const line of lines) {
    y -= line.spaceBefore;

    if (line.rule === true) {
      parts.push(
        `0.85 0.85 0.85 RG 0.6 w ${String(MARGIN)} ${y.toFixed(2)} m ${String(MARGIN + CONTENT_WIDTH)} ${y.toFixed(2)} l S`,
      );
      y -= line.size * 1.45;
      continue;
    }

    if (line.text !== '') {
      const font = line.font === 'Helvetica-Bold' ? '/F2' : '/F1';
      parts.push(
        `BT ${font} ${String(line.size)} Tf 0.1 0.1 0.12 rg ` +
          `${String(MARGIN + line.indent)} ${y.toFixed(2)} Td (${escapeText(line.text)}) Tj ET`,
      );
    }
    y -= line.size * 1.45;
  }

  return parts.join('\n');
}

/**
 * Assembles the object graph and the cross-reference table.
 *
 * Byte offsets in the xref table must be exact or readers reject the file, so offsets are
 * measured on the encoded buffer rather than on the string — a multi-byte character would
 * otherwise make every subsequent offset wrong by a silent margin.
 */
function assemble(pages: readonly Line[][]): Buffer {
  const objects: string[] = [];
  const pageCount = pages.length;

  // 1 catalog, 2 pages tree, 3 + 4 fonts, then two objects per page.
  const firstPageObject = 5;
  const pageIds = pages.map((_, index) => firstPageObject + index * 2);

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Count ${String(pageCount)} /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] >>`,
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );

  pages.forEach((lines, index) => {
    const pageId = pageIds[index]!;
    const contentId = pageId + 1;
    const stream = contentStreamFor(lines);

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${String(contentId)} 0 R >>`,
    );
    objects.push(
      `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}\nendstream`,
    );
  });

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let position = 0;

  const header = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  chunks.push(header);
  position += header.byteLength;

  objects.forEach((body, index) => {
    const encoded = Buffer.from(`${String(index + 1)} 0 obj\n${body}\nendobj\n`, 'latin1');
    offsets.push(position);
    chunks.push(encoded);
    position += encoded.byteLength;
  });

  const xrefStart = position;
  let xref = `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`;

  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
