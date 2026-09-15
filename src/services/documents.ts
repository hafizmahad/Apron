import '@/lib/server-guard';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type Executor } from '@/db/client';
import { documents } from '@/db/schema';
import type { DocumentKind } from '@/db/schema/enums';
import { loadRequestDetail, type RequestDetail } from '@/db/queries/operations';
import { recordAuditEvent } from '@/domain/audit';
import { PdfBuilder } from '@/lib/documents/pdf';
import { buildStorageKey, getStorage } from '@/lib/storage';
import { ApronError } from '@/lib/errors';
import { logger } from '@/lib/logging';
import { formatOperational } from '@/lib/time';
import type { UserRole } from '@/db/schema/enums';

/**
 * Operational documents (CLAUDE.md §19).
 *
 * The rule that matters: **every factual field comes from structured data.** These
 * generators read the request record and render it. No model writes a tail number, a time
 * or a provider name, because a document is the thing a client and a handler act on, and a
 * plausible-looking invented detail in one is worse than no document at all.
 *
 * Three kinds are generated:
 *
 *  - `client_confirmation` — what the client is getting, in their words not ours;
 *  - `provider_work_order` — one provider's own instructions, and only their own;
 *  - `handling_summary`    — the internal operational picture, every service and provider.
 *
 * Documents are immutable. Regenerating produces a NEW row with a new storage key, because
 * the copy sent to a client last week must still be retrievable exactly as it was sent.
 */

export interface DocumentActor {
  readonly userId: string;
  readonly role: UserRole;
  readonly label: string;
}

export interface GeneratedDocument {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly title: string;
  readonly byteSize: number;
}

const GENERATABLE: ReadonlySet<DocumentKind> = new Set<DocumentKind>([
  'client_confirmation',
  'provider_work_order',
  'handling_summary',
]);

export async function generateDocument(
  input: {
    readonly requestId: string;
    readonly kind: DocumentKind;
    /** Required for a work order: a provider's document contains only their own work. */
    readonly providerCompanyId?: string | null;
  },
  actor: DocumentActor,
): Promise<GeneratedDocument> {
  if (!GENERATABLE.has(input.kind)) {
    throw new ApronError('validation_failed', `${input.kind} is not a generated document`);
  }

  const detail = await loadRequestDetail(input.requestId);
  if (detail === null) throw new ApronError('not_found', 'That request does not exist');

  const providerCompanyId = input.providerCompanyId ?? null;

  if (input.kind === 'provider_work_order' && providerCompanyId === null) {
    throw new ApronError('validation_failed', 'A work order needs the provider it is for');
  }

  const rendered =
    input.kind === 'client_confirmation'
      ? renderClientConfirmation(detail)
      : input.kind === 'provider_work_order'
        ? renderWorkOrder(detail, providerCompanyId!)
        : renderHandlingSummary(detail);

  const storageKey = buildStorageKey(detail.id, input.kind, 'application/pdf');
  const stored = await getStorage().put(storageKey, rendered.body, 'application/pdf');

  const db = getDb();
  const [created] = await db
    .insert(documents)
    .values({
      requestId: detail.id,
      requestServiceLineId: null,
      providerCompanyId,
      kind: input.kind,
      title: rendered.title,
      storageDriver: getStorage().name,
      storageKey: stored.storageKey,
      contentType: 'application/pdf',
      byteSize: stored.byteSize,
      checksumSha256: stored.checksumSha256,
      generatedByUserId: actor.userId,
    })
    .returning({ id: documents.id });

  if (created === undefined) {
    // The bytes are already written; without a row nothing can ever find them again.
    await getStorage().remove(stored.storageKey);
    throw new ApronError('internal', 'The document could not be recorded');
  }

  await recordAuditEvent({
    action: 'document.generate',
    entityType: 'document',
    entityId: created.id,
    actorUserId: actor.userId,
    actorRole: actor.role,
    actorLabel: actor.label,
    afterState: {
      kind: input.kind,
      requestId: detail.id,
      providerCompanyId,
      byteSize: stored.byteSize,
      checksum: stored.checksumSha256,
    },
  });

  logger().info(
    { documentId: created.id, kind: input.kind, requestId: detail.id, bytes: stored.byteSize },
    'document generated',
  );

  return {
    id: created.id,
    kind: input.kind,
    title: rendered.title,
    byteSize: stored.byteSize,
  };
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

export interface DocumentRow {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly title: string;
  readonly byteSize: number;
  readonly contentType: string;
  readonly providerCompanyId: string | null;
  readonly createdAt: Date;
}

export async function loadDocumentsForRequest(
  requestId: string,
  options: { readonly providerCompanyId?: string } = {},
  executor: Executor = getDb(),
): Promise<readonly DocumentRow[]> {
  const filters = [eq(documents.requestId, requestId)];

  // A provider sees only documents addressed to them. Not a UI choice — the query.
  if (options.providerCompanyId !== undefined) {
    filters.push(eq(documents.providerCompanyId, options.providerCompanyId));
  }

  return executor
    .select({
      id: documents.id,
      kind: documents.kind,
      title: documents.title,
      byteSize: documents.byteSize,
      contentType: documents.contentType,
      providerCompanyId: documents.providerCompanyId,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(and(...filters))
    .orderBy(desc(documents.createdAt), desc(documents.id));
}

export interface DocumentPayload {
  readonly kind: DocumentKind;
  readonly title: string;
  readonly contentType: string;
  readonly body: Buffer;
  readonly requestId: string | null;
  readonly providerCompanyId: string | null;
  readonly clientOrganizationId: string | null;
}

/**
 * Fetches a document's bytes along with everything the caller needs to authorise it.
 *
 * The tenancy fields come back with the payload rather than being checked here, so the
 * route makes one authorisation decision in one place with the full picture — including
 * the client organisation, which lives on the request, not on the document.
 */
export async function loadDocumentPayload(documentId: string): Promise<DocumentPayload | null> {
  const result = await getDb().execute<{
    kind: DocumentKind;
    title: string;
    content_type: string;
    storage_key: string;
    request_id: string | null;
    provider_company_id: string | null;
    client_organization_id: string | null;
  }>(sql`
    select d.kind, d.title, d.content_type, d.storage_key, d.request_id, d.provider_company_id,
           r.client_organization_id
    from documents d
    left join requests r on r.id = d.request_id
    where d.id = ${documentId}::uuid
  `);

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    kind: row.kind,
    title: row.title,
    contentType: row.content_type,
    body: await getStorage().get(row.storage_key),
    requestId: row.request_id,
    providerCompanyId: row.provider_company_id,
    clientOrganizationId: row.client_organization_id,
  };
}

// ---------------------------------------------------------------------------
// renderers — every value below is read from the request record
// ---------------------------------------------------------------------------

interface Rendered {
  readonly title: string;
  readonly body: Buffer;
}

function localTime(instant: Date | null, timezone: string): string {
  return instant === null ? 'not set' : `${formatOperational(instant, timezone)} local`;
}

function header(pdf: PdfBuilder, detail: RequestDetail, title: string): void {
  pdf.heading('Apron');
  pdf.text(title, { bold: true });
  pdf.rule();
  pdf.gap();
  pdf.row('Reference', detail.reference);
  pdf.row('Client', detail.clientName);
  pdf.row('Airport', detail.airportLabel);
  if (detail.fboName !== null) pdf.row('Handler', detail.fboName);
  pdf.row('Arrival', localTime(detail.arrivalUtc, detail.airportTimezone));
  if (detail.departureUtc !== null) {
    pdf.row('Departure', localTime(detail.departureUtc, detail.airportTimezone));
  }
  if (detail.aircraftLabel !== null) pdf.row('Aircraft', detail.aircraftLabel);
  pdf.row('Passengers', `${String(detail.passengerCount)} passengers, ${String(detail.crewCount)} crew`);
  pdf.row('Status', detail.status.replace(/_/g, ' '));
}

function footer(pdf: PdfBuilder): void {
  pdf.gap();
  pdf.rule();
  pdf.text(
    `Generated by Apron on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. ` +
      'Every value above is read from the platform record at the moment of generation.',
  );
}

function renderClientConfirmation(detail: RequestDetail): Rendered {
  const pdf = new PdfBuilder();
  header(pdf, detail, 'Service confirmation');

  pdf.subheading('Your services');
  pdf.gap();

  if (detail.lines.length === 0) {
    pdf.text('No services are attached to this request.');
  }

  for (const line of detail.lines) {
    pdf.text(
      `${String(line.quantity)} ${line.unitLabel}${line.quantity === 1 ? '' : 's'} - ${line.serviceName}`,
      { bold: true },
    );
    pdf.text(
      line.serviceStartUtc === null
        ? 'Timing to be confirmed.'
        : `${localTime(line.serviceStartUtc, detail.airportTimezone)} to ${localTime(line.serviceEndUtc, detail.airportTimezone)}`,
      { indent: 12 },
    );

    // The client is told the state in plain words, including when it is not yet arranged.
    // A confirmation that implies everything is settled when it is not is a lie a document
    // makes permanent.
    pdf.text(describeLineForClient(line.status, line.currentProviderName), { indent: 12 });
    pdf.gap();
  }

  if (detail.operationalNotes !== '') {
    pdf.subheading('Notes');
    pdf.text(detail.operationalNotes);
  }

  footer(pdf);
  return { title: `Service confirmation - ${detail.reference}`, body: pdf.build() };
}

function describeLineForClient(status: string, providerName: string | null): string {
  switch (status) {
    case 'assigned':
    case 'in_progress':
      return `Confirmed${providerName === null ? '' : ` with ${providerName}`}.`;
    case 'completed':
      return 'Completed.';
    case 'acknowledged':
      return `Accepted${providerName === null ? '' : ` by ${providerName}`}; resources being allocated.`;
    case 'cancelled':
      return 'Cancelled.';
    case 'failed':
      return 'Not yet arranged - our operations team is working on it.';
    default:
      return 'Being arranged.';
  }
}

function renderWorkOrder(detail: RequestDetail, providerCompanyId: string): Rendered {
  // A provider's document contains a provider's work. Filtering here rather than at the
  // call site means no caller can produce a work order that leaks another company's lines.
  const own = detail.lines.filter((line) => line.currentProviderId === providerCompanyId);
  const providerName = own[0]?.currentProviderName ?? 'Provider';

  const pdf = new PdfBuilder();
  header(pdf, detail, `Work order - ${providerName}`);

  pdf.subheading('Your services on this request');
  pdf.gap();

  if (own.length === 0) {
    pdf.text('No services on this request are currently assigned to you.');
  }

  for (const line of own) {
    pdf.text(
      `${String(line.quantity)} ${line.unitLabel}${line.quantity === 1 ? '' : 's'} - ${line.serviceName}`,
      { bold: true },
    );
    pdf.text(
      `Window: ${localTime(line.serviceStartUtc, detail.airportTimezone)} to ${localTime(line.serviceEndUtc, detail.airportTimezone)}`,
      { indent: 12 },
    );
    pdf.text(`Status: ${line.status.replace(/_/g, ' ')}`, { indent: 12 });

    const requirements = Object.entries(line.requirements);
    if (requirements.length > 0) {
      pdf.text('Requirements:', { indent: 12 });
      for (const [key, value] of requirements) {
        pdf.text(`- ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${String(value)}`, {
          indent: 24,
        });
      }
    }

    if (line.assignedResources.length > 0) {
      pdf.text('Committed resources:', { indent: 12 });
      for (const resource of line.assignedResources) {
        pdf.text(`- ${resource.kind}: ${resource.label}`, { indent: 24 });
      }
    }

    pdf.gap();
  }

  // Passenger contacts are deliberately absent. A work order is a file that gets forwarded;
  // contacts are released per-line, by an explicit decision, through the product.
  pdf.subheading('Contacts');
  pdf.text(
    'Passenger contact details are not included in this document. They are released in the ' +
      'Apron provider portal once the service is acknowledged, or earlier if operations release them.',
  );

  footer(pdf);
  return { title: `Work order - ${providerName} - ${detail.reference}`, body: pdf.build() };
}

function renderHandlingSummary(detail: RequestDetail): Rendered {
  const pdf = new PdfBuilder();
  header(pdf, detail, 'Handling summary');

  if (detail.sourceSentence !== '') {
    pdf.subheading('As requested');
    pdf.text(`"${detail.sourceSentence}"`);
  }

  pdf.subheading('Services');
  pdf.gap();

  for (const line of detail.lines) {
    pdf.text(
      `${String(line.quantity)} ${line.unitLabel}${line.quantity === 1 ? '' : 's'} - ${line.serviceName}`,
      { bold: true },
    );
    pdf.text(`Status: ${line.status.replace(/_/g, ' ')}`, { indent: 12 });
    pdf.text(`Provider: ${line.currentProviderName ?? 'none yet'}`, { indent: 12 });
    pdf.text(
      `Window: ${localTime(line.serviceStartUtc, detail.airportTimezone)} to ${localTime(line.serviceEndUtc, detail.airportTimezone)}`,
      { indent: 12 },
    );
    pdf.text(
      `Selected by: ${line.selectionSource === null ? 'not yet selected' : line.selectionSource === 'ai' ? 'model, verified against the eligibility snapshot' : line.selectionSource}`,
      { indent: 12 },
    );
    if (line.rematchCount > 0) {
      pdf.text(`Re-matched ${String(line.rematchCount)} time(s).`, { indent: 12 });
    }
    if (line.failureReason !== null) {
      pdf.text(`Exception: ${line.failureReason}`, { indent: 12 });
    }
    for (const resource of line.assignedResources) {
      pdf.text(`Committed: ${resource.kind} - ${resource.label}`, { indent: 12 });
    }
    pdf.gap();
  }

  if (detail.passengers.length > 0) {
    pdf.subheading('Manifest');
    for (const person of detail.passengers) {
      pdf.text(`${person.fullName} (${person.personType})`, { indent: 12 });
    }
  }

  footer(pdf);
  return { title: `Handling summary - ${detail.reference}`, body: pdf.build() };
}
