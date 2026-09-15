import Link from 'next/link';
import { requestStatusLabel } from '@/lib/domain-labels';
import { Badge, Card, CardHeader, DataPoint, EmptyState, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/data-table';
import { requirePermission } from '@/auth/context';
import { loadRequestOversight, type RequestOversightRow } from '@/db/queries/operations';
import type { RequestStatus } from '@/db/schema/enums';

export const dynamic = 'force-dynamic';

/**
 * Request oversight (CLAUDE.md §14).
 *
 * Operations asks "is this trip covered". Admin asks a different question: **is this
 * platform being operated properly** — how often did a person overrule the engine, how
 * often did the model's choice fail verification, how many offers were declined or left to
 * expire, and is there a trail for all of it.
 *
 * So this is not a second copy of the operations request list. It is the governance view:
 * every request ordered newest first, with the counts that answer that question, and the
 * exceptions surfaced above the table rather than buried in it.
 *
 * Administrators do not bypass audit logging — opening a request from here reads the same
 * trace anyone else sees, and the reads are recorded the same way.
 */

const STATUS_TONE: Record<RequestStatus, BadgeTone> = {
  draft: 'neutral',
  awaiting_confirmation: 'neutral',
  sent: 'info',
  sourcing: 'info',
  partial: 'warning',
  confirmed: 'success',
  in_progress: 'success',
  completed: 'neutral',
  cancelled: 'neutral',
  failed: 'danger',
};

export default async function AdminRequestsPage() {
  await requirePermission('request.view.any');

  const rows = await loadRequestOversight({ limit: 200 });

  const totals = rows.reduce(
    (accumulator, row) => ({
      overrides: accumulator.overrides + row.overrideCount,
      failedLines: accumulator.failedLines + row.failedLines,
      unverified: accumulator.unverified + row.aiUnverified,
      aiSelections: accumulator.aiSelections + row.aiSelections,
      declined: accumulator.declined + row.declinedOffers,
      expired: accumulator.expired + row.expiredOffers,
      rematches: accumulator.rematches + row.totalRematches,
    }),
    {
      overrides: 0,
      failedLines: 0,
      unverified: 0,
      aiSelections: 0,
      declined: 0,
      expired: 0,
      rematches: 0,
    },
  );

  const needingAttention = rows.filter(
    (row) => row.failedLines > 0 || row.aiUnverified > 0 || row.overrideCount > 0,
  );

  const columns: readonly Column<RequestOversightRow>[] = [
    {
      key: 'reference',
      header: 'Request',
      render: (row) => (
        <div className="min-w-0">
          <Link
            href={`/ops/requests/${row.id}`}
            className="font-medium text-accent hover:underline"
          >
            {row.reference}
          </Link>
          <p className="mt-0.5 truncate text-[12px] text-text-secondary">{row.clientName}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={STATUS_TONE[row.status]}>{requestStatusLabel(row.status)}</Badge>,
    },
    {
      key: 'airport',
      header: 'Airport',
      secondary: true,
      render: (row) => <span className="text-text-secondary">{row.airportLabel}</span>,
    },
    {
      key: 'created',
      header: 'Created',
      numeric: true,
      secondary: true,
      render: (row) => (
        <span className="text-text-secondary">
          {row.createdAt.toISOString().slice(0, 16).replace('T', ' ')} · {row.createdVia}
        </span>
      ),
    },
    {
      key: 'services',
      header: 'Services',
      numeric: true,
      align: 'right',
      render: (row) => (
        <span className={row.failedLines > 0 ? 'font-medium text-danger' : ''}>
          {row.failedLines > 0
            ? `${String(row.failedLines)} failed of ${String(row.lineCount)}`
            : row.lineCount}
        </span>
      ),
    },
    {
      key: 'offers',
      header: 'Offers',
      numeric: true,
      align: 'right',
      secondary: true,
      render: (row) => (
        <span className="text-text-secondary">
          {row.offerCount}
          {row.declinedOffers + row.expiredOffers > 0 && (
            <span className="text-warning">
              {' '}
              ({row.declinedOffers > 0 ? `${String(row.declinedOffers)} declined` : ''}
              {row.declinedOffers > 0 && row.expiredOffers > 0 ? ', ' : ''}
              {row.expiredOffers > 0 ? `${String(row.expiredOffers)} expired` : ''})
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'ai',
      header: 'Model',
      numeric: true,
      align: 'right',
      render: (row) =>
        row.aiSelections === 0 ? (
          <span className="text-text-secondary/70 italic">not consulted</span>
        ) : row.aiUnverified > 0 ? (
          <Badge tone="danger">
            {row.aiUnverified} of {row.aiSelections} unverified
          </Badge>
        ) : (
          <span className="text-text-secondary">{row.aiSelections} verified</span>
        ),
    },
    {
      key: 'overrides',
      header: 'Overrides',
      numeric: true,
      align: 'right',
      render: (row) =>
        row.overrideCount === 0 ? (
          <span className="text-text-secondary">—</span>
        ) : (
          <Badge tone="warning">{row.overrideCount}</Badge>
        ),
    },
    {
      key: 'audit',
      header: 'Audit events',
      numeric: true,
      align: 'right',
      secondary: true,
      render: (row) => row.auditEventCount,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Request oversight"
        description="Every request with its complete deterministic and AI decision trace. Administrators see overrides, failures and unverified model choices — and do not bypass audit logging."
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No requests yet"
            description="Once a request is composed — from the client portal or by operations — it appears here with its full trace, every provider offer, every override and every audit event. Nothing is hidden from this view."
          />
        </Card>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader
              title="Across the last 200 requests"
              description="The numbers that answer whether the platform is being operated properly, rather than whether a trip is covered."
            />
            <dl className="grid gap-4 p-5 sm:grid-cols-3 lg:grid-cols-6">
              <DataPoint label="Model selections" numeric>
                {totals.aiSelections}
              </DataPoint>
              <DataPoint label="Unverified" numeric>
                <span className={totals.unverified > 0 ? 'text-danger' : ''}>
                  {totals.unverified}
                </span>
              </DataPoint>
              <DataPoint label="Manual overrides" numeric>
                <span className={totals.overrides > 0 ? 'text-warning' : ''}>
                  {totals.overrides}
                </span>
              </DataPoint>
              <DataPoint label="Services failed" numeric>
                <span className={totals.failedLines > 0 ? 'text-danger' : ''}>
                  {totals.failedLines}
                </span>
              </DataPoint>
              <DataPoint label="Declined offers" numeric>
                {totals.declined}
              </DataPoint>
              <DataPoint label="Re-matches" numeric>
                {totals.rematches}
              </DataPoint>
            </dl>
          </Card>

          {needingAttention.length > 0 && (
            <Card className="mb-6 border-warning/30 bg-warning-wash">
              <div className="p-5">
                <p className="text-[13px] font-semibold text-warning">
                  {needingAttention.length} request
                  {needingAttention.length === 1 ? '' : 's'} carry a failure, an override or an
                  unverified model choice
                </p>
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {needingAttention.slice(0, 12).map((row) => (
                    <li key={row.id} className="text-[12px]">
                      <Link
                        href={`/ops/requests/${row.id}`}
                        className="font-medium text-accent hover:underline"
                      >
                        {row.reference}
                      </Link>
                      <span className="text-text-secondary">
                        {' '}
                        —{' '}
                        {[
                          row.failedLines > 0 ? `${String(row.failedLines)} failed` : null,
                          row.overrideCount > 0 ? `${String(row.overrideCount)} override` : null,
                          row.aiUnverified > 0 ? `${String(row.aiUnverified)} unverified` : null,
                        ]
                          .filter((part): part is string => part !== null)
                          .join(', ')}
                      </span>
                    </li>
                  ))}
                  {needingAttention.length > 12 && (
                    <li className="text-[12px] text-text-secondary">
                      +{needingAttention.length - 12} more in the table below
                    </li>
                  )}
                </ul>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader
              title={`${String(rows.length)} requests`}
              description="Newest first. Open one to read its full decision trace, offer history and audit trail."
            />
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              emptyTitle="No requests"
              emptyDescription="Requests appear here as they are created."
              caption="Every request, with its governance counts"
            />
          </Card>
        </>
      )}
    </>
  );
}
