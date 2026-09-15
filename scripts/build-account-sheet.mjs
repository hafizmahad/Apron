import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

/**
 * Builds the sign-in account sheet as a real .xlsx.
 *
 * An .xlsx is a zip of XML parts, so it is written directly rather than by adding a
 * spreadsheet library to the application's dependencies for a document that is produced once
 * and sent by email.
 *
 * Deliberately plain: no fill colours, no theme, no conditional formatting. Bold headers and
 * a frozen top row are the only formatting, because the sheet is meant to be printed, read
 * in black and white, and forwarded.
 *
 * The password column is left EMPTY on purpose. One password covers every account and the
 * recipient fills it in themselves — it is not written into a file that travels by email.
 *
 *   node scripts/build-account-sheet.mjs                      # reads the running database
 *   node scripts/build-account-sheet.mjs --out ./Accounts.xlsx
 */

const args = process.argv.slice(2);
const outPath = args.includes('--out') ? (args[args.indexOf('--out') + 1] ?? '') : 'Apron-Sign-In-Accounts.xlsx';

const PORTAL_BY_ROLE = {
  platform_admin: 'Admin console',
  operations_manager: 'Operations portal',
  operations_agent: 'Operations portal',
  provider_admin: 'Provider portal',
  provider_dispatcher: 'Provider portal',
  provider_staff: 'Provider portal',
  client: 'Client portal',
};

const ROLE_LABEL = {
  platform_admin: 'Platform administrator',
  operations_manager: 'Operations manager',
  operations_agent: 'Operations agent',
  provider_admin: 'Provider administrator',
  provider_dispatcher: 'Dispatcher',
  provider_staff: 'Staff',
  client: 'Client',
};

const PATH_BY_ROLE = {
  platform_admin: '/admin',
  operations_manager: '/ops',
  operations_agent: '/ops',
  provider_admin: '/provider',
  provider_dispatcher: '/provider',
  provider_staff: '/provider',
  client: '/client',
};

const WHAT_THEY_SEE = {
  platform_admin: 'Everything. Approves providers, edits the service catalogue and the airport registry, manages users and settings, reads the audit trail.',
  operations_manager: 'Every request end to end. Can override a chosen provider, force a status and release passenger contacts, each with a written reason.',
  operations_agent: 'Every request end to end, without the governance overrides.',
  provider_admin: 'Their own company only. Accepts or declines work, assigns vehicles, drivers and officers, and manages the company profile, coverage and staff.',
  provider_dispatcher: 'Their own company only. Accepts or declines work and assigns resources.',
  provider_staff: 'Their own company only, read access to the work assigned to them.',
  client: 'Their own requests only. Describes a trip in one sentence and follows its progress.',
};

// --- read the accounts from the running database ---------------------------
const SQL = `
select u.role, u.email, u.full_name,
       coalesce(pc.display_name, co.name, 'Apron platform') as organisation
from users u
left join provider_companies pc on pc.id = u.provider_company_id
left join client_organizations co on co.id = u.client_organization_id
order by case u.role
  when 'platform_admin' then 1 when 'operations_manager' then 2 when 'operations_agent' then 3
  when 'provider_admin' then 4 when 'provider_dispatcher' then 5 when 'provider_staff' then 6
  else 7 end, organisation, u.email`;

const raw = execFileSync(
  'docker',
  ['exec', 'apron-production-postgres-1', 'psql', '-U', 'apron', '-d', 'apron', '-t', '-A', '-F', '|', '-c', SQL],
  { encoding: 'utf8' },
);

const rows = raw
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && line.includes('|'))
  .map((line) => {
    const [role = '', email = '', fullName = '', organisation = ''] = line.split('|');
    return { role, email, fullName, organisation };
  });

if (rows.length === 0) throw new Error('No accounts found. Is the database running?');

// --- the sheet -------------------------------------------------------------
const HEADERS = [
  'Portal',
  'Role',
  'Name',
  'Organisation',
  'Sign-in email',
  'Password',
  'Opens at',
  'What this account can do',
];

const WIDTHS = [18, 24, 22, 30, 42, 16, 12, 88];

const table = rows.map((row) => [
  PORTAL_BY_ROLE[row.role] ?? row.role,
  ROLE_LABEL[row.role] ?? row.role,
  row.fullName,
  row.organisation,
  row.email,
  '', // filled in by the sender — never written into a file that travels by email
  PATH_BY_ROLE[row.role] ?? '/',
  WHAT_THEY_SEE[row.role] ?? '',
]);

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnName(index) {
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode((n % 26) + 65) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

function cell(rowNumber, columnIndex, value, styleIndex) {
  const reference = `${columnName(columnIndex)}${String(rowNumber)}`;
  const style = styleIndex === undefined ? '' : ` s="${String(styleIndex)}"`;
  if (value === '') return `<c r="${reference}"${style}/>`;
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

const headerRow = `<row r="1" ht="22" customHeight="1">${HEADERS.map((value, index) => cell(1, index, value, 1)).join('')}</row>`;
const bodyRows = table
  .map((values, rowIndex) => {
    const rowNumber = rowIndex + 2;
    return `<row r="${String(rowNumber)}">${values.map((value, columnIndex) => cell(rowNumber, columnIndex, value, 2)).join('')}</row>`;
  })
  .join('');

const columns = WIDTHS.map(
  (width, index) => `<col min="${String(index + 1)}" max="${String(index + 1)}" width="${String(width)}" customWidth="1"/>`,
).join('');

const lastColumn = columnName(HEADERS.length - 1);
const lastRow = table.length + 1;

const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
<dimension ref="A1:${lastColumn}${String(lastRow)}"/>
<sheetViews><sheetView workbookViewId="0" showGridLines="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${columns}</cols>
<sheetData>${headerRow}${bodyRows}</sheetData>
<autoFilter ref="A1:${lastColumn}${String(lastRow)}"/>
</worksheet>`;

// Black and white throughout: bold for the header, a thin border, wrapped text. No fills.
const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
</styleSheet>`;

const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sign-in accounts" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

// --- assemble ---------------------------------------------------------------
//
// The zip is written here rather than shelled out to `Compress-Archive`, which stores entry
// names with BACKSLASHES on Windows. OOXML requires forward slashes, and Excel refuses a
// package whose parts it cannot find — a file that looks fine until someone tries to open it.

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
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(8, 8);         // deflate
    local.writeUInt16LE(0, 10);        // time
    local.writeUInt16LE(0x21, 12);     // date (1996-01-01, fixed for reproducibility)
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
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
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

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = (c >>> 8) ^ (CRC_TABLE[(c ^ byte) & 0xff] ?? 0);
  return (c ^ -1) >>> 0;
}

// Order matters to some readers: the content types part comes first.
const archive = zip([
  ['[Content_Types].xml', contentTypes],
  ['_rels/.rels', rootRels],
  ['xl/workbook.xml', workbookXml],
  ['xl/_rels/workbook.xml.rels', workbookRels],
  ['xl/styles.xml', stylesXml],
  ['xl/worksheets/sheet1.xml', sheetXml],
]);

writeFileSync(outPath, archive);

console.log(`${outPath} — ${String(table.length)} accounts across ${String(new Set(table.map((r) => r[0])).size)} portals`);
console.log('The password column is intentionally empty; fill it in before sending.');
