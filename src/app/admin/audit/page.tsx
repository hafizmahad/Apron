import { desc, sql } from 'drizzle-orm';
import { requirePermission } from '@/auth/context';
import { auditActionLabel, entityTypeLabel, userRoleLabel } from '@/lib/domain-labels';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/data-table';
import { getDb } from '@/db/client';
import { auditEvents, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { REASON_REQUIRED_ACTIONS } from '@/domain/permissions';

export const dynamic = 'force-dynamic';

/**
 * Audit explorer (CLAUDE.md §5, §14).
 *
 * Every meaningful write lands in this table with actor, role, before/after and the
 * correlation id that ties it back to the HTTP request or job that caused it. The
 * database independently refuses to record an override, cancellation or suspension
 * without a reason, so a row here can be trusted to carry one.
 *
 * Filtering and correlation-id drill-down are not built: the explorer shows the most
 * recent events in full. For a targeted question the correlation id in each row ties an
 * event to its logs, which is the path an investigation actually takes.
 */

interface AuditRow {
  readonly id: number;
  readonly occurredAt: Date;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorLabel: string;
  readonly actorRole: string | null;
  readonly actorName: string | null;
  readonly reason: string | null;
  readonly correlationId: string | null;
}

export default async function AdminAuditPage() {
  await requirePermission('audit.view');

  const db = getDb();

  const rows = await db
    .select({
      id: auditEvents.id,
      occurredAt: auditEvents.occurredAt,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      actorLabel: auditEvents.actorLabel,
      actorRole: auditEvents.actorRole,
      actorName: users.fullName,
      reason: auditEvents.reason,
      correlationId: auditEvents.correlationId,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(200);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      distinctActions: sql<number>`count(distinct ${auditEvents.action})::int`,
      withReason: sql<number>`count(*) filter (where ${auditEvents.reason} is not null)::int`,
    })
    .from(auditEvents);

  const columns: readonly Column<AuditRow>[] = [
    {
      key: 'when',
      header: 'When (UTC)',
      numeric: true,
      render: (row) => row.occurredAt.toISOString().slice(0, 19).replace('T', ' '),
    },
    {
      key: 'action',
      header: 'Action',
      render: (row) => (
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-text-primary">
            {auditActionLabel(row.action)}
          </p>
          {/* The raw action is the thing a support thread or a log query cites, so it stays
              — as secondary metadata rather than as the row's headline. */}
          <p className="mt-0.5 truncate font-mono text-[11px] text-text-secondary/80">
            {row.action}
          </p>
        </div>
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-text-primary">{row.actorName ?? row.actorLabel}</p>
          {row.actorRole !== null && (
            <p className="mt-0.5 text-[12px] text-text-secondary">{userRoleLabel(row.actorRole)}</p>
          )}
        </div>
      ),
    },
    {
      key: 'entity',
      header: 'Entity',
      secondary: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="text-text-secondary">{entityTypeLabel(row.entityType)}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-text-secondary">{row.entityId}</p>
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      secondary: true,
      render: (row) =>
        row.reason === null ? (
          <span className="text-text-secondary/60">—</span>
        ) : (
          <span className="text-text-primary">{row.reason}</span>
        ),
    },
    {
      key: 'correlation',
      header: 'Correlation',
      secondary: true,
      render: (row) => (
        <span className="font-mono text-[11px] text-text-secondary">
          {row.correlationId?.slice(0, 8) ?? '—'}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Audit explorer"
        description="Every meaningful write, with who did it and why. Administrators cannot bypass audit logging."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.12em] text-text-secondary">Events</p>
          <p className="tabular mt-1 text-2xl text-text-primary">{totals?.total ?? 0}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.12em] text-text-secondary">
            Distinct actions
          </p>
          <p className="tabular mt-1 text-2xl text-text-primary">{totals?.distinctActions ?? 0}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.12em] text-text-secondary">
            Carrying a reason
          </p>
          <p className="tabular mt-1 text-2xl text-text-primary">{totals?.withReason ?? 0}</p>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader
          title="Actions that cannot proceed without a reason"
          description="Enforced by a database CHECK constraint, not by application code alone."
        />
        <div className="flex flex-wrap gap-2 p-5">
          {REASON_REQUIRED_ACTIONS.map((action) => (
            <Badge key={action} tone="accent">
              {auditActionLabel(action)}
            </Badge>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Recent events"
          description="Newest first, most recent 200."
        />
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => String(row.id)}
          emptyTitle="No audit events yet"
          emptyDescription="Signing in, creating a request or changing governance data all write here."
          caption="Audit events"
        />
      </Card>
    </>
  );
}
