import Link from 'next/link';
import { requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/primitives';
import { loadRequestList, type RequestListRow } from '@/db/queries/operations';
import { formatDateKey, formatOperational } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * The operations schedule (CLAUDE.md §12).
 *
 * Grouped by LOCAL day at each airport, not by UTC day — a 03:00 Teterboro arrival belongs
 * to the night a controller thinks of it as, and grouping by UTC would scatter a single
 * operational evening across two headings.
 */
export default async function OperationsSchedulePage() {
  await requirePermission('request.view.any');

  const now = new Date();
  const rows = await loadRequestList({
    status: ['sent', 'sourcing', 'partial', 'confirmed', 'in_progress'],
    fromUtc: new Date(now.getTime() - 12 * 3_600_000),
    toUtc: new Date(now.getTime() + 7 * 24 * 3_600_000),
    limit: 200,
  });

  const byDay = new Map<string, RequestListRow[]>();
  for (const row of rows) {
    if (row.arrivalUtc === null) continue;
    const key = formatDateKey(row.arrivalUtc, row.airportTimezone);
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }

  const days = [...byDay.keys()].sort();

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Schedule"
        description="The next seven days, grouped by local day at each airport."
      />

      {days.length === 0 ? (
        <Card>
          <CardHeader title="Nothing scheduled" />
          <EmptyState
            title="No arrivals in the window"
            description="Confirmed requests with an arrival time appear here."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {days.map((day) => {
            const items = byDay.get(day) ?? [];
            return (
              <Card key={day}>
                <CardHeader
                  title={day}
                  description={`${items.length} arrival${items.length === 1 ? '' : 's'}`}
                />
                <ul className="divide-y divide-border">
                  {items.map((row) => (
                    <li key={row.id}>
                      <Link
                        href={`/ops/requests/${row.id}`}
                        className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-canvas-cool"
                      >
                        <div className="flex min-w-0 items-baseline gap-3">
                          <span className="tabular shrink-0 text-[13px] font-medium text-text-primary">
                            {row.arrivalUtc === null
                              ? '—'
                              : formatOperational(row.arrivalUtc, row.airportTimezone).slice(-5)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-[13px] text-text-primary">
                              <span className="tabular">{row.reference}</span>
                              <span className="ml-2 text-text-secondary">{row.clientName}</span>
                            </p>
                            <p className="mt-0.5 truncate text-[12px] text-text-secondary">
                              {row.airportLabel}
                              {row.providerNames !== '' && ` · ${row.providerNames}`}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {row.failedCount > 0 && <Badge tone="danger">{row.failedCount} failed</Badge>}
                          <Badge
                            tone={
                              row.coveredCount === row.lineCount && row.lineCount > 0
                                ? 'success'
                                : row.coveredCount > 0
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {row.coveredCount}/{row.lineCount}
                          </Badge>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
