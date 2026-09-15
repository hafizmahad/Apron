import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { requirePermission } from '@/auth/context';
import {
  auditActionLabel,
  lineStatusLabel,
  offerStatusLabel,
  priorityLabel,
  requestStatusLabel,
  resourceKindLabel,
  selectionSourceLabel,
} from '@/lib/domain-labels';
import {
  Badge,
  Card,
  CardHeader,
  DataPoint,
  PageHeader,
  type BadgeTone,
} from '@/components/ui/primitives';
import { ServiceIcon } from '@/components/ui/domain-icon';
import { DecisionTrace } from '@/components/requests/decision-trace';
import {
  LineInterventions,
  RequestInterventions,
} from '@/components/requests/intervention-controls';
import { RequestThreads } from '@/components/messages/request-threads';
import { RequestDocuments } from '@/components/documents/request-documents';
import { MapCard, type MapPoint } from '@/components/maps/map-card';
import { ResearchPanel } from '@/components/ai/research-panel';
import {
  loadDecisionTrace,
  loadOfferHistory,
  loadOverrideCandidates,
  loadRequestAudit,
  loadRequestDetail,
} from '@/db/queries/operations';
import { can, canViewPassengerContacts } from '@/domain/permissions';
import { describeDerivedStatus } from '@/domain/requests/state-machine';
import type { RequestLineStatus, RequestStatus } from '@/db/schema/enums';
import { formatOperational } from '@/lib/time';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await loadRequestDetail(id);
  return { title: detail === null ? 'Request' : detail.reference };
}

const REQUEST_TONE: Record<RequestStatus, BadgeTone> = {
  draft: 'neutral',
  awaiting_confirmation: 'neutral',
  sent: 'info',
  sourcing: 'info',
  partial: 'warning',
  confirmed: 'success',
  in_progress: 'success',
  completed: 'neutral',
  cancelled: 'neutral',
  failed: 'danger',
};

const LINE_TONE: Record<RequestLineStatus, BadgeTone> = {
  draft: 'neutral',
  matching: 'info',
  offered: 'info',
  waiting: 'warning',
  acknowledged: 'success',
  declined: 'warning',
  rematching: 'warning',
  assigned: 'success',
  in_progress: 'success',
  completed: 'neutral',
  cancelled: 'neutral',
  failed: 'danger',
};

/**
 * The operations request detail (CLAUDE.md §12).
 *
 * Everything a controller needs on one page: what was asked for in the client's own words,
 * what it was resolved to, which provider holds each line and why, what is committed, and
 * the full audit history.
 *
 * Passenger contacts are gated by `canViewPassengerContacts`, not by hiding a field in
 * the template — the check is the same one the provider portal uses.
 */
export default async function RequestDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const actor = await requirePermission('request.view.any');
  const { id } = await params;

  const detail = await loadRequestDetail(id);
  if (detail === null) notFound();

  const [traces, offerHistories, audit, overrideCandidates] = await Promise.all([
    Promise.all(detail.lines.map(async (line) => [line.id, await loadDecisionTrace(line.id)] as const)),
    Promise.all(detail.lines.map(async (line) => [line.id, await loadOfferHistory(line.id)] as const)),
    loadRequestAudit(detail.id),
    loadOverrideCandidates(detail.id),
  ]);

  const traceByLine = new Map(traces);
  const offersByLine = new Map(offerHistories);

  // What Operations may do here. The actions re-check each of these server-side; this
  // only decides whether the control is drawn (CLAUDE.md §5).
  const canOverride = can(actor, 'request.override_provider');
  const canRetry = can(actor, 'request.update');
  const canReleaseContacts = can(actor, 'request.release_contacts_to_provider');
  const canCancel = can(actor, 'request.cancel');

  // Stated plainly in the cancellation consequence, so nobody discovers it afterwards.
  const liveOfferCount = detail.lines.filter((line) => line.currentOfferStatus === 'sent').length;
  const assignmentCount = detail.lines.filter((line) => line.assignmentId !== null).length;

  const showContacts = canViewPassengerContacts(actor, {
    clientOrganizationId: detail.clientId,
    involvedProviderCompanyIds: [],
    acknowledgedByProviderCompanyIds: [],
    contactsReleasedToProviderCompanyIds: [],
  });

  const mapPoints: MapPoint[] = [
    {
      label: detail.airportLabel,
      sublabel: detail.fboName === null ? detail.airportCity : `${detail.airportCity} · handler: ${detail.fboName}`,
      latitude: detail.airportLatitude,
      longitude: detail.airportLongitude,
      kind: 'airport',
    },
  ];

  const derivedNote = describeDerivedStatus(
    detail.status,
    detail.lines.map((line) => line.status),
  );

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link href="/ops/requests" className="hover:text-text-primary">
              Requests
            </Link>{' '}
            · {detail.clientName}
          </>
        }
        title={detail.reference}
        description={derivedNote}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={REQUEST_TONE[detail.status]}>{requestStatusLabel(detail.status)}</Badge>
            {detail.priority !== 'normal' && (
              <Badge tone={detail.priority === 'urgent' ? 'danger' : 'warning'}>
                {priorityLabel(detail.priority)}
              </Badge>
            )}
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {/* The client's own words, never rewritten. */}
          {detail.sourceSentence !== '' && (
            <Card>
              <CardHeader
                title="As requested"
                description={`Received via ${detail.createdVia} · kept exactly as written.`}
              />
              <blockquote className="border-l-2 border-accent/40 bg-canvas-cool px-5 py-4 text-[14px] italic leading-relaxed text-text-secondary">
                {detail.sourceSentence}
              </blockquote>
            </Card>
          )}

          <Card>
            <CardHeader title="Flight" />
            <dl className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
              <DataPoint label="Airport">{detail.airportLabel}</DataPoint>
              <DataPoint label="Handler">{detail.fboName ?? 'any'}</DataPoint>
              <DataPoint label="Timezone">{detail.airportTimezone}</DataPoint>
              <DataPoint label="Arrival (local)" numeric>
                {detail.arrivalUtc === null
                  ? 'not set'
                  : formatOperational(detail.arrivalUtc, detail.airportTimezone)}
              </DataPoint>
              <DataPoint label="Departure (local)" numeric>
                {detail.departureUtc === null
                  ? 'not set'
                  : formatOperational(detail.departureUtc, detail.airportTimezone)}
              </DataPoint>
              <DataPoint label="On board" numeric>
                {detail.passengerCount} passengers · {detail.crewCount} crew
              </DataPoint>
              <DataPoint label="Aircraft">{detail.aircraftLabel ?? 'not identified'}</DataPoint>
              {detail.aircraftDimensions !== null && (
                <DataPoint label="Dimensions" numeric>
                  {detail.aircraftDimensions}
                </DataPoint>
              )}
            </dl>
          </Card>

          {/* Services — one card per line, each with its own offers and trace. */}
          {detail.lines.map((line) => {
            const trace = traceByLine.get(line.id) ?? [];
            const offers = offersByLine.get(line.id) ?? [];

            return (
              <div key={line.id} className="space-y-3">
                <Card>
                  <CardHeader
                    title={
                      <span className="flex items-center gap-2.5">
                        <ServiceIcon code={line.serviceCode} label="" className="size-5 text-accent" />
                        {line.quantity} × {line.unitLabel}
                        {line.quantity === 1 ? '' : 's'} · {line.serviceName}
                      </span>
                    }
                    description={
                      line.serviceStartUtc === null || line.serviceEndUtc === null
                        ? 'Service window not set'
                        : `${formatOperational(line.serviceStartUtc, detail.airportTimezone)} — ${formatOperational(
                            line.serviceEndUtc,
                            detail.airportTimezone,
                          )} local`
                    }
                    action={<Badge tone={LINE_TONE[line.status]}>{lineStatusLabel(line.status)}</Badge>}
                  />

                  <div className="space-y-4 p-5">
                    {Object.keys(line.requirements).length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                          Requirements
                        </p>
                        <ul className="mt-2 flex flex-wrap gap-1.5">
                          {Object.entries(line.requirements).map(([key, value]) => (
                            <li
                              key={key}
                              className="rounded-full bg-canvas-cool px-2.5 py-0.5 text-[12px] text-text-primary ring-1 ring-inset ring-border"
                            >
                              {key.replace(/([A-Z])/g, ' $1').toLowerCase()}: {String(value)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <dl className="grid gap-4 sm:grid-cols-3">
                      <DataPoint label="Provider">
                        {line.currentProviderName ?? 'none yet'}
                      </DataPoint>
                      <DataPoint label="Selected by">
                        {selectionSourceLabel(line.selectionSource)}
                      </DataPoint>
                      <DataPoint label="Re-matches" numeric>
                        {line.rematchCount}
                      </DataPoint>
                    </dl>

                    {line.failureReason !== null && (
                      <p className="rounded-md border border-danger/30 bg-danger-wash px-3 py-2 text-[13px] text-danger">
                        {line.failureReason}
                      </p>
                    )}

                    {line.assignedResources.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                          Committed resources
                        </p>
                        <ul className="mt-2 space-y-1">
                          {line.assignedResources.map((resource, index) => (
                            <li
                              key={`${resource.kind}-${index}`}
                              className="flex items-center gap-2 text-[13px] text-text-primary"
                            >
                              <Badge tone="success">{resourceKindLabel(resource.kind)}</Badge>
                              {resource.label}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {offers.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                          Offer history
                        </p>
                        <ul className="mt-2 space-y-1.5">
                          {offers.map((offer) => (
                            <li
                              key={offer.id}
                              className="rounded-md border border-border bg-canvas-cool px-3 py-2"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-[13px] text-text-primary">
                                  #{offer.attemptNumber} {offer.providerName}
                                </span>
                                <Badge
                                  tone={
                                    offer.status === 'acknowledged'
                                      ? 'success'
                                      : offer.status === 'declined'
                                        ? 'warning'
                                        : offer.status === 'expired'
                                          ? 'danger'
                                          : 'info'
                                  }
                                >
                                  {offerStatusLabel(offer.status)}
                                </Badge>
                              </div>
                              {offer.declineReason !== null && (
                                <p className="mt-1 text-[12px] text-text-secondary">
                                  Declined: {offer.declineReason}
                                </p>
                              )}
                              <p className="tabular mt-1 text-[11px] text-text-secondary">
                                sent {formatOperational(offer.sentAt, detail.airportTimezone)} · deadline{' '}
                                {formatOperational(offer.expiresAt, detail.airportTimezone)}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <LineInterventions
                    requestId={detail.id}
                    lineId={line.id}
                    lineStatus={line.status}
                    serviceName={line.serviceName}
                    currentProviderName={line.currentProviderName}
                    currentProviderId={line.currentProviderId}
                    currentOfferStatus={line.currentOfferStatus}
                    candidates={overrideCandidates.get(line.id) ?? []}
                    canOverride={canOverride}
                    canRetry={canRetry}
                    canReleaseContacts={canReleaseContacts}
                  />
                </Card>

                <DecisionTrace attempts={trace} />
              </div>
            );
          })}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {can(actor, 'request.use_research_assistant') && <ResearchPanel requestId={detail.id} />}

          <MapCard
            points={mapPoints}
            caption="Airport coordinates are the published reference point. Handler positions are not stored, so no marker is placed for them."
          />

          <Card>
            <CardHeader
              title="Passengers and crew"
              description={
                showContacts
                  ? 'Contact details are visible to operations.'
                  : 'Contact details are withheld for your role.'
              }
            />
            {detail.passengers.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-text-secondary">
                No manifest recorded for this request.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {detail.passengers.map((person, index) => (
                  <li key={`${person.fullName}-${index}`} className="px-5 py-3">
                    <p className="text-[13px] font-medium text-text-primary">
                      {person.fullName}
                      {person.isPrimary && <Badge tone="accent">primary</Badge>}
                    </p>
                    <p className="mt-0.5 text-[12px] text-text-secondary">{person.personType}</p>
                    {showContacts && (person.phone !== null || person.email !== null) && (
                      <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                        {[person.phone, person.email].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {can(actor, 'audit.view') && (
            <Card>
              <CardHeader
                title="History"
                description="Everything that happened to this request."
              />
              {audit.length === 0 ? (
                <p className="px-5 py-4 text-[13px] text-text-secondary">Nothing recorded yet.</p>
              ) : (
                <ol className="divide-y divide-border">
                  {audit.map((event) => (
                    <li key={event.id} className="px-5 py-2.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[13px] font-medium text-text-primary">
                          {auditActionLabel(event.action)}
                        </span>
                        <span className="tabular shrink-0 text-[11px] text-text-secondary">
                          {formatOperational(event.occurredAt, detail.airportTimezone)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[12px] text-text-secondary">
                        {event.actorName ?? event.actorLabel}
                      </p>
                      {event.reason !== null && (
                        <p className="mt-0.5 text-[12px] italic text-text-secondary">
                          &ldquo;{event.reason}&rdquo;
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}

          <RequestDocuments requestId={detail.id} canGenerate={can(actor, 'request.update')} />

          {can(actor, 'message.view.any') && (
            <RequestThreads requestId={detail.id} canOpen={can(actor, 'message.send.internal')} />
          )}

          <RequestInterventions
            requestId={detail.id}
            reference={detail.reference}
            status={detail.status}
            liveOfferCount={liveOfferCount}
            assignmentCount={assignmentCount}
            canCancel={canCancel}
          />
        </div>
      </div>
    </>
  );
}
