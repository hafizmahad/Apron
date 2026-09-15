import Link from 'next/link';
import { requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/primitives';
import { loadRequestList } from '@/db/queries/operations';
import { formatOperational } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * Exceptions (CLAUDE.md §12).
 *
 * Two distinct problems, kept apart because they need different responses:
 *
 *  - **Failed lines** — the waterfall is exhausted. Nobody else can be tried automatically;
 *    a person must widen the search, change the timing, or tell the client.
 *  - **Overdue acknowledgements** — a provider has gone quiet. The worker re-matches on its
 *    own, so these are informational: worth a phone call, not an intervention.
 */
export default async function OperationsExceptionsPage() {
  await requirePermission('request.view.any');

  const [failed, overdue] = await Promise.all([
    loadRequestList({ exceptionsOnly: true, limit: 100 }),
    loadRequestList({ overdueOnly: true, limit: 100 }),
  ]);

  const now = new Date();

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Exceptions"
        description="Where the automatic flow has stopped, and where a provider has gone quiet."
      />

      <Card className="mb-4">
        <CardHeader
          title={`Needs a person (${failed.length})`}
          description="Every provider has been tried, or none covers this service here. The platform will not retry on its own."
        />
        {failed.length === 0 ? (
          <EmptyState
            title="Nothing stuck"
            description="Every service line either has a provider or is still being sourced automatically."
          />
        ) : (
          <ul className="divide-y divide-border">
            {failed.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/ops/requests/${row.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-canvas-cool"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-text-primary">
                      <span className="tabular">{row.reference}</span>
                      <span className="ml-2 font-normal text-text-secondary">{row.clientName}</span>
                    </p>
                    <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                      {row.airportLabel}
                      {row.arrivalUtc !== null &&
                        ` · arr ${formatOperational(row.arrivalUtc, row.airportTimezone)} local`}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Badge tone="danger">
                      {row.failedCount} of {row.lineCount} failed
                    </Badge>
                    {row.coveredCount > 0 && <Badge tone="success">{row.coveredCount} covered</Badge>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={`Provider has not responded (${overdue.length})`}
          description="Past the acknowledgement deadline. The worker re-matches automatically — these are worth a call, not an intervention."
        />
        {overdue.length === 0 ? (
          <EmptyState
            title="Everyone is inside their window"
            description="No outstanding offer has passed its deadline."
          />
        ) : (
          <ul className="divide-y divide-border">
            {overdue.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/ops/requests/${row.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-canvas-cool"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-text-primary">
                      <span className="tabular">{row.reference}</span>
                      <span className="ml-2 font-normal text-text-secondary">
                        {row.providerNames === '' ? row.clientName : row.providerNames}
                      </span>
                    </p>
                    <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                      {row.airportLabel}
                      {row.arrivalUtc !== null &&
                        ` · arr ${formatOperational(row.arrivalUtc, row.airportTimezone)} local`}
                    </p>
                  </div>
                  {row.nextDeadlineUtc !== null && (
                    <Badge tone="warning">
                      {Math.round((now.getTime() - row.nextDeadlineUtc.getTime()) / 60_000)} min over
                    </Badge>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
