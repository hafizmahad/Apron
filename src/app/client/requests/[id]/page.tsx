import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';
import { requireSession } from '@/auth/context';
import { homePortal } from '@/domain/permissions';
import { ClientHeader } from '@/components/layout/client-header';
import { Badge, Card, CardHeader, DataPoint, type BadgeTone } from '@/components/ui/primitives';
import { ServiceIcon } from '@/components/ui/domain-icon';
import { loadClientRequestDetail } from '@/db/queries/client-requests';
import { getDb } from '@/db/client';
import { clientOrganizations } from '@/db/schema';
import { formatOperational } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your request' };

/**
 * The client's view of one request (CLAUDE.md §1 "request status page").
 *
 * Plain language, no internal vocabulary. A client is told what they asked for and whether
 * it is arranged — never a rejection reason code, never which suppliers were considered and
 * refused, never a ranking. A supplier is named only once they have accepted, because
 * naming one who then declines invites the client to chase a job nobody holds.
 */

/** Line status in words a client would actually use. */
function describeLine(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'assigned':
    case 'in_progress':
      return { label: 'Arranged', tone: 'success' };
    case 'completed':
      return { label: 'Completed', tone: 'neutral' };
    case 'acknowledged':
      return { label: 'Accepted', tone: 'info' };
    case 'offered':
    case 'waiting':
    case 'matching':
    case 'rematching':
    case 'draft':
    case 'declined':
      return { label: 'Finding a supplier', tone: 'warning' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'failed':
      return { label: 'Our team is on it', tone: 'danger' };
    default:
      // A status this build does not describe. A client should never be shown an internal
      // identifier, so the safe, true thing is said instead — operations can see the exact
      // state on the request page.
      return { label: 'Being arranged', tone: 'info' };
  }
}

export default async function ClientRequestPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const session = await requireSession();
  const actor = session.user;

  if (actor.clientOrganizationId === null) {
    // Reached when a NON-client lands here: the App Router renders the layout and the page
    // in parallel, so this runs even though the layout is already redirecting them away.
    // The end state was always correct — a 307 to their own portal — but throwing logged a
    // misleading internal error on every one of those redirects. Redirecting agrees with
    // the layout instead of fighting it.
    redirect(homePortal(actor));
  }

  const { id } = await params;

  // Scoped load: another organisation's request is NOT FOUND, never merely refused, so a
  // guessed id reveals nothing about whether it exists.
  const request = await loadClientRequestDetail(actor.clientOrganizationId, id);
  if (request === null) notFound();

  const [organization] = await getDb()
    .select({ name: clientOrganizations.name })
    .from(clientOrganizations)
    .where(eq(clientOrganizations.id, actor.clientOrganizationId))
    .limit(1);

  const allArranged = request.lineCount > 0 && request.arrangedCount === request.lineCount;

  return (
    <>
      <ClientHeader user={actor} organizationName={organization?.name ?? 'Your organisation'} />

      <main className="mx-auto w-full max-w-4xl px-5 pb-16 sm:px-8">
        <p className="mt-8 text-[13px]">
          <Link href="/client" className="text-accent hover:underline">
            &larr; New request
          </Link>
        </p>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-text-secondary">
              Your request
            </p>
            <h1 className="font-display mt-1 text-3xl font-semibold text-text-primary">
              {request.reference}
            </h1>
          </div>
          <Badge tone={allArranged ? 'success' : request.problemCount > 0 ? 'warning' : 'info'}>
            {request.status === 'cancelled'
              ? 'Cancelled'
              : allArranged
                ? 'Everything arranged'
                : request.problemCount > 0
                  ? 'Needs our attention'
                  : 'Being arranged'}
          </Badge>
        </div>

        {request.status === 'cancelled' && request.cancellationReason !== null && (
          <Card className="mt-6">
            <div className="p-5">
              <p className="text-[13px] font-medium text-text-primary">
                This request was cancelled
              </p>
              <p className="mt-1 text-[13px] text-text-secondary">{request.cancellationReason}</p>
            </div>
          </Card>
        )}

        {request.sourceSentence !== '' && (
          <Card className="mt-6">
            <CardHeader title="What you asked for" />
            <p className="px-5 pb-5 text-[15px] leading-relaxed text-text-primary">
              &ldquo;{request.sourceSentence}&rdquo;
            </p>
          </Card>
        )}

        <Card className="mt-4">
          <CardHeader title="Your trip" />
          <dl className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
            <DataPoint label="Airport">{request.airportLabel}</DataPoint>
            {request.fboName !== null && <DataPoint label="Handler">{request.fboName}</DataPoint>}
            <DataPoint label="Arrival" numeric>
              {request.arrivalUtc === null
                ? 'to be confirmed'
                : `${formatOperational(request.arrivalUtc, request.airportTimezone)} local`}
            </DataPoint>
            {request.departureUtc !== null && (
              <DataPoint label="Departure" numeric>
                {formatOperational(request.departureUtc, request.airportTimezone)} local
              </DataPoint>
            )}
            <DataPoint label="Passengers" numeric>
              {request.passengerCount}
            </DataPoint>
            <DataPoint label="Crew" numeric>
              {request.crewCount}
            </DataPoint>
          </dl>
        </Card>

        <Card className="mt-4">
          <CardHeader
            title="Your services"
            description={
              allArranged
                ? 'Everything is arranged.'
                : `${String(request.arrangedCount)} of ${String(request.lineCount)} arranged so far.`
            }
          />
          <ul className="divide-y divide-border">
            {request.lines.map((line) => {
              const described = describeLine(line.status);

              return (
                <li key={line.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                  <ServiceIcon
                    code={line.serviceCode}
                    label=""
                    className="size-5 shrink-0 text-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-text-primary">
                      {line.quantity} {line.unitLabel}
                      {line.quantity === 1 ? '' : 's'} · {line.serviceName}
                    </p>
                    <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                      {line.serviceStartUtc === null
                        ? 'Timing to be confirmed'
                        : `${formatOperational(line.serviceStartUtc, request.airportTimezone)} local`}
                      {line.providerName !== null && ` · ${line.providerName}`}
                    </p>
                  </div>
                  <Badge tone={described.tone}>{described.label}</Badge>
                </li>
              );
            })}
          </ul>

          {request.problemCount > 0 && (
            <div className="border-t border-border bg-warning-wash px-5 py-4">
              <p className="text-[13px] leading-relaxed text-text-secondary">
                We could not place {request.problemCount} service
                {request.problemCount === 1 ? '' : 's'} automatically. Our operations team has
                been notified and is arranging {request.problemCount === 1 ? 'it' : 'them'} by
                hand — they will be in touch.
              </p>
            </div>
          )}
        </Card>
      </main>
    </>
  );
}
