import Link from 'next/link';
import { Badge, Card, CardHeader, type BadgeTone } from '@/components/ui/primitives';
import type { ClientRequestSummary } from '@/db/queries/client-requests';
import { formatOperational } from '@/lib/time';

/**
 * A client's own requests (CLAUDE.md §1).
 *
 * Shown under the composer so a request can be found again after it is made — without this
 * the confirmation was the only time a client ever saw their reference.
 *
 * Progress is stated as a count of what is arranged, not as an internal status. "2 of 5
 * arranged" is something a client can act on; "partial" is a word from our state machine.
 */

function describe(request: ClientRequestSummary): { label: string; tone: BadgeTone } {
  if (request.status === 'cancelled') return { label: 'Cancelled', tone: 'neutral' };
  if (request.status === 'completed') return { label: 'Completed', tone: 'neutral' };
  if (request.problemCount > 0) return { label: 'Needs our attention', tone: 'warning' };
  if (request.lineCount > 0 && request.arrangedCount === request.lineCount) {
    return { label: 'Everything arranged', tone: 'success' };
  }
  return { label: 'Being arranged', tone: 'info' };
}

export function ClientRequestList({
  requests,
}: {
  readonly requests: readonly ClientRequestSummary[];
}) {
  if (requests.length === 0) {
    // Nothing to show and nothing to apologise for — a first-time client has no history,
    // and an empty card saying so is noise on an otherwise clean page.
    return null;
  }

  return (
    <Card className="mt-6">
      <CardHeader
        title="Your requests"
        description="Everything you have asked us to arrange, most recent arrival first."
      />
      <ul className="divide-y divide-border">
        {requests.map((request) => {
          const described = describe(request);

          return (
            <li key={request.id}>
              <Link
                href={`/client/requests/${request.id}`}
                className="block px-5 py-4 transition-colors hover:bg-canvas-cool"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-text-primary">{request.reference}</span>
                  <Badge tone={described.tone}>{described.label}</Badge>
                </div>

                <p className="mt-1 text-[13px] text-text-secondary">
                  {request.airportLabel}
                  {request.fboName !== null && ` · ${request.fboName}`}
                </p>

                <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                  {request.arrivalUtc === null
                    ? 'Arrival to be confirmed'
                    : `${formatOperational(request.arrivalUtc, request.airportTimezone)} local`}
                  {request.lineCount > 0 && (
                    <>
                      {' · '}
                      {request.arrangedCount} of {request.lineCount} service
                      {request.lineCount === 1 ? '' : 's'} arranged
                    </>
                  )}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
