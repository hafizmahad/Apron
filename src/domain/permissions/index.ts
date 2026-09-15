import type { UserRole } from '@/db/schema/enums';

/**
 * The permission model (CLAUDE.md §5).
 *
 * PURE functions over an explicit `Actor`. No database, no cookies, no request object —
 * which is what lets every rule be unit-tested exhaustively and makes it impossible for a
 * check to "pass" because some ambient state happened to be set.
 *
 * Two rules the rest of the codebase depends on:
 *
 *  1. **Never authorise by route visibility.** Hiding a link is presentation. Every
 *     mutation and every sensitive read calls one of these functions server-side.
 *  2. **Tenancy is checked separately from capability.** `can()` answers "may this ROLE do
 *     this?"; the `*ScopedTo*` helpers answer "may this actor touch THIS row?". A provider
 *     dispatcher may acknowledge offers (capability) but only their own company's
 *     (tenancy). Both must pass.
 */

export interface Actor {
  readonly userId: string;
  readonly role: UserRole;
  readonly providerCompanyId: string | null;
  readonly clientOrganizationId: string | null;
  readonly status: 'active' | 'suspended' | 'invited';
}

/**
 * Every capability the platform gates on. Adding one here forces every role's entry in
 * the matrix below to be filled in, so a new capability can never be silently granted to
 * everyone or to no one.
 */
export const permissions = Object.freeze([
  // --- requests ---
  'request.create',
  'request.view.any',
  'request.view.own_client',
  'request.view.offered_to_own_provider',
  'request.update',
  'request.cancel',
  'request.override_provider',
  'request.force_status',
  'request.view_passenger_contacts',
  'request.release_contacts_to_provider',
  'request.view_decision_trace',
  'request.use_research_assistant',

  // --- offers and assignments ---
  'offer.acknowledge',
  'offer.decline',
  'assignment.create',
  'assignment.release',
  'assignment.view.any',
  'assignment.view.own_provider',

  // --- provider self-management ---
  'provider.view.own',
  'provider.manage.own_profile',
  'provider.manage.own_coverage',
  'provider.manage.own_resources',
  'provider.manage.own_users',

  // --- platform governance ---
  'provider.view.any',
  'provider.approve',
  'provider.suspend',
  'provider.set_rank',
  'catalogue.manage',
  'registry.manage',
  'user.manage',
  'settings.manage',
  'feature_flag.manage',
  'audit.view',
  'ai.view_observability',

  // --- messaging ---
  'message.send.internal',
  'message.send.provider_thread',
  'message.view.any',
] as const);

export type Permission = (typeof permissions)[number];

/**
 * The full RBAC matrix, exhaustive by construction.
 *
 * Deliberate choices worth calling out:
 *
 *  - Operations cannot approve, suspend or rank providers, manage the catalogue/registry,
 *    manage users, change settings or flip feature flags. That is platform governance and
 *    belongs to Admin (CLAUDE.md §5: "Operations ... cannot silently change platform
 *    governance data").
 *  - `provider_staff` is read-and-assign only: they may see their company's work and
 *    assign resources, but cannot acknowledge or decline an offer, and cannot change the
 *    company profile or manage users. A provider cannot approve their own company —
 *    no provider role holds `provider.approve` at all.
 *  - `client` sees exactly one thing: their own organisation's requests. No trace, no
 *    provider identity beyond what the request surface exposes, no research assistant.
 */
const MATRIX: Record<UserRole, ReadonlySet<Permission>> = {
  platform_admin: new Set<Permission>([...permissions]),

  operations_manager: new Set<Permission>([
    'request.create',
    'request.view.any',
    'request.update',
    'request.cancel',
    'request.override_provider',
    'request.force_status',
    'request.view_passenger_contacts',
    'request.release_contacts_to_provider',
    'request.view_decision_trace',
    'request.use_research_assistant',
    'assignment.create',
    'assignment.release',
    'assignment.view.any',
    'provider.view.any',
    'audit.view',
    'message.send.internal',
    'message.send.provider_thread',
    'message.view.any',
  ]),

  operations_agent: new Set<Permission>([
    'request.create',
    'request.view.any',
    'request.update',
    'request.view_passenger_contacts',
    'request.view_decision_trace',
    'request.use_research_assistant',
    'assignment.view.any',
    'provider.view.any',
    'message.send.internal',
    'message.send.provider_thread',
    'message.view.any',
    // Deliberately absent: cancel, override, force_status, release_contacts,
    // assignment.create/release. Those are manager-level interventions.
  ]),

  provider_admin: new Set<Permission>([
    'request.view.offered_to_own_provider',
    'offer.acknowledge',
    'offer.decline',
    'assignment.create',
    'assignment.release',
    'assignment.view.own_provider',
    'provider.view.own',
    'provider.manage.own_profile',
    'provider.manage.own_coverage',
    'provider.manage.own_resources',
    'provider.manage.own_users',
    'message.send.provider_thread',
  ]),

  provider_dispatcher: new Set<Permission>([
    'request.view.offered_to_own_provider',
    'offer.acknowledge',
    'offer.decline',
    'assignment.create',
    'assignment.release',
    'assignment.view.own_provider',
    'provider.view.own',
    'provider.manage.own_resources',
    'message.send.provider_thread',
  ]),

  provider_staff: new Set<Permission>([
    'request.view.offered_to_own_provider',
    'assignment.view.own_provider',
    'provider.view.own',
  ]),

  client: new Set<Permission>(['request.create', 'request.view.own_client']),
};

/** Capability check. A suspended or invited account holds no permissions at all. */
export function can(actor: Actor, permission: Permission): boolean {
  if (actor.status !== 'active') return false;
  return MATRIX[actor.role].has(permission);
}

/** Every permission a role holds — used by the Admin RBAC screen and by tests. */
export function permissionsFor(role: UserRole): Permission[] {
  return [...MATRIX[role]].sort();
}

// ---------------------------------------------------------------------------
// role predicates
// ---------------------------------------------------------------------------

export function isPlatformAdmin(actor: Actor): boolean {
  return actor.role === 'platform_admin';
}

export function isOperations(actor: Actor): boolean {
  return actor.role === 'operations_manager' || actor.role === 'operations_agent';
}

export function isProviderUser(actor: Actor): boolean {
  return (
    actor.role === 'provider_admin' ||
    actor.role === 'provider_dispatcher' ||
    actor.role === 'provider_staff'
  );
}

export function isClient(actor: Actor): boolean {
  return actor.role === 'client';
}

/** Which portal an actor belongs in. Used for post-login routing and layout guards. */
export function homePortal(actor: Actor): '/admin' | '/ops' | '/provider' | '/client' {
  if (isPlatformAdmin(actor)) return '/admin';
  if (isOperations(actor)) return '/ops';
  if (isProviderUser(actor)) return '/provider';
  return '/client';
}

// ---------------------------------------------------------------------------
// tenancy
//
// These answer "may this actor touch THIS row?" and are always checked in addition to
// `can()`, never instead of it.
// ---------------------------------------------------------------------------

/** True when the actor may act on data belonging to `providerCompanyId`. */
export function isScopedToProvider(actor: Actor, providerCompanyId: string): boolean {
  if (actor.status !== 'active') return false;
  if (isPlatformAdmin(actor)) return true;
  if (isOperations(actor)) return true;
  if (!isProviderUser(actor)) return false;
  // A provider user's own company, and nothing else. This is the Journey G defence.
  return actor.providerCompanyId === providerCompanyId;
}

/** True when the actor may act on data belonging to `clientOrganizationId`. */
export function isScopedToClient(actor: Actor, clientOrganizationId: string): boolean {
  if (actor.status !== 'active') return false;
  if (isPlatformAdmin(actor) || isOperations(actor)) return true;
  if (!isClient(actor)) return false;
  return actor.clientOrganizationId === clientOrganizationId;
}

export interface RequestScope {
  readonly clientOrganizationId: string;
  /** Provider companies currently holding an offer or assignment on any line. */
  readonly involvedProviderCompanyIds: readonly string[];
}

/**
 * Whether the actor may read a request at all.
 *
 * A provider sees a request only while their company is actually involved in it — an
 * offer they hold or an assignment they own. Once their offer is withdrawn the request
 * leaves their queue, which is why the caller supplies the *current* involvement rather
 * than a historical one.
 */
export function canViewRequest(actor: Actor, scope: RequestScope): boolean {
  if (actor.status !== 'active') return false;

  if (can(actor, 'request.view.any')) return true;

  if (can(actor, 'request.view.own_client')) {
    return actor.clientOrganizationId === scope.clientOrganizationId;
  }

  if (can(actor, 'request.view.offered_to_own_provider')) {
    const company = actor.providerCompanyId;
    return company !== null && scope.involvedProviderCompanyIds.includes(company);
  }

  return false;
}

/**
 * Whether passenger and crew contact details may be revealed.
 *
 * Operations and Admin always may. A provider may only once their own line has been
 * acknowledged, or when operations has explicitly released the details early — the
 * default is concealment (CLAUDE.md §5, §13).
 */
export function canViewPassengerContacts(
  actor: Actor,
  scope: RequestScope & {
    readonly acknowledgedByProviderCompanyIds: readonly string[];
    readonly contactsReleasedToProviderCompanyIds: readonly string[];
  },
): boolean {
  if (actor.status !== 'active') return false;
  if (can(actor, 'request.view_passenger_contacts')) return true;

  if (isProviderUser(actor)) {
    const company = actor.providerCompanyId;
    if (company === null) return false;
    if (!canViewRequest(actor, scope)) return false;
    return (
      scope.acknowledgedByProviderCompanyIds.includes(company) ||
      scope.contactsReleasedToProviderCompanyIds.includes(company)
    );
  }

  // A client sees their own passengers: they supplied them.
  if (isClient(actor)) {
    return actor.clientOrganizationId === scope.clientOrganizationId;
  }

  return false;
}

/** Whether the actor may act on an offer held by `providerCompanyId`. */
export function canActOnOffer(
  actor: Actor,
  action: 'acknowledge' | 'decline',
  providerCompanyId: string,
): boolean {
  const permission: Permission = action === 'acknowledge' ? 'offer.acknowledge' : 'offer.decline';
  if (!can(actor, permission)) return false;
  // Operations must not acknowledge on a provider's behalf; that would fake a commitment
  // the provider never made. Only the provider's own users may.
  if (!isProviderUser(actor)) return false;
  return actor.providerCompanyId === providerCompanyId;
}

/** Whether the actor may commit concrete resources for `providerCompanyId`. */
export function canAssignResources(actor: Actor, providerCompanyId: string): boolean {
  if (!can(actor, 'assignment.create')) return false;
  if (isProviderUser(actor)) return actor.providerCompanyId === providerCompanyId;
  // Operations managers and admins may assign on a provider's behalf during an
  // intervention; the audit event records who actually did it.
  return isOperations(actor) || isPlatformAdmin(actor);
}

/**
 * A provider must never be able to approve their own company. No provider role holds
 * `provider.approve`, and this guard makes the intent explicit at the call site as well.
 */
export function canApproveProvider(actor: Actor, providerCompanyId: string): boolean {
  if (!can(actor, 'provider.approve')) return false;
  if (actor.providerCompanyId === providerCompanyId) return false;
  return true;
}

/** Actions that require a written reason before they are permitted to proceed (§5). */
/**
 * Actions that cannot be recorded without a reason (CLAUDE.md §5).
 *
 * This list MIRRORS the `audit_events_reason_required` check constraint in migration
 * 0002 — deliberately, and it is tested against it. The database is the enforcement; this
 * is the early, well-worded rejection in front of it.
 *
 * It previously held names nobody emits (`request.override_provider` where the service
 * actually writes `request_line.override_provider`), so the pre-check never fired and a
 * reasonless override reached the database to die there on a constraint violation. The
 * rule still held — it just reported itself as a SQL error instead of a clear one.
 */
export const REASON_REQUIRED_ACTIONS = Object.freeze([
  'request_line.override_provider',
  'request_line.force_status',
  'request.cancel',
  'provider_company.suspend',
  'provider_company.reject',
  'assignment.force_release',
  'user.suspend',
] as const);

export type ReasonRequiredAction = (typeof REASON_REQUIRED_ACTIONS)[number];

export function requiresReason(action: string): action is ReasonRequiredAction {
  return (REASON_REQUIRED_ACTIONS as readonly string[]).includes(action);
}
