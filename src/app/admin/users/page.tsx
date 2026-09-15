import { asc, eq, sql } from 'drizzle-orm';
import { permissionLabel, userRoleLabel, userStatusLabel } from '@/lib/domain-labels';
import { qualified } from '@/db/sql';
import { hasPermission, requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/data-table';
import {
  ReasonedAction,
  RecordForm,
  ActionButton,
  type RecordFieldSpec,
} from '@/components/ui/action-controls';
import { createUserAction, setUserStatusAction } from '@/app/admin/actions';
import { getDb } from '@/db/client';
import { clientOrganizations, providerCompanies, users } from '@/db/schema';
import { permissionsFor } from '@/domain/permissions';
import { userRoles, type UserRole, type UserStatus } from '@/db/schema/enums';

export const dynamic = 'force-dynamic';

/**
 * Users and roles (CLAUDE.md §14).
 *
 * Shows the real user base alongside the live RBAC matrix, so the permissions a role
 * actually holds can be read off rather than inferred from the UI. Creating an account and
 * suspending one are live; suspension revokes every live session in the same transaction,
 * so access ends at once rather than at the next token expiry.
 */

const ROLE_TONE: Record<UserRole, BadgeTone> = {
  platform_admin: 'accent',
  operations_manager: 'info',
  operations_agent: 'info',
  provider_admin: 'success',
  provider_dispatcher: 'success',
  provider_staff: 'neutral',
  client: 'gold',
};

const STATUS_TONE: Record<UserStatus, BadgeTone> = {
  active: 'success',
  suspended: 'danger',
  invited: 'warning',
};

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly tenant: string | null;
  readonly lastLoginAt: Date | null;
  readonly liveSessions: number;
}

export default async function AdminUsersPage() {
  await requirePermission('provider.view.any');
  const editor = await hasPermission('user.manage');

  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      providerName: providerCompanies.displayName,
      clientName: clientOrganizations.name,
      liveSessions: sql<number>`(
        select count(*)::int from sessions s
        where s.user_id = ${qualified(users.id)} and s.revoked_at is null and s.expires_at > now()
      )`,
    })
    .from(users)
    .leftJoin(providerCompanies, eq(providerCompanies.id, users.providerCompanyId))
    .leftJoin(clientOrganizations, eq(clientOrganizations.id, users.clientOrganizationId))
    .orderBy(asc(users.role), asc(users.fullName), asc(users.id));

  const [providerOptions, clientOptions] = await Promise.all([
    db
      .select({ id: providerCompanies.id, name: providerCompanies.displayName })
      .from(providerCompanies)
      .orderBy(asc(providerCompanies.displayName), asc(providerCompanies.id)),
    db
      .select({ id: clientOrganizations.id, name: clientOrganizations.name })
      .from(clientOrganizations)
      .orderBy(asc(clientOrganizations.name), asc(clientOrganizations.id)),
  ]);

  const createFields: readonly RecordFieldSpec[] = [
    { name: 'fullName', label: 'Full name', type: 'text', required: true, placeholder: 'Dana Whitfield' },
    { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'dana@example.com' },
    {
      name: 'role',
      label: 'Role',
      type: 'select',
      required: true,
      defaultValue: 'operations_agent',
      options: userRoles.map((role) => ({
        value: role,
        label: `${userRoleLabel(role)} — ${String(permissionsFor(role).length)} permissions`,
      })),
      hint: 'A provider role without a company below can see nothing; a client role without an organization likewise.',
    },
    { name: 'phone', label: 'Phone', type: 'text', placeholder: '+1 201 555 0142' },
    {
      name: 'providerCompanyId',
      label: 'Provider company',
      type: 'select',
      defaultValue: '',
      options: [
        { value: '', label: 'not a provider account' },
        ...providerOptions.map((option) => ({ value: option.id, label: option.name })),
      ],
      hint: 'Required for provider_admin, provider_dispatcher and provider_staff.',
    },
    {
      name: 'clientOrganizationId',
      label: 'Client organization',
      type: 'select',
      defaultValue: '',
      options: [
        { value: '', label: 'not a client account' },
        ...clientOptions.map((option) => ({ value: option.id, label: option.name })),
      ],
      hint: 'Required for the client role.',
    },
    {
      name: 'temporaryPassword',
      label: 'Temporary password',
      type: 'password',
      required: true,
      wide: true,
      hint: 'At least 12 characters. Hashed with argon2id before storage — it is never persisted in readable form, and it is not emailed by the platform. Pass it to the person over a channel you trust.',
    },
  ];

  const data: UserRow[] = rows.map((row) => ({
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    status: row.status,
    lastLoginAt: row.lastLoginAt,
    liveSessions: row.liveSessions,
    tenant: row.providerName ?? row.clientName ?? null,
  }));

  const columns: readonly Column<UserRow>[] = [
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
    { key: 'role', header: 'Role', render: (row) => <Badge tone={ROLE_TONE[row.role]}>{userRoleLabel(row.role)}</Badge> },
    {
      key: 'tenant',
      header: 'Scoped to',
      secondary: true,
      render: (row) => (
        <span className={row.tenant === null ? 'text-text-secondary/70 italic' : ''}>
          {row.tenant ?? 'platform-wide'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={STATUS_TONE[row.status]}>{userStatusLabel(row.status)}</Badge>,
    },
    {
      key: 'sessions',
      header: 'Live sessions',
      numeric: true,
      align: 'right',
      secondary: true,
      render: (row) => row.liveSessions,
    },
    ...(editor
      ? ([
          {
            key: 'actions',
            header: 'Account',
            widthClass: 'w-[300px]',
            render: (row: UserRow) =>
              row.status === 'suspended' ? (
                <ActionButton
                  action={setUserStatusAction}
                  fields={{ userId: row.id, status: 'active' }}
                  label="Reactivate"
                  pendingLabel="Reactivating…"
                  variant="primary"
                  confirm={{
                    title: `Reactivate ${row.fullName}?`,
                    body: 'They can sign in again with their existing password and regain every permission their role carries.',
                    confirmLabel: 'Reactivate',
                  }}
                />
              ) : (
                <ReasonedAction
                  action={setUserStatusAction}
                  fields={{ userId: row.id, status: 'suspended' }}
                  trigger="Suspend"
                  title={`Suspend ${row.fullName}?`}
                  consequence={
                    row.liveSessions > 0
                      ? `Sign-in is refused and their ${String(row.liveSessions)} live session${row.liveSessions === 1 ? ' is' : 's are'} revoked immediately — not at expiry.`
                      : 'Sign-in is refused from this moment. Their work and audit history are untouched.'
                  }
                  reasonLabel="Why is this account being suspended?"
                  reasonPlaceholder="Left the company on 12 September."
                  confirmLabel="Suspend account"
                />
              ),
          },
        ] satisfies readonly Column<UserRow>[])
      : []),
    {
      key: 'lastLogin',
      header: 'Last sign-in',
      numeric: true,
      secondary: true,
      render: (row) => (
        <span className={row.lastLoginAt === null ? 'text-text-secondary/70 italic' : ''}>
          {row.lastLoginAt === null ? 'never' : row.lastLoginAt.toISOString().slice(0, 16).replace('T', ' ')}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Users and roles"
        description="Who can do what, and the exact permission set each role holds. Every check below is enforced server-side on every request."
      />

      {editor && (
        <div className="mb-6">
          <RecordForm
            action={createUserAction}
            fields={createFields}
            trigger="Create an account"
            title="New platform account"
            description="The account is created active with the role you choose. Sign-in works straight away with the temporary password; the platform never emails it."
            submitLabel="Create account"
          />
        </div>
      )}

      <Card className="mb-6">
        <CardHeader title={`${data.length} accounts`} />
        <DataTable
          columns={columns}
          rows={data}
          rowKey={(row) => row.id}
          emptyTitle="No users"
          emptyDescription="Accounts appear here once the platform is seeded or users are invited."
          caption="Platform users"
        />
      </Card>

      <Card>
        <CardHeader
          title="Permission matrix"
          description="Exactly what each role may do. A suspended or invited account holds none of these, whatever its role."
        />
        <div className="grid gap-px bg-border sm:grid-cols-2">
          {userRoles.map((role) => {
            const held = permissionsFor(role);
            return (
              <div key={role} className="bg-surface p-4">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={ROLE_TONE[role]}>{userRoleLabel(role)}</Badge>
                  <span className="tabular text-[12px] text-text-secondary">
                    {held.length} permission{held.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ul className="mt-2 flex flex-wrap gap-1">
                  {held.map((permission) => (
                    <li
                      key={permission}
                      title={permission}
                      className="rounded bg-canvas-cool px-1.5 py-0.5 text-[11px] text-text-secondary"
                    >
                      {permissionLabel(permission)}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
