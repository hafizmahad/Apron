import Link from 'next/link';
import { AlertTriangle, BellRing, CalendarRange, CheckCircle2 } from 'lucide-react';
import { requirePermission } from '@/auth/context';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/primitives';
import { loadAcknowledgedWork, loadOfferQueue } from '@/db/queries/provider-queue';
import { ApronError } from '@/lib/errors';
import { formatOperational } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * Provider dashboard (CLAUDE.md §13).
 *
 * Answers the three questions a dispatcher starting a shift actually has:
 *   what is waiting on me, what have I accepted but not resourced, and what is covered.
 *
 * Pending acknowledgements are ordered by SLA age — the one about to lapse is first, not
 * the one that arrived first.
 */
export default async function ProviderDashboardPage() {
  const actor = await requirePermission('provider.view.own');

  if (actor.providerCompanyId === null) {
    throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
  }

  const [queue, work] = await Promise.all([
    loadOfferQueue(actor.providerCompanyId),
    loadAcknowledgedWork(actor.providerCompanyId),
  ]);

  const now = new Date();
  const awaitingResources = work.filter((item) => item.assignmentId === null);
  const covered = work.filter((item) => item.assignmentId !== null);

  const critical = queue.filter(
    (offer) => offer.expiresAt.getTime() - now.getTime() <= 10 * 60_000,
  ).length;

  const next24h = work.filter(
    (item) =>
      item.serviceStartUtc !== null &&
      item.serviceStartUtc.getTime() >= now.getTime() &&
      item.serviceStartUtc.getTime() <= now.getTime() + 24 * 3_600_000,
  );

  return (
    <>
      <PageHeader
        eyebrow="Provider"
        title="Dashboard"
        description="What is waiting on you, what you have accepted, and what is already covered."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Awaiting your response"
          value={queue.length}
          tone={critical > 0 ? 'danger' : queue.length > 0 ? 'warning' : 'neutral'}
          {...(critical > 0 ? { note: `${critical} under 10 minutes` } : {})}
          href="/provider/queue"
        />
        <StatCard
          label="Accepted, needs resources"
          value={awaitingResources.length}
          tone={awaitingResources.length > 0 ? 'warning' : 'neutral'}
          href="/provider/schedule"
        />
        <StatCard label="Covered" value={covered.length} tone="success" href="/provider/schedule" />
        <StatCard label="Starting in 24 hours" value={next24h.length} tone="neutral" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Pending acknowledgements"
            description="Ordered by how soon the deadline lapses."
            action={
              queue.length > 0 ? (
                <Link href="/provider/queue">
                  <Button size="sm" variant="secondary">
                    Open queue
                  </Button>
                </Link>
              ) : undefined
            }
          />
          {queue.length === 0 ? (
            <EmptyState
              title="Nothing waiting"
              description="Offers appear here as operations dispatches them."
            />
          ) : (
            <ul className="divide-y divide-border">
              {queue.slice(0, 6).map((offer) => {
                const minutes = Math.floor((offer.expiresAt.getTime() - now.getTime()) / 60_000);
                return (
                  <li key={offer.offerId} className="flex items-start justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-text-primary">
                        {offer.quantity} × {offer.unitLabel}
                        {offer.quantity === 1 ? '' : 's'} · {offer.serviceName}
                      </p>
                      <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                        {offer.reference} · {offer.airportLabel}
                        {offer.serviceStartUtc !== null &&
                          ` · ${formatOperational(offer.serviceStartUtc, offer.airportTimezone)} local`}
                      </p>
                    </div>
                    <Badge tone={minutes <= 10 ? 'danger' : minutes <= 20 ? 'warning' : 'neutral'}>
                      {minutes <= 0 ? 'lapsed' : `${minutes} min`}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Needs resources"
            description="Accepted, but no vehicle, driver or officer committed yet."
            action={
              awaitingResources.length > 0 ? (
                <Link href="/provider/schedule">
                  <Button size="sm" variant="secondary">
                    Assign
                  </Button>
                </Link>
              ) : undefined
            }
          />
          {awaitingResources.length === 0 ? (
            <EmptyState
              title="Everything you accepted is covered"
              description="Work you accept appears here until you commit the actual resources."
            />
          ) : (
            <ul className="divide-y divide-border">
              {awaitingResources.slice(0, 6).map((item) => (
                <li
                  key={item.requestServiceLineId}
                  className="flex items-start justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-text-primary">
                      {item.quantity} × {item.unitLabel}
                      {item.quantity === 1 ? '' : 's'} · {item.serviceName}
                    </p>
                    <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                      {item.reference} · {item.airportLabel}
                      {item.serviceStartUtc !== null &&
                        ` · ${formatOperational(item.serviceStartUtc, item.airportTimezone)} local`}
                    </p>
                  </div>
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  tone,
  note,
  href,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'neutral' | 'warning' | 'danger' | 'success';
  readonly note?: string;
  readonly href?: string;
}) {
  const icon =
    tone === 'danger' ? (
      <BellRing className="size-4 text-danger" aria-hidden />
    ) : tone === 'warning' ? (
      <AlertTriangle className="size-4 text-warning" aria-hidden />
    ) : tone === 'success' ? (
      <CheckCircle2 className="size-4 text-success" aria-hidden />
    ) : (
      <CalendarRange className="size-4 text-text-secondary" aria-hidden />
    );

  const body = (
    <Card className="p-5 transition-colors hover:bg-canvas-cool">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-text-secondary">
          {label}
        </p>
        {icon}
      </div>
      <p className="tabular mt-2 text-2xl leading-none text-text-primary">{value}</p>
      {note !== undefined && <p className="mt-1.5 text-[12px] text-danger">{note}</p>}
    </Card>
  );

  return href === undefined ? body : <Link href={href}>{body}</Link>;
}
