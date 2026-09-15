import { asc, eq, sql } from 'drizzle-orm';
import { providerStatusLabel } from '@/lib/domain-labels';
import { requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ActionButton, InlineValueForm, ReasonedAction } from '@/components/ui/action-controls';
import {
  approveProviderAction,
  rejectProviderAction,
  setProviderRankAction,
  suspendProviderAction,
} from '@/app/admin/actions';
import { getDb } from '@/db/client';
import { providerCompanies, providerCoverage, serviceCategories } from '@/db/schema';
import type { ProviderCompanyStatus } from '@/db/schema/enums';

export const dynamic = 'force-dynamic';

/**
 * Provider approvals (CLAUDE.md §14).
 *
 * Real data: every registered company with its governance state, platform rank, coverage
 * footprint and compliance dates. Approving, rejecting, ranking and suspending are live
 * here, each writing an audit event with the reason it demanded.
 */

const STATUS_TONE: Record<ProviderCompanyStatus, BadgeTone> = {
  approved: 'success',
  pending: 'warning',
  suspended: 'danger',
  rejected: 'neutral',
};

interface ProviderRow {
  readonly id: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly status: ProviderCompanyStatus;
  readonly rank: number;
  readonly countryCode: string | null;
  readonly insuranceExpiresAt: string | null;
  readonly coverageCount: number;
  readonly airportCount: number;
  readonly serviceNames: string;
  readonly suspensionReason: string | null;
}

export default async function AdminProvidersPage() {
  await requirePermission('provider.view.any');

  const db = getDb();

  // One query rather than N+1: coverage breadth is what makes this register useful.
  const rows = await db
    .select({
      id: providerCompanies.id,
      displayName: providerCompanies.displayName,
      legalName: providerCompanies.legalName,
      status: providerCompanies.status,
      rank: providerCompanies.rank,
      countryCode: providerCompanies.countryCode,
      insuranceExpiresAt: providerCompanies.insuranceExpiresAt,
      suspensionReason: providerCompanies.suspensionReason,
      coverageCount: sql<number>`count(distinct ${providerCoverage.id})::int`,
      airportCount: sql<number>`count(distinct ${providerCoverage.airportId})::int`,
      serviceNames: sql<string>`coalesce(string_agg(distinct ${serviceCategories.name}, ', ' order by ${serviceCategories.name}), '')`,
    })
    .from(providerCompanies)
    .leftJoin(providerCoverage, eq(providerCoverage.providerCompanyId, providerCompanies.id))
    .leftJoin(serviceCategories, eq(serviceCategories.id, providerCoverage.serviceCategoryId))
    .groupBy(providerCompanies.id)
    // Deterministic ordering, and the order operations actually wants: work first.
    .orderBy(
      sql`case ${providerCompanies.status}
            when 'pending' then 0
            when 'suspended' then 1
            when 'approved' then 2
            else 3 end`,
      asc(providerCompanies.rank),
      asc(providerCompanies.displayName),
      asc(providerCompanies.id),
    );

  const pending = rows.filter((row) => row.status === 'pending');
  const suspended = rows.filter((row) => row.status === 'suspended');

  const columns: readonly Column<ProviderRow>[] = [
    {
      key: 'company',
      header: 'Company',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-text-primary">{row.displayName}</p>
          <p className="mt-0.5 text-[12px] text-text-secondary">{row.legalName}</p>
          {row.suspensionReason !== null && (
            <p className="mt-1 text-[12px] text-danger">{row.suspensionReason}</p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={STATUS_TONE[row.status]}>{providerStatusLabel(row.status)}</Badge>,
    },
    { key: 'rank', header: 'Rank', numeric: true, align: 'right', render: (row) => row.rank },
    {
      key: 'services',
      header: 'Services covered',
      secondary: true,
      render: (row) => (
        <span className="text-text-secondary">
          {row.serviceNames === '' ? 'none yet' : row.serviceNames}
        </span>
      ),
    },
    {
      key: 'footprint',
      header: 'Airports',
      numeric: true,
      align: 'right',
      secondary: true,
      render: (row) => row.airportCount,
    },
    {
      key: 'actions',
      header: 'Governance',
      widthClass: 'w-[320px]',
      render: (row) => (
        <div className="space-y-2">
          {row.status === 'pending' && (
            <>
              <ActionButton
                action={approveProviderAction}
                fields={{ providerCompanyId: row.id }}
                label="Approve"
                pendingLabel="Approving…"
                variant="primary"
                confirm={{
                  title: `Approve ${row.displayName}?`,
                  body: 'They become eligible for matching immediately and can start receiving offers. This is recorded against your name.',
                  confirmLabel: 'Approve',
                }}
              />
              <ReasonedAction
                action={rejectProviderAction}
                fields={{ providerCompanyId: row.id }}
                trigger="Reject"
                title={`Reject ${row.displayName}`}
                consequence="The registration is refused. They keep their account and can see the reason, but will never be offered work."
                reasonLabel="Why is this registration refused?"
                reasonPlaceholder="No certificate of insurance supplied."
                confirmLabel="Reject registration"
              />
            </>
          )}

          {row.status === 'approved' && (
            <>
              <InlineValueForm
                action={setProviderRankAction}
                fields={{ providerCompanyId: row.id }}
                name="rank"
                type="number"
                label="Rank"
                defaultValue={String(row.rank)}
                submitLabel="Save"
                hint="1 is best"
              />
              <ReasonedAction
                action={suspendProviderAction}
                fields={{ providerCompanyId: row.id }}
                trigger="Suspend"
                title={`Suspend ${row.displayName}?`}
                consequence="Every live offer to them is withdrawn and those services re-match immediately. They keep their account and can see why."
                reasonLabel="Why are they being suspended?"
                reasonPlaceholder="Certificate of insurance lapsed on renewal."
                confirmLabel="Suspend provider"
              />
            </>
          )}

          {row.status === 'suspended' && (
            <ActionButton
              action={approveProviderAction}
              fields={{ providerCompanyId: row.id }}
              label="Reinstate"
              pendingLabel="Reinstating…"
              variant="primary"
              confirm={{
                title: `Reinstate ${row.displayName}?`,
                body: 'The suspension is lifted and they become eligible for matching again.',
                confirmLabel: 'Reinstate',
              }}
            />
          )}

          {row.status === 'rejected' && (
            <span className="text-[12px] text-text-secondary">Registration refused.</span>
          )}
        </div>
      ),
    },
    {
      key: 'insurance',
      header: 'Insurance to',
      numeric: true,
      secondary: true,
      render: (row) => (
        <span className={row.insuranceExpiresAt === null ? 'text-text-secondary/70 italic' : ''}>
          {row.insuranceExpiresAt ?? 'not recorded'}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Provider approvals"
        description="Every registered company, its governance state and what it covers. Approving, suspending and ranking are live — each writes an audit event against your name."
      />

      {(pending.length > 0 || suspended.length > 0) && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2">
          {pending.length > 0 && (
            <Card className="border-warning/30 bg-warning-wash p-4">
              <p className="text-[13px] font-semibold text-warning">
                {pending.length} awaiting approval
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                {pending.map((row) => row.displayName).join(', ')} — these never appear as an
                eligible provider until approved.
              </p>
            </Card>
          )}
          {suspended.length > 0 && (
            <Card className="border-danger/30 bg-danger-wash p-4">
              <p className="text-[13px] font-semibold text-danger">
                {suspended.length} suspended
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                {suspended.map((row) => row.displayName).join(', ')} — coverage is retained but
                the matching engine rejects them on status.
              </p>
            </Card>
          )}
        </div>
      )}

      <Card>
        <CardHeader
          title={`${rows.length} provider companies`}
          description="Ordered by governance attention, then platform rank."
        />
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          emptyTitle="No providers registered"
          emptyDescription="Companies appear here as they register or are created by an administrator."
          caption="Registered provider companies"
        />
      </Card>
    </>
  );
}
