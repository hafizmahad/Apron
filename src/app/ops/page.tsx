import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Clock, ListChecks, Plane, ShieldAlert } from 'lucide-react';
import { requirePermission } from '@/auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/primitives';
import { loadDashboardSummary, loadRequestList } from '@/db/queries/operations';
import { cn } from '@/lib/cn';
import { formatOperational } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * Operations dashboard (CLAUDE.md §12).
 *
 * Ordered by what will hurt first: overdue acknowledgements, then exceptions, then
 * services starting soon that are still uncovered. A dashboard that leads with a total
 * count of requests tells a controller nothing they can act on.
 */
export default async function OperationsDashboardPage() {
  await requirePermission('request.view.any');

  const now = new Date();
  const [summary, overdue, exceptions, upcoming] = await Promise.all([
    loadDashboardSummary(now),
    loadRequestList({ overdueOnly: true, limit: 8 }),
    loadRequestList({ exceptionsOnly: true, limit: 8 }),
    loadRequestList({
      status: ['sent', 'sourcing', 'partial', 'confirmed', 'in_progress'],
      fromUtc: new Date(now.getTime() - 2 * 3_600_000),
      toUtc: new Date(now.getTime() + 36 * 3_600_000),
      limit: 10,
    }),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Dashboard"
        description="What needs attention first, then what is coming."
        actions={
          <Link href="/ops/requests">
            <Button variant="secondary">All requests</Button>
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Acknowledgements overdue"
          value={summary.overdue}
          tone={summary.overdue > 0 ? 'danger' : 'neutral'}
          icon={<Clock className="size-4" aria-hidden />}
          href="/ops/requests?overdue=1"
        />
        <Stat
          label="Exceptions"
          value={summary.exceptions}
          tone={summary.exceptions > 0 ? 'danger' : 'neutral'}
          icon={<ShieldAlert className="size-4" aria-hidden />}
          href="/ops/exceptions"
        />
        <Stat
          label="Services at risk (6 h)"
          value={summary.servicesAtRisk}
          tone={summary.servicesAtRisk > 0 ? 'warning' : 'neutral'}
          icon={<AlertTriangle className="size-4" aria-hidden />}
        />
        <Stat
          label="Awaiting a provider"
          value={summary.awaitingAcknowledgement}
          tone={summary.awaitingAcknowledgement > 0 ? 'warning' : 'neutral'}
          icon={<ListChecks className="size-4" aria-hidden />}
        />
        <Stat
          label="Arrivals in the window"
          value={summary.arrivalsToday}
          tone="neutral"
          icon={<Plane className="size-4" aria-hidden />}
        />
        <Stat
          label="Active requests"
          value={summary.activeRequests}
          tone="neutral"
          icon={<ListChecks className="size-4" aria-hidden />}
          href="/ops/requests"
        />
        <Stat
          label="Completed recently"
          value={summary.completedToday}
          tone="success"
          icon={<CheckCircle2 className="size-4" aria-hidden />}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Overdue acknowledgements"
            description="A provider has not answered inside the SLA. The worker re-matches automatically; these are the ones worth a call."
          />
          {overdue.length === 0 ? (
            <EmptyState
              title="Nothing overdue"
              description="Every outstanding offer is still inside its response window."
            />
          ) : (
            <RequestRows rows={overdue} emphasis="deadline" />
          )}
        </Card>

        <Card>
          <CardHeader
            title="Exceptions"
            description="Lines with no provider left to try. These need a person."
          />
          {exceptions.length === 0 ? (
            <EmptyState
              title="No exceptions"
              description="Every service line has a provider or is still being sourced."
            />
          ) : (
            <RequestRows rows={exceptions} emphasis="failed" />
          )}
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader
            title="Next 36 hours"
            description="Soonest arrival first."
            action={
              <Link href="/ops/requests">
                <Button size="sm" variant="secondary">
                  Open list
                </Button>
              </Link>
            }
          />
          {upcoming.length === 0 ? (
            <EmptyState
              title="Nothing scheduled"
              description="Requests appear here once they are confirmed."
            />
          ) : (
            <RequestRows rows={upcoming} emphasis="coverage" />
          )}
        </Card>
      </div>
    </>
  );
}

function RequestRows({
  rows,
  emphasis,
}: {
  readonly rows: Awaited<ReturnType<typeof loadRequestList>>;
  readonly emphasis: 'deadline' | 'failed' | 'coverage';
}) {
  const now = new Date();

  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
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
                {row.providerNames !== '' && ` · ${row.providerNames}`}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {emphasis === 'deadline' && row.nextDeadlineUtc !== null && (
                <Badge tone="danger">
                  {Math.round((now.getTime() - row.nextDeadlineUtc.getTime()) / 60_000)} min over
                </Badge>
              )}
              {emphasis === 'failed' && row.failedCount > 0 && (
                <Badge tone="danger">
                  {row.failedCount} line{row.failedCount === 1 ? '' : 's'} failed
                </Badge>
              )}
              <Badge tone={coverageTone(row.coveredCount, row.lineCount, row.failedCount)}>
                {row.coveredCount}/{row.lineCount} covered
              </Badge>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function coverageTone(covered: number, total: number, failed: number) {
  if (failed > 0) return 'danger' as const;
  if (total > 0 && covered === total) return 'success' as const;
  if (covered > 0) return 'warning' as const;
  return 'neutral' as const;
}

function Stat({
  label,
  value,
  tone,
  icon,
  href,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'neutral' | 'warning' | 'danger' | 'success';
  readonly icon: React.ReactNode;
  readonly href?: string;
}) {
  const body = (
    <Card
      className={cn(
        'p-4 transition-colors',
        href !== undefined && 'hover:bg-canvas-cool',
        tone === 'danger' && value > 0 && 'border-danger/30',
        tone === 'warning' && value > 0 && 'border-warning/30',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-text-secondary">
          {label}
        </p>
        <span
          className={cn(
            'shrink-0',
            tone === 'danger' && value > 0 ? 'text-danger' : '',
            tone === 'warning' && value > 0 ? 'text-warning' : '',
            tone === 'success' ? 'text-success' : '',
            (tone === 'neutral' || value === 0) && 'text-text-secondary',
          )}
        >
          {icon}
        </span>
      </div>
      <p className="tabular mt-2 text-2xl leading-none text-text-primary">{value}</p>
    </Card>
  );

  return href === undefined ? body : <Link href={href}>{body}</Link>;
}
