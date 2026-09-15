import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  auditEvents,
  clientOrganizations,
  documents,
  providerOffers,
  serviceCategories,
  users,
} from '@/db/schema';
import { createRequest } from '@/domain/requests/create';
import { acknowledgeOffer, dispatchNextOffer } from '@/services/offers';
import {
  generateDocument,
  loadDocumentPayload,
  loadDocumentsForRequest,
  type DocumentActor,
} from '@/services/documents';
import { resetStorageForTests } from '@/lib/storage';
import { PdfBuilder } from '@/lib/documents/pdf';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import { useMemoryMailTransportForTests } from '@/lib/mail';
import { setEnv } from '../../setup/env';
import { ensureMigrated, captureError, truncateAll } from '../../helpers/database';

/**
 * Operational documents against the real database and a real filesystem (CLAUDE.md §19).
 *
 * Two properties are worth the effort of testing here:
 *
 *  - **a work order contains one provider's work and nobody else's.** The PDF is a file that
 *    gets forwarded; a second company's schedule inside it is a disclosure that cannot be
 *    recalled. So the bytes themselves are searched, not just the row.
 *  - **the output is a real PDF.** A file that a reader refuses is indistinguishable from no
 *    document at the moment somebody needs it, so the structure is checked rather than
 *    assumed.
 */

let storageRoot: string;
let ADMIN: DocumentActor;
let fixture: { requestId: string; lineId: string };

const ARRIVAL = new Date('2026-09-18T07:00:00.000Z');
const NOW = new Date(ARRIVAL.getTime() - 12 * 3_600_000);

beforeAll(async () => {
  await ensureMigrated();
  storageRoot = await mkdtemp(join(tmpdir(), 'apron-docs-'));
  setEnv('DOCUMENT_STORAGE_PATH', storageRoot);
  setEnv('DOCUMENT_STORAGE_DRIVER', 'filesystem');
  resetStorageForTests();
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll();
  await runSeed();
  setAiAdapterForTests(undefined);
  useMemoryMailTransportForTests();

  const db = getDb();
  const [client] = await db
    .select({ id: clientOrganizations.id })
    .from(clientOrganizations)
    .where(eq(clientOrganizations.slug, 'meridian-capital-partners'));
  const [kteb] = await db.select({ id: airports.id }).from(airports).where(eq(airports.icao, 'KTEB'));
  const [ground] = await db
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(eq(serviceCategories.code, 'ground_transport'));
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'platform_admin'));

  if (client === undefined || kteb === undefined || ground === undefined || admin === undefined) {
    throw new Error('seeded fixture incomplete');
  }

  ADMIN = { userId: admin.id, role: 'platform_admin', label: 'test-admin' };

  const created = await createRequest({
    clientOrganizationId: client.id,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'Landing at Teterboro Friday at 7am, two cars.',
    airportId: kteb.id,
    fboId: null,
    aircraftId: null,
    arrivalUtc: ARRIVAL,
    departureUtc: null,
    passengerCount: 4,
    crewCount: 2,
    lines: [
      {
        serviceCategoryId: ground.id,
        quantity: 2,
        requirements: { vehicleClass: 'suv', passengers: 4 },
      },
    ],
  });

  fixture = { requestId: created.request.id, lineId: created.lineIds[0]! };
});

/** Extracts the text drawn in a PDF's content streams. */
function textOf(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const drawn: string[] = [];
  const pattern = /\((?:\\.|[^\\()])*\)\s*Tj/g;

  for (const match of raw.matchAll(pattern)) {
    drawn.push(
      match[0]
        .replace(/\)\s*Tj$/, '')
        .replace(/^\(/, '')
        .replace(/\\([\\()])/g, '$1'),
    );
  }
  return drawn.join('\n');
}

describe('the PDF writer produces a file a reader will accept', () => {
  it('writes a header, an xref table and a trailer', () => {
    const pdf = new PdfBuilder().heading('Apron').text('Hello').build();
    const raw = pdf.toString('latin1');

    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    expect(raw).toContain('xref');
    expect(raw).toContain('/Root 1 0 R');
    expect(raw.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('writes xref offsets that actually point at their objects', () => {
    const pdf = new PdfBuilder().heading('Apron').text('Some content').build();
    const raw = pdf.toString('latin1');

    // `lastIndexOf('xref')` finds the "xref" inside "startxref"; the table itself is the
    // one preceded by a newline.
    const xrefIndex = raw.lastIndexOf('\nxref\n');
    const entries = [...raw.slice(xrefIndex).matchAll(/^(\d{10}) 00000 n $/gm)];

    expect(entries.length).toBeGreaterThan(3);

    entries.forEach((entry, index) => {
      const offset = Number(entry[1]);
      // Object numbering starts at 1 and the free entry is not in this list.
      expect(raw.slice(offset)).toMatch(new RegExp(`^${String(index + 1)} 0 obj`));
    });
  });

  it('escapes parentheses and backslashes rather than corrupting the file', () => {
    const pdf = new PdfBuilder().text('A (tricky) value with a \\ backslash').build();
    expect(textOf(pdf)).toContain('A (tricky) value with a \\ backslash');
  });

  it('paginates long content instead of drawing off the bottom of the page', () => {
    const builder = new PdfBuilder();
    for (let index = 0; index < 400; index += 1) builder.text(`Line ${String(index)}`);
    const raw = builder.build().toString('latin1');

    const pageCount = [...raw.matchAll(/\/Type \/Page[^s]/g)].length;
    expect(pageCount).toBeGreaterThan(1);
    expect(raw).toMatch(/\/Type \/Pages \/Count [2-9]/);
  });

  it('transliterates characters outside Latin-1 rather than emitting raw bytes', () => {
    const pdf = new PdfBuilder().text('Teterboro — 2 × SUV · “premium” … 日本').build();
    const raw = pdf.toString('latin1');
    const text = textOf(pdf);

    // Nothing above 0xFF survived into the file — that is what would corrupt it.
    expect([...raw].every((character) => character.charCodeAt(0) <= 0xff)).toBe(true);

    // Characters WinAnsi actually has are kept as they are, not mangled.
    expect(text).toContain('×');
    expect(text).toContain('·');

    // Characters it does not have are replaced with a sensible Latin-1 stand-in.
    expect(text).toContain('Teterboro - 2');
    expect(text).toContain('"premium"');
    expect(text).toContain('...');
    // And anything with no stand-in at all becomes a question mark rather than a bad byte.
    expect(text).toContain('??');
  });
});

describe('generating a client confirmation', () => {
  it('contains the real reference, airport and service, read from the record', async () => {
    const created = await generateDocument(
      { requestId: fixture.requestId, kind: 'client_confirmation' },
      ADMIN,
    );

    const payload = await loadDocumentPayload(created.id);
    expect(payload).not.toBeNull();

    const text = textOf(payload!.body);
    expect(text).toContain('KTEB');
    expect(text).toMatch(/Ground transport/i);
    // The quantity and the category's own unit label, as the catalogue defines them —
    // not a word this test invented.
    const [service] = await getDb()
      .select({ unitLabel: serviceCategories.unitLabel })
      .from(serviceCategories)
      .where(eq(serviceCategories.code, 'ground_transport'));
    expect(text).toContain(`2 ${service!.unitLabel}s`);

    const [request] = await getDb()
      .select({ reference: sql<string>`reference` })
      .from(sql`requests`)
      .where(sql`id = ${fixture.requestId}::uuid`);
    expect(text).toContain(request!.reference);
  });

  it('says plainly when a service is not yet arranged', async () => {
    const created = await generateDocument(
      { requestId: fixture.requestId, kind: 'client_confirmation' },
      ADMIN,
    );

    const payload = await loadDocumentPayload(created.id);
    expect(textOf(payload!.body)).toMatch(/Being arranged/i);
  });

  it('records the byte size and a checksum of what was actually written', async () => {
    const created = await generateDocument(
      { requestId: fixture.requestId, kind: 'client_confirmation' },
      ADMIN,
    );

    const [row] = await getDb()
      .select({ byteSize: documents.byteSize, checksum: documents.checksumSha256 })
      .from(documents)
      .where(eq(documents.id, created.id));

    const payload = await loadDocumentPayload(created.id);

    expect(row?.byteSize).toBe(payload!.body.byteLength);
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);

    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(payload!.body).digest('hex')).toBe(row?.checksum);
  });

  it('audits who generated it', async () => {
    const created = await generateDocument(
      { requestId: fixture.requestId, kind: 'client_confirmation' },
      ADMIN,
    );

    const events = await getDb()
      .select({ action: auditEvents.action, actorRole: auditEvents.actorRole })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, created.id));

    expect(events.some((event) => event.action === 'document.generate')).toBe(true);
    expect(events[0]?.actorRole).toBe('platform_admin');
  });
});

describe('a work order contains one provider’s work and nobody else’s', () => {
  it('refuses to generate without naming the provider', async () => {
    const error = await captureError(() =>
      generateDocument({ requestId: fixture.requestId, kind: 'provider_work_order' }, ADMIN),
    );
    expect(error.message).toMatch(/needs the provider/i);
  });

  it('names only the chosen provider’s services', async () => {
    await dispatchNextOffer(fixture.lineId, { evaluationNow: NOW });

    const [offer] = await getDb()
      .select({ id: providerOffers.id, providerCompanyId: providerOffers.providerCompanyId })
      .from(providerOffers)
      .limit(1);

    await acknowledgeOffer({
      offerId: offer!.id,
      providerCompanyId: offer!.providerCompanyId,
      actorUserId: ADMIN.userId,
      actorRole: 'provider_dispatcher',
      actorLabel: 'test-dispatcher',
      now: NOW,
    });

    const created = await generateDocument(
      {
        requestId: fixture.requestId,
        kind: 'provider_work_order',
        providerCompanyId: offer!.providerCompanyId,
      },
      ADMIN,
    );

    const payload = await loadDocumentPayload(created.id);
    const text = textOf(payload!.body);

    // Every other approved company's name must be absent from the bytes.
    const others = await getDb().execute<{ display_name: string }>(sql`
      select display_name from provider_companies
      where id <> ${offer!.providerCompanyId}::uuid
    `);

    for (const other of others.rows) {
      expect(text).not.toContain(other.display_name);
    }

    expect(text).toMatch(/Ground transport/i);
  });

  it('does not contain passenger contact details', async () => {
    await dispatchNextOffer(fixture.lineId, { evaluationNow: NOW });
    const [offer] = await getDb()
      .select({ providerCompanyId: providerOffers.providerCompanyId })
      .from(providerOffers)
      .limit(1);

    const created = await generateDocument(
      {
        requestId: fixture.requestId,
        kind: 'provider_work_order',
        providerCompanyId: offer!.providerCompanyId,
      },
      ADMIN,
    );

    const text = textOf((await loadDocumentPayload(created.id))!.body);

    expect(text).toMatch(/not included in this document/i);
    expect(text).not.toMatch(/\+\d[\d ]{8,}/);
    expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it('is tagged with the provider, so a provider query returns only their own', async () => {
    await dispatchNextOffer(fixture.lineId, { evaluationNow: NOW });
    const [offer] = await getDb()
      .select({ providerCompanyId: providerOffers.providerCompanyId })
      .from(providerOffers)
      .limit(1);

    await generateDocument(
      {
        requestId: fixture.requestId,
        kind: 'provider_work_order',
        providerCompanyId: offer!.providerCompanyId,
      },
      ADMIN,
    );
    await generateDocument({ requestId: fixture.requestId, kind: 'handling_summary' }, ADMIN);

    const everything = await loadDocumentsForRequest(fixture.requestId);
    expect(everything).toHaveLength(2);

    // The same request, asked as that provider.
    const theirs = await loadDocumentsForRequest(fixture.requestId, {
      providerCompanyId: offer!.providerCompanyId,
    });
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.kind).toBe('provider_work_order');
  });
});

describe('documents are immutable', () => {
  it('generating again produces a second document, not a replacement', async () => {
    const first = await generateDocument(
      { requestId: fixture.requestId, kind: 'client_confirmation' },
      ADMIN,
    );
    const second = await generateDocument(
      { requestId: fixture.requestId, kind: 'client_confirmation' },
      ADMIN,
    );

    expect(second.id).not.toBe(first.id);

    // And the first is still readable, byte for byte.
    const firstPayload = await loadDocumentPayload(first.id);
    const secondPayload = await loadDocumentPayload(second.id);

    expect(firstPayload).not.toBeNull();
    expect(secondPayload).not.toBeNull();

    const rows = await getDb()
      .select({ key: documents.storageKey })
      .from(documents)
      .where(eq(documents.requestId, fixture.requestId));

    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it('refuses a document kind the platform does not generate', async () => {
    const error = await captureError(() =>
      generateDocument({ requestId: fixture.requestId, kind: 'upload' }, ADMIN),
    );
    expect(error.message).toMatch(/not a generated document/i);
  });

  it('refuses a request that does not exist', async () => {
    const error = await captureError(() =>
      generateDocument(
        { requestId: '00000000-0000-0000-0000-000000000000', kind: 'handling_summary' },
        ADMIN,
      ),
    );
    expect(error.message).toMatch(/does not exist/i);
  });
});

describe('storage keys cannot be used to reach outside the store', () => {
  it('refuses a traversal key', async () => {
    const { getStorage } = await import('@/lib/storage');
    const error = await captureError(() =>
      getStorage().get('documents/../../../../etc/passwd'),
    );
    expect(error.message).toMatch(/not a valid storage key/i);
  });

  it('refuses an absolute path', async () => {
    const { getStorage } = await import('@/lib/storage');
    const error = await captureError(() => getStorage().get('/etc/passwd'));
    expect(error.message).toMatch(/not a valid storage key/i);
  });
});
