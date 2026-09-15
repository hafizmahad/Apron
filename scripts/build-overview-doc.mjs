import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

/**
 * Builds the platform overview as a real .docx.
 *
 * Same reasoning as the account sheet: a document produced once and sent by email does not
 * justify adding a document library to the application's dependencies. A .docx is a zip of
 * XML parts, so it is written directly.
 *
 * Black and white only — no colour, no theme, no logo. It is meant to be read on a screen,
 * printed, and forwarded, and it should look the same in all three.
 *
 *   node scripts/build-overview-doc.mjs --out "handover/Apron - Platform Overview.docx"
 */

const args = process.argv.slice(2);
const outPath = args.includes('--out') ? (args[args.indexOf('--out') + 1] ?? '') : 'Apron-Overview.docx';

// ---------------------------------------------------------------------------
// The document, as content rather than markup.
// ---------------------------------------------------------------------------

/** @typedef {{k:'h1'|'h2'|'h3'|'p'|'bullet'|'number'|'quote'|'table'|'spacer', text?:string, rows?:string[][], head?:boolean}} Block */

/** @type {Block[]} */
const DOC = [
  { k: 'h1', text: 'Apron' },
  { k: 'p', text: 'Ground-services coordination for private aviation' },
  { k: 'spacer' },

  { k: 'p', text: 'Apron takes a request written in one ordinary sentence and turns it into confirmed ground services at an airport — cars, close protection, hotels, catering, fuel and hangarage — by finding the suppliers who can genuinely cover the work and holding each of them to a deadline.' },
  { k: 'p', text: 'The platform decides nothing important by guesswork. Which suppliers are eligible, whether a vehicle is free, whether a driver is on shift, whether an aircraft fits a hangar — all of that is settled by rules and by the database. The language model reads the sentence and helps choose between options that code has already proved are valid. It never invents a fact and never writes to the database.' },

  { k: 'h2', text: 'The four portals' },
  { k: 'p', text: 'Four separate experiences, each showing only what that person is entitled to see. Access is enforced on the server for every action, not by hiding links.' },
  {
    k: 'table',
    head: true,
    rows: [
      ['Portal', 'Who uses it', 'What they do'],
      ['Client', 'The client booking the trip', 'Describes the trip in one sentence, answers anything the platform needs, confirms, and follows progress. Never sees supplier pricing, ranking or internal workings.'],
      ['Operations', 'The internal dispatch team', 'Runs the whole lifecycle. Sees every request, the timeline, the map, the suppliers approached and why, and can intervene — each override recorded with a written reason.'],
      ['Provider', 'Each supplier company', 'Sees only work offered to that company. Accepts or declines, then assigns the actual vehicle, driver or officer. Cannot see any other company.'],
      ['Admin', 'Platform governance', 'Approves suppliers, edits the service catalogue and airport registry, manages users and settings, and reads the complete audit trail.'],
    ],
  },

  { k: 'h2', text: 'How a request travels' },
  { k: 'p', text: 'One flow, from a sentence to suppliers holding the work.' },

  { k: 'h3', text: '1. The client writes a sentence' },
  { k: 'quote', text: '"Arriving Opa Locka Saturday 8pm, 5 passengers, two SUVs and breakfast catering, hotel for 3."' },
  { k: 'p', text: 'No form, no service codes, no dropdowns.' },

  { k: 'h3', text: '2. The platform reads it back' },
  { k: 'p', text: 'The sentence is turned into structured detail: the airport, the local arrival time, the services and the quantities. The original wording is kept exactly as written and is never rewritten.' },
  { k: 'p', text: 'Anything genuinely ambiguous is asked, never assumed. "Miami" matching two airfields becomes a choice between the two real airfields. A time that does not exist because the clocks went forward is raised rather than quietly moved.' },

  { k: 'h3', text: '3. Anything still missing is asked for' },
  { k: 'p', text: 'Each service declares what it cannot go without. Ground transport needs a vehicle class and a passenger count; catering needs a number of covers; a hotel needs rooms and nights. Whatever is missing is asked as a short question with the right control — a choice, a number, yes or no.' },
  { k: 'p', text: 'A request cannot be confirmed while something required is still missing. This is enforced on the server, not by disabling a button.' },
  { k: 'p', text: 'These requirements are configuration, not code. A new service added by an administrator is asked about correctly the same day, without any development work.' },

  { k: 'h3', text: '4. Suppliers are found' },
  { k: 'p', text: 'For every service, the platform works out which suppliers can genuinely cover it — approved, covering that airport, open at that hour, enough notice, enough spare capacity, and with the right kind of resource actually free. Anything that fails is recorded with the reason.' },
  { k: 'p', text: 'Only then is the model asked to choose between suppliers that already passed. Its choice is checked against the same rules before it is used, and if the check fails the platform falls back to its own ranking and records that it did.' },

  { k: 'h3', text: '5. Each supplier answers, on a clock' },
  { k: 'p', text: 'An offer goes to one supplier per service with a deadline. Accepting commits the company; declining sends the request on to the next eligible supplier with the reason attached. A deadline that passes without an answer expires the offer and re-matches automatically.' },
  { k: 'p', text: 'Each service moves independently. One supplier declining a hotel does not disturb the cars.' },

  { k: 'h3', text: '6. Real resources are committed' },
  { k: 'p', text: 'Accepting is not the end. The supplier assigns the actual vehicle and named driver, or the specific officer. The database physically prevents the same vehicle or person being committed to two overlapping jobs — not a warning, a refusal.' },

  { k: 'h3', text: '7. Operations watches the whole thing' },
  { k: 'p', text: 'Every request shows its timeline, the suppliers approached and why each was chosen or rejected, the resources committed, the messages and the documents. Operations can intervene at any point, and every intervention is recorded with who did it and why.' },

  { k: 'h2', text: 'What the platform will not do' },
  { k: 'p', text: 'These are deliberate limits, and they are the reason the system can be trusted with real work.' },
  { k: 'bullet', text: 'It will not invent a fact. A detail that was not stated is asked for, never filled in.' },
  { k: 'bullet', text: 'It will not let the model decide anything consequential. Availability, capacity, eligibility and every state change are settled by code and by the database.' },
  { k: 'bullet', text: 'It will not double-book. Overlapping commitments to the same vehicle, driver or officer are refused by the database itself.' },
  { k: 'bullet', text: 'It will not show one supplier another supplier’s work, prices, staff or messages.' },
  { k: 'bullet', text: 'It will not change anything important without recording who did it and why.' },
  { k: 'bullet', text: 'It will not stop working when the language model is unavailable. Requests can still be entered and suppliers are still found, by the platform’s own ranking.' },

  { k: 'h2', text: 'Signing in' },
  { k: 'p', text: 'Accounts covering every role are listed in the accompanying spreadsheet, with the portal each one opens and what it can do. They all use the same password, supplied separately.' },
  { k: 'p', text: 'Each account opens directly into its own portal. Reaching for another portal’s address is refused, not merely hidden.' },

  { k: 'h2', text: 'The state of the build' },
  {
    k: 'table',
    head: true,
    rows: [
      ['Area', 'State'],
      ['Client, Operations, Provider and Admin portals', 'Complete and working against the real database'],
      ['Request intake, clarification and confirmation', 'Complete'],
      ['Supplier matching, offers, deadlines and re-matching', 'Complete'],
      ['Resource assignment with double-booking prevention', 'Complete'],
      ['Messaging, notifications and documents', 'Complete'],
      ['Governance, audit trail and platform settings', 'Complete'],
      ['Local production rehearsal', 'Complete'],
      ['Cloud deployment', 'Next'],
    ],
  },
  { k: 'p', text: 'The platform runs today as a complete stack — application, background worker, database, cache — and has been verified end to end in that form. Automated checks cover the rules, the database guarantees, the access controls and the model’s behaviour, and are run in full before any change is accepted.' },
];

// ---------------------------------------------------------------------------
// DOCX generation
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function run(text, bold) {
  return `<w:r>${bold === true ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(style, text, bold) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${text === '' ? '' : run(text, bold)}</w:p>`;
}

function tableCell(text, bold, width) {
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${String(width)}" w:type="dxa"/>` +
    '<w:tcMar><w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/>' +
    '<w:left w:w="110" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tcMar></w:tcPr>' +
    `<w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>${run(text, bold)}</w:p></w:tc>`
  );
}

function table(rows, hasHead) {
  const columnCount = rows[0]?.length ?? 1;
  // 9360 twips is the printable width of a portrait page with 1-inch margins.
  const widths = columnCount === 3 ? [1700, 2300, 5360] : columnCount === 2 ? [4200, 5160] : Array(columnCount).fill(Math.floor(9360 / columnCount));

  const grid = widths.map((w) => `<w:gridCol w:w="${String(w)}"/>`).join('');

  const body = rows
    .map((cells, index) => {
      const bold = hasHead === true && index === 0;
      const header = bold ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      return `<w:tr>${header}${cells.map((text, column) => tableCell(text, bold, widths[column] ?? 3000)).join('')}</w:tr>`;
    })
    .join('');

  return (
    '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/>' +
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`)
      .join('') +
    '</w:tblBorders></w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl><w:p><w:pPr><w:pStyle w:val="Gap"/></w:pPr></w:p>`
  );
}

const body = DOC.map((block) => {
  switch (block.k) {
    case 'h1':
      return para('Title', block.text ?? '');
    case 'h2':
      return para('Heading1', block.text ?? '');
    case 'h3':
      return para('Heading2', block.text ?? '');
    case 'quote':
      return para('Quote', block.text ?? '');
    case 'bullet':
      return `<w:p><w:pPr><w:pStyle w:val="Body"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(block.text ?? '')}</w:p>`;
    case 'table':
      return table(block.rows ?? [], block.head);
    case 'spacer':
      return para('Gap', '');
    case 'p':
    default:
      return para('Body', block.text ?? '');
  }
}).join('');

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;

/** Every colour here is black. The document is meant to print and photocopy cleanly. */
function style(id, name, size, bold, spaceBefore, spaceAfter, extra) {
  return (
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
    `<w:pPr><w:spacing w:before="${String(spaceBefore)}" w:after="${String(spaceAfter)}" w:line="276" w:lineRule="auto"/>${extra ?? ''}</w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="${String(size)}"/>${bold ? '<w:b/>' : ''}<w:color w:val="000000"/></w:rPr></w:style>`
  );
}

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:color w:val="000000"/></w:rPr></w:rPrDefault></w:docDefaults>
${style('Title', 'Title', 44, true, 0, 60)}
${style('Heading1', 'heading 1', 30, true, 360, 140)}
${style('Heading2', 'heading 2', 24, true, 260, 100)}
${style('Body', 'Body Text', 22, false, 0, 140)}
${style('TableText', 'Table Text', 20, false, 0, 0)}
${style('Gap', 'Gap', 16, false, 0, 0)}
${style('Quote', 'Quote', 22, false, 60, 160, '<w:ind w:left="480"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="12" w:color="000000"/></w:pBdr>')}
</w:styles>`;

const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>
<w:lvlText w:val="•"/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="454" w:hanging="284"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

// --- zip (forward slashes, as the format requires) --------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = (c >>> 8) ^ (CRC_TABLE[(c ^ byte) & 0xff] ?? 0);
  return (c ^ -1) >>> 0;
}

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

writeFileSync(
  outPath,
  zip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['word/document.xml', documentXml],
    ['word/_rels/document.xml.rels', documentRels],
    ['word/styles.xml', stylesXml],
    ['word/numbering.xml', numberingXml],
  ]),
);

console.log(`${outPath} — ${String(DOC.length)} blocks, black and white throughout`);
