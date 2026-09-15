import { asc, eq, sql } from 'drizzle-orm';
import { qualified } from '@/db/sql';
import { requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/data-table';
import { getDb } from '@/db/client';
import { airports, providerCompanies, providerCoverage, serviceCategories } from '@/db/schema';
import type { ProviderCompanyStatus } from '@/db/schema/enums';

export const dynamic = 'force-dynamic';

/**
 * The operations view of the provider network (CLAUDE.md §12).
 *
 * Answers the question operations actually asks before a shift: who can we call, for what,
 * where, and how much of it can they take at once? Capacity and lead time are the same
 * numbers the matching engine reads, so what is shown here explains what the engine does.
 */

const STATUS_TONE: Record<ProviderCompanyStatus, BadgeTone> = {
  approved: 'success',
  pending: 'warning',
  suspended: 'danger',
  rejected: 'neutral',
};

interface CoverageRow {
  readonly id: string;
  readonly providerName: string;
  readonly providerStatus: ProviderCompanyStatus;
  readonly providerRank: number;
  readonly serviceName: string;
  readonly airportLabel: string;
  readonly scope: string;
  readonly totalCapacity: number;
  readonly leadTimeMinutes: number;
  readonly is247: boolean;
  readonly deskHours: string;
  readonly active: boolean;
}

export default async function OperationsProvidersPage() {
  await requirePermission('provider.view.any');

  const db = getDb();

  const rows = await db
    .select({
      id: providerCoverage.id,
      providerName: providerCompanies.displayName,
      providerStatus: providerCompanies.status,
      providerRank: providerCompanies.rank,
      serviceName: serviceCategories.name,
      airportIcao: airports.icao,
      airportName: airports.name,
      scope: providerCoverage.scope,
      totalCapacity: providerCoverage.totalCapacity,
      leadTimeMinutes: providerCoverage.leadTimeMinutes,
      is247: providerCoverage.is247,
      active: providerCoverage.active,
      hourCount: sql<number>`(
        select count(*)::int from provider_coverage_hours h where h.coverage_id = ${qualified(providerCoverage.id)}
      )`,
    })
    .from(providerCoverage)
    .innerJoin(providerCompanies, eq(providerCompanies.id, providerCoverage.providerCompanyId))
    .innerJoin(serviceCategories, eq(serviceCategories.id, providerCoverage.serviceCategoryId))
    .innerJoin(airports, eq(airports.id, providerCoverage.airportId))
    .orderBy(
      asc(airports.icao),
      asc(serviceCategories.sortOrder),
      asc(providerCompanies.rank),
      asc(providerCompanies.displayName),
      asc(providerCoverage.id),
    );

  const [totals] = await db
    .select({
      approved: sql<number>`count(*) filter (where ${providerCompanies.status} = 'approved')::int`,
      unavailable: sql<number>`count(*) filter (where ${providerCompanies.status} <> 'approved')::int`,
    })
    .from(providerCompanies);

  const data: CoverageRow[] = rows.map((row) => ({
    id: row.id,
    providerName: row.providerName,
    providerStatus: row.providerStatus,
    providerRank: row.providerRank,
    serviceName: row.serviceName,
    airportLabel: row.airportIcao ?? row.airportName,
    scope: row.scope,
    totalCapacity: row.totalCapacity,
    leadTimeMinutes: row.leadTimeMinutes,
    is247: row.is247,
    active: row.active,
    deskHours: row.is247 ? '24/7' : row.hourCount === 0 ? 'never open' : `${row.hourCount} windows`,
  }));

  const columns: readonly Column<CoverageRow>[] = [
    { key: 'airport', header: 'Airport', numeric: true, render: (row) => row.airportLabel },
    { key: 'service', header: 'Service', render: (row) => row.serviceName },
    {
      key: 'provider',
      header: 'Provider',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-text-primary">{row.providerName}</p>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            rank {row.providerRank}
            {row.scope === 'fbo' ? ' · FBO-scoped' : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Eligible?',
      render: (row) =>
        row.providerStatus === 'approved' && row.active ? (
          <Badge tone="success">yes</Badge>
        ) : (
          <Badge tone={STATUS_TONE[row.providerStatus]}>
            {row.providerStatus === 'approved' ? 'coverage off' : row.providerStatus}
          </Badge>
        ),
    },
    {
      key: 'capacity',
      header: 'Capacity',
      numeric: true,
      align: 'right',
      render: (row) => row.totalCapacity,
    },
    {
      key: 'lead',
      header: 'Lead time',
      numeric: true,
      align: 'right',
      secondary: true,
      render: (row) => formatMinutes(row.leadTimeMinutes),
    },
    {
      key: 'desk',
      header: 'Desk',
      secondary: true,
      render: (row) => <span className="text-text-secondary">{row.deskHours}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Network"
        title="Providers and coverage"
        description="Who can be called, for what, where — and the exact capacity and lead-time numbers the matching engine reads."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.12em] text-text-secondary">
            Coverage rows
          </p>
          <p className="tabular mt-1 text-2xl text-text-primary">{data.length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.12em] text-text-secondary">
            Approved companies
          </p>
          <p className="tabular mt-1 text-2xl text-text-primary">{totals?.approved ?? 0}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.12em] text-text-secondary">
            Not currently usable
          </p>
          <p className="tabular mt-1 text-2xl text-text-primary">{totals?.unavailable ?? 0}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
            Pending or suspended. Their coverage rows remain, but eligibility rejects them on
            status alone.
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Coverage register"
          description="A NULL location never means everywhere — every row names one airport, and FBO-scoped rows name one handler."
        />
        <DataTable
          columns={columns}
          rows={data}
          rowKey={(row) => row.id}
          emptyTitle="No coverage recorded"
          emptyDescription="Providers declare the airports and services they cover from their own portal."
          caption="Provider coverage"
        />
      </Card>
    </>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} m`;
}
