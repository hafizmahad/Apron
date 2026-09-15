import Link from 'next/link';
import { count, eq, sql } from 'drizzle-orm';
import { requirePermission } from '@/auth/context';
import { getDb } from '@/db/client';
import { airports, providerCompanies, serviceCategories, users } from '@/db/schema';
import { PageHeader, Card, CardHeader, DataPoint, Badge } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

/**
 * Admin overview (CLAUDE.md §14).
 *
 * A landing page earns its place by answering "is anything waiting for me?" — so the
 * counts come first, and anything actually needing a decision is surfaced with a link
 * straight to it. A dashboard that only reports totals makes a reader hunt.
 *
 * Every number is a live query. Nothing here is illustrative.
 */
export default async function AdminOverviewPage() {
  await requirePermission('provider.view.any');

  const db = getDb();

  const [providerTotals] = await db
    .select({
      total: count(),
      approved: sql<number>`count(*) filter (where ${providerCompanies.status} = 'approved')::int`,
      pending: sql<number>`count(*) filter (where ${providerCompanies.status} = 'pending')::int`,
      suspended: sql<number>`count(*) filter (where ${providerCompanies.status} = 'suspended')::int`,
    })
    .from(providerCompanies);

  const [airportTotals] = await db
    .select({ total: count() })
    .from(airports)
    .where(eq(airports.active, true));

  const [serviceTotals] = await db
    .select({ total: count() })
    .from(serviceCategories)
    .where(eq(serviceCategories.active, true));

  const [userTotals] = await db
    .select({
      total: count(),
      suspended: sql<number>`count(*) filter (where ${users.status} = 'suspended')::int`,
    })
    .from(users);

  // The operational picture, in one round trip rather than five.
  const platform = await db.execute<{
    requests: number;
    open_requests: number;
    failed_lines: number;
    live_offers: number;
    overdue_offers: number;
    unverified_ai: number;
    ai_calls_today: number;
    ai_failures_today: number;
    audit_events_today: number;
  }>(sql`
    select
      (select count(*)::int from requests)                                   as requests,
      (select count(*)::int from requests
        where status in ('sent', 'sourcing', 'partial', 'confirmed', 'in_progress'))
                                                                            as open_requests,
      (select count(*)::int from request_service_lines where status = 'failed')
                                                                            as failed_lines,
      (select count(*)::int from provider_offers where status = 'sent')      as live_offers,
      (select count(*)::int from provider_offers
        where status = 'sent' and expires_at < now())                        as overdue_offers,
      (select count(*)::int from match_attempts
        where ai_consulted and ai_verified is not true)                      as unverified_ai,
      (select count(*)::int from ai_calls where occurred_at > now() - interval '24 hours')
                                                                            as ai_calls_today,
      (select count(*)::int from ai_calls
        where occurred_at > now() - interval '24 hours' and outcome <> 'success')
                                                                            as ai_failures_today,
      (select count(*)::int from audit_events
        where occurred_at > now() - interval '24 hours')                     as audit_events_today
  `);

  const stats = platform.rows[0];

  const attention: readonly { label: string; count: number; href: string; tone: 'warning' | 'danger' }[] =
    [
      {
        label: 'provider registrations awaiting approval',
        count: providerTotals?.pending ?? 0,
        href: '/admin/providers',
        tone: 'warning' as const,
      },
      {
        label: 'services no provider could cover',
        count: stats?.failed_lines ?? 0,
        href: '/admin/requests',
        tone: 'danger' as const,
      },
      {
        label: 'offers past their acknowledgement deadline',
        count: stats?.overdue_offers ?? 0,
        href: '/admin/requests',
        tone: 'danger' as const,
      },
      {
        label: 'model choices that did not pass verification',
        count: stats?.unverified_ai ?? 0,
        href: '/admin/requests',
        tone: 'warning' as const,
      },
      {
        label: 'AI calls that failed in the last 24 hours',
        count: stats?.ai_failures_today ?? 0,
        href: '/admin/ai',
        tone: 'warning' as const,
      },
    ].filter((item) => item.count > 0);

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Platform overview"
        description="Governance, configuration and observability for the whole platform. Every number below is live."
      />

      {attention.length > 0 ? (
        <Card className="mb-6 border-warning/30 bg-warning-wash">
          <CardHeader title="Needs a decision" />
          <ul className="divide-y divide-warning/20">
            {attention.map((item) => (
              <li key={item.label}>
                <Link
                  href={item.href}
                  className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-warning/5"
                >
                  <Badge tone={item.tone}>{item.count}</Badge>
                  <span className="flex-1 text-[13px] text-text-primary">{item.label}</span>
                  <span className="text-[13px] font-medium text-accent">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card className="mb-6 border-success/25 bg-success-wash">
          <div className="p-5">
            <p className="text-[13px] font-semibold text-success">Nothing is waiting on you</p>
            <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
              No pending approvals, no uncovered services, no overdue acknowledgements and no
              unverified model choices.
            </p>
          </div>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <DataPoint label="Provider companies" numeric>
            {providerTotals?.total ?? 0}
          </DataPoint>
          <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
            {providerTotals?.approved ?? 0} approved · {providerTotals?.pending ?? 0} pending ·{' '}
            {providerTotals?.suspended ?? 0} suspended
          </p>
        </Card>

        <Card className="p-5">
          <DataPoint label="Requests" numeric>
            {stats?.requests ?? 0}
          </DataPoint>
          <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
            {stats?.open_requests ?? 0} still open · {stats?.live_offers ?? 0} live offer
            {(stats?.live_offers ?? 0) === 1 ? '' : 's'}
          </p>
        </Card>

        <Card className="p-5">
          <DataPoint label="Network" numeric>
            {airportTotals?.total ?? 0}
          </DataPoint>
          <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
            active airports · {serviceTotals?.total ?? 0} active services
          </p>
        </Card>

        <Card className="p-5">
          <DataPoint label="Platform users" numeric>
            {userTotals?.total ?? 0}
          </DataPoint>
          <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
            {(userTotals?.suspended ?? 0) === 0
              ? 'none suspended'
              : `${String(userTotals?.suspended ?? 0)} suspended`}
          </p>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Last 24 hours"
          description="Model reliability and the audit trail. Token counts and cost are deliberately not recorded anywhere in this product (ADR-015)."
        />
        <dl className="grid gap-4 p-5 sm:grid-cols-3">
          <DataPoint label="AI calls" numeric>
            {stats?.ai_calls_today ?? 0}
          </DataPoint>
          <DataPoint label="AI failures" numeric>
            <span className={(stats?.ai_failures_today ?? 0) > 0 ? 'text-warning' : ''}>
              {stats?.ai_failures_today ?? 0}
            </span>
          </DataPoint>
          <DataPoint label="Audit events" numeric>
            {stats?.audit_events_today ?? 0}
          </DataPoint>
        </dl>
        <div className="flex flex-wrap gap-4 border-t border-border px-5 py-3 text-[13px]">
          <Link href="/admin/ai" className="font-medium text-accent hover:underline">
            AI reliability →
          </Link>
          <Link href="/admin/audit" className="font-medium text-accent hover:underline">
            Audit explorer →
          </Link>
          <Link href="/admin/requests" className="font-medium text-accent hover:underline">
            Request oversight →
          </Link>
        </div>
      </Card>
    </>
  );
}
