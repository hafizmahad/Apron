import { asc, eq } from 'drizzle-orm';
import { userRoleLabel, userStatusLabel } from '@/lib/domain-labels';
import { requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/data-table';
import { getDb } from '@/db/client';
import { providerCompanies, users } from '@/db/schema';
import { permissionsFor } from '@/domain/permissions';
import type { UserRole, UserStatus } from '@/db/schema/enums';
import { ApronError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/**
 * The provider's own team (CLAUDE.md §13).
 *
 * Scoped to the session's company, like every other page in this portal. The permission
 * summary is included because "why can't Leo acknowledge this offer?" is a real question
 * a provider admin asks, and the honest answer is visible here rather than in a support
 * ticket.
 */

const ROLE_TONE: Record<string, BadgeTone> = {
  provider_admin: 'accent',
  provider_dispatcher: 'success',
  provider_staff: 'neutral',
};

const STATUS_TONE: Record<UserStatus, BadgeTone> = {
  active: 'success',
  suspended: 'danger',
  invited: 'warning',
};

interface TeamRow {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly lastLoginAt: Date | null;
  readonly canAcknowledge: boolean;
  readonly canAssign: boolean;
}

export default async function ProviderTeamPage() {
  const actor = await requirePermission('provider.view.own');
  const companyId = actor.providerCompanyId;

  if (companyId === null) {
    throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
  }

  const db = getDb();

  const [company] = await db
    .select({
      displayName: providerCompanies.displayName,
      legalName: providerCompanies.legalName,
      status: providerCompanies.status,
      rank: providerCompanies.rank,
      dispatchEmail: providerCompanies.dispatchEmail,
      dispatchPhone: providerCompanies.dispatchPhone,
      insuranceExpiresAt: providerCompanies.insuranceExpiresAt,
      suspensionReason: providerCompanies.suspensionReason,
    })
    .from(providerCompanies)
    .where(eq(providerCompanies.id, companyId))
    .limit(1);

  const rows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      phone: users.phone,
      role: users.role,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.providerCompanyId, companyId))
    .orderBy(asc(users.role), asc(users.fullName), asc(users.id));

  const data: TeamRow[] = rows.map((row) => {
    const held = new Set(permissionsFor(row.role));
    return {
      ...row,
      canAcknowledge: row.status === 'active' && held.has('offer.acknowledge'),
      canAssign: row.status === 'active' && held.has('assignment.create'),
    };
  });

  const columns: readonly Column<TeamRow>[] = [
    {
      key: 'person',
      header: 'Person',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-text-primary">{row.fullName}</p>
          <p className="mt-0.5 truncate text-[12px] text-text-secondary">{row.email}</p>
        </div>
      ),
    },
    { key: 'role', header: 'Role', render: (row) => <Badge tone={ROLE_TONE[row.role] ?? 'neutral'}>{userRoleLabel(row.role)}</Badge> },
    {
      key: 'can',
      header: 'Can do',
      render: (row) => (
        <span className="text-[12px] text-text-secondary">
          {row.canAcknowledge ? 'acknowledge · ' : ''}
          {row.canAssign ? 'assign resources' : ''}
          {!row.canAcknowledge && !row.canAssign ? 'view only' : ''}
        </span>
      ),
    },
    { key: 'phone', header: 'Phone', numeric: true, secondary: true, render: (row) => row.phone ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={STATUS_TONE[row.status]}>{userStatusLabel(row.status)}</Badge>,
    },
    {
      key: 'lastLogin',
      header: 'Last sign-in',
      numeric: true,
      secondary: true,
      render: (row) =>
        row.lastLoginAt === null ? (
          <span className="text-text-secondary/70 italic">never</span>
        ) : (
          row.lastLoginAt.toISOString().slice(0, 16).replace('T', ' ')
        ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Company"
        title="Team"
        description="Who in your company can act on offers, and who can only look. Accounts are created and re-roled by the Apron administrator — contact operations to add someone."
      />

      {company !== undefined && (
        <Card className="mb-4">
          <CardHeader
            title={company.displayName}
            description={company.legalName}
            action={
              <Badge
                tone={
                  company.status === 'approved'
                    ? 'success'
                    : company.status === 'pending'
                      ? 'warning'
                      : 'danger'
                }
              >
                {company.status}
              </Badge>
            }
          />
          <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
            {[
              { label: 'Platform rank', value: String(company.rank) },
              { label: 'Dispatch email', value: company.dispatchEmail ?? 'not set' },
              { label: 'Dispatch phone', value: company.dispatchPhone ?? 'not set' },
              { label: 'Insurance to', value: company.insuranceExpiresAt ?? 'not recorded' },
            ].map((item) => (
              <div key={item.label} className="bg-surface px-4 py-3">
                <dt className="text-[11px] uppercase tracking-[0.1em] text-text-secondary">
                  {item.label}
                </dt>
                <dd className="mt-0.5 truncate text-[13px] text-text-primary">{item.value}</dd>
              </div>
            ))}
          </dl>

          {company.status === 'pending' && (
            <p className="border-t border-border bg-warning-wash px-5 py-3 text-[13px] text-warning">
              Your company is awaiting platform approval. You can prepare your resources and
              coverage now, but no request will be offered to you until an administrator
              approves the company.
            </p>
          )}
          {company.status === 'suspended' && company.suspensionReason !== null && (
            <p className="border-t border-border bg-danger-wash px-5 py-3 text-[13px] text-danger">
              Suspended: {company.suspensionReason}
            </p>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title={`${data.length} team members`} />
        <DataTable
          columns={columns}
          rows={data}
          rowKey={(row) => row.id}
          emptyTitle="No team members"
          emptyDescription="Your company has no user accounts yet."
          caption="Provider team"
        />
      </Card>
    </>
  );
}
