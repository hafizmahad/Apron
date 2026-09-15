import { asc, eq, sql } from 'drizzle-orm';
import { qualified } from '@/db/sql';
import { hasPermission, requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ActionButton, InlineValueForm } from '@/components/ui/action-controls';
import { updateCoverageAction } from '@/app/provider/manage-actions';
import { getDb } from '@/db/client';
import { airports, fbos, providerBlackouts, providerCoverage, serviceCategories } from '@/db/schema';
import { ApronError } from '@/lib/errors';
import { formatMinuteOfDay } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * The provider's own coverage and desk hours (CLAUDE.md §13).
 *
 * These are the numbers that decide whether this company is offered work at all, so they
 * are shown as they are actually read by the engine rather than summarised into
 * reassurance. A desk that is closed at the arrival hour means no offer, and this page
 * says so plainly.
 */

interface CoverageRow {
  readonly id: string;
  readonly serviceName: string;
  readonly airportLabel: string;
  readonly fboName: string | null;
  readonly totalCapacity: number;
  readonly leadTimeMinutes: number;
  readonly maxNoticeDays: number | null;
  readonly deskHours: string;
  readonly active: boolean;
}

export default async function ProviderCoveragePage() {
  const actor = await requirePermission('provider.view.own');
  const companyId = actor.providerCompanyId;

  if (companyId === null) {
    throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
  }

  const db = getDb();

  const rows = await db
    .select({
      id: providerCoverage.id,
      serviceName: serviceCategories.name,
      airportIcao: airports.icao,
      airportName: airports.name,
      fboName: fbos.name,
      totalCapacity: providerCoverage.totalCapacity,
      leadTimeMinutes: providerCoverage.leadTimeMinutes,
      maxNoticeDays: providerCoverage.maxNoticeDays,
      is247: providerCoverage.is247,
      active: providerCoverage.active,
      hours: sql<string>`(
        select coalesce(string_agg(h.weekday::text || ':' || h.open_minute || '-' || h.close_minute, ',' order by h.weekday), '')
        from provider_coverage_hours h where h.coverage_id = ${qualified(providerCoverage.id)}
      )`,
    })
    .from(providerCoverage)
    .innerJoin(serviceCategories, eq(serviceCategories.id, providerCoverage.serviceCategoryId))
    .innerJoin(airports, eq(airports.id, providerCoverage.airportId))
    .leftJoin(fbos, eq(fbos.id, providerCoverage.fboId))
    .where(eq(providerCoverage.providerCompanyId, companyId))
    .orderBy(asc(airports.icao), asc(serviceCategories.sortOrder), asc(providerCoverage.id));

  const blackouts = await db
    .select({
      id: providerBlackouts.id,
      startsAt: providerBlackouts.startsAt,
      endsAt: providerBlackouts.endsAt,
      reason: providerBlackouts.reason,
    })
    .from(providerBlackouts)
    .where(eq(providerBlackouts.providerCompanyId, companyId))
    .orderBy(asc(providerBlackouts.startsAt));

  const data: CoverageRow[] = rows.map((row) => ({
    id: row.id,
    serviceName: row.serviceName,
    airportLabel: row.airportIcao ?? row.airportName,
    fboName: row.fboName,
    totalCapacity: row.totalCapacity,
    leadTimeMinutes: row.leadTimeMinutes,
    maxNoticeDays: row.maxNoticeDays,
    active: row.active,
    deskHours: row.is247 ? '24/7' : summariseHours(row.hours),
  }));

  const canManage = await hasPermission('provider.manage.own_coverage');

  const columns: readonly Column<CoverageRow>[] = [
    { key: 'airport', header: 'Airport', numeric: true, render: (row) => row.airportLabel },
    {
      key: 'service',
      header: 'Service',
      render: (row) => (
        <div>
          <p className="text-text-primary">{row.serviceName}</p>
          {row.fboName !== null && (
            <p className="mt-0.5 text-[12px] text-text-secondary">only at {row.fboName}</p>
          )}
        </div>
      ),
    },
    {
      key: 'capacity',
      header: 'Concurrent capacity',
      numeric: true,
      align: 'right',
      render: (row) => row.totalCapacity,
    },
    {
      key: 'lead',
      header: 'Minimum notice',
      numeric: true,
      align: 'right',
      render: (row) => formatMinutes(row.leadTimeMinutes),
    },
    {
      key: 'notice',
      header: 'Booked up to',
      numeric: true,
      align: 'right',
      secondary: true,
      render: (row) =>
        row.maxNoticeDays === null ? (
          <span className="text-text-secondary">no limit</span>
        ) : (
          `${row.maxNoticeDays} days`
        ),
    },
    {
      key: 'desk',
      header: 'Desk hours (local)',
      secondary: true,
      render: (row) => <span className="text-text-secondary">{row.deskHours}</span>,
    },
    {
      key: 'active',
      header: 'State',
      render: (row) =>
        row.active ? <Badge tone="success">on</Badge> : <Badge tone="neutral">off</Badge>,
    },
    ...(canManage
      ? ([
          {
            key: 'manage',
            header: 'Capacity & lead time',
            widthClass: 'w-[360px]',
            render: (row: CoverageRow) => (
              <div className="space-y-2">
                <InlineValueForm
                  action={updateCoverageAction}
                  fields={{ coverageId: row.id }}
                  name="totalCapacity"
                  type="number"
                  label="Capacity"
                  defaultValue={String(row.totalCapacity)}
                  submitLabel="Save"
                  hint="jobs at once"
                />
                <InlineValueForm
                  action={updateCoverageAction}
                  fields={{ coverageId: row.id }}
                  name="leadTimeMinutes"
                  type="number"
                  label="Lead time"
                  defaultValue={String(row.leadTimeMinutes)}
                  submitLabel="Save"
                  hint="minutes"
                />
                <ActionButton
                  action={updateCoverageAction}
                  fields={{ coverageId: row.id, active: row.active ? 'false' : 'true' }}
                  label={row.active ? 'Stop taking this work' : 'Start taking this work'}
                  pendingLabel="Saving…"
                  variant="ghost"
                  confirm={
                    row.active
                      ? {
                          title: `Stop taking ${row.serviceName} at ${row.airportLabel}?`,
                          body: 'No new request for this service at this airport will reach you. Work you have already accepted is unaffected.',
                          confirmLabel: 'Stop',
                        }
                      : {
                          title: `Start taking ${row.serviceName} at ${row.airportLabel}?`,
                          body: 'Requests for this service at this airport can reach you again from the next match.',
                          confirmLabel: 'Start',
                        }
                  }
                />
              </div>
            ),
          },
        ] satisfies readonly Column<CoverageRow>[])
      : []),
  ];

  return (
    <>
      <PageHeader
        eyebrow="Company"
        title="Coverage and hours"
        description="What decides whether you are offered work. A request whose service window falls outside your desk hours, or inside your lead time, will not reach you."
      />

      <Card className="mb-4">
        <CardHeader
          title={`${data.length} coverage rows`}
          description={
            canManage
              ? 'Each row is one service at one location. Capacity and lead time are read directly by the matching engine, so a change here takes effect on the next match.'
              : 'Each row is one service at one location.'
          }
        />
        <DataTable
          columns={columns}
          rows={data}
          rowKey={(row) => row.id}
          emptyTitle="No coverage declared"
          emptyDescription="Until you declare a service at an airport, no request can reach you."
          caption="Coverage"
        />
      </Card>

      <Card>
        <CardHeader
          title={`Blackout windows (${blackouts.length})`}
          description="Periods when you cannot take work regardless of your usual hours."
        />
        {blackouts.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-text-secondary">
            None recorded. Your desk hours apply as declared above.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {blackouts.map((row) => (
              <li key={row.id} className="px-5 py-3">
                <p className="tabular text-[13px] text-text-primary">
                  {row.startsAt.toISOString().slice(0, 16).replace('T', ' ')} —{' '}
                  {row.endsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                </p>
                {row.reason !== '' && (
                  <p className="mt-0.5 text-[12px] text-text-secondary">{row.reason}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function summariseHours(encoded: string): string {
  if (encoded === '') return 'never open';

  const entries = encoded.split(',').map((part) => {
    const [weekday, range] = part.split(':');
    const [open, close] = (range ?? '').split('-');
    return { weekday: Number(weekday), open: Number(open), close: Number(close) };
  });

  const first = entries[0];
  if (first === undefined) return 'never open';

  const uniform = entries.every((entry) => entry.open === first.open && entry.close === first.close);
  const window = `${formatMinuteOfDay(first.open)}–${formatMinuteOfDay(first.close)}`;
  const crossesMidnight = first.close > 1440;

  if (uniform && entries.length === 7) {
    return crossesMidnight ? `every day ${window} (next day)` : `every day ${window}`;
  }
  if (uniform) {
    return `${entries.map((entry) => DAYS[entry.weekday] ?? '?').join(' ')} ${window}`;
  }
  return entries
    .map((entry) => `${DAYS[entry.weekday] ?? '?'} ${formatMinuteOfDay(entry.open)}–${formatMinuteOfDay(entry.close)}`)
    .join(', ');
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} m`;
}
