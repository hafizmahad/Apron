import '@/lib/server-guard';
import { eq, sql } from 'drizzle-orm';
import { withTransaction, type Transaction } from '@/db/client';
import {
  airports,
  fbos,
  featureFlags,
  platformSettings,
  providerCompanies,
  serviceCategories,
  users,
  type ProviderCompany,
  type ServiceCategory,
} from '@/db/schema';
import type { AssignmentStrategy, UserRole, UserStatus } from '@/db/schema/enums';
import type { ServiceConfigSchema } from '@/db/schema';
import { diffStates, recordAuditEvent } from '@/domain/audit';
import { revokeAllSessionsForUser } from '@/auth/session';
import { hashPassword } from '@/auth/password';
import { ApronError } from '@/lib/errors';
import { logger } from '@/lib/logging';

/**
 * Platform governance (CLAUDE.md §14, Phase 9).
 *
 * Every function here changes something an operator is accountable for, so every one of
 * them writes an audit event inside the same transaction as the change. Suspending,
 * rejecting and re-roling additionally REQUIRE a reason — enforced by the audit layer and,
 * for the suspension case, independently by a database CHECK constraint (§5).
 *
 * The actor is passed explicitly rather than read from a request context, so these are
 * callable from a script or a worker as well as from a server action, and the audit trail
 * always names someone.
 */

export interface Actor {
  readonly userId: string;
  readonly role: UserRole;
  readonly label: string;
}

// ---------------------------------------------------------------------------
// provider approvals
// ---------------------------------------------------------------------------

export async function approveProvider(
  providerCompanyId: string,
  actor: Actor,
): Promise<ProviderCompany> {
  return withTransaction(async (tx) => {
    const before = await loadProvider(providerCompanyId, tx);

    if (before.status === 'approved') return before;

    // A provider must never approve their own company. No provider role holds the
    // permission, and `canApproveProvider` refuses a self-approval — this is the last line.
    const [actorRow] = await tx
      .select({ providerCompanyId: users.providerCompanyId })
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1);

    if (actorRow?.providerCompanyId === providerCompanyId) {
      throw new ApronError('forbidden', 'You cannot approve your own company');
    }

    const [updated] = await tx
      .update(providerCompanies)
      .set({
        status: 'approved',
        approvedAt: new Date(),
        approvedByUserId: actor.userId,
        suspendedAt: null,
        suspensionReason: null,
      })
      .where(eq(providerCompanies.id, providerCompanyId))
      .returning();

    if (updated === undefined) throw new ApronError('internal', 'The provider could not be updated');

    await recordAuditEvent(
      {
        action: 'provider_company.approve',
        entityType: 'provider_company',
        entityId: providerCompanyId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        beforeState: { status: before.status },
        afterState: { status: 'approved' },
      },
      tx,
    );

    logger().info({ providerCompanyId, actor: actor.label }, 'provider approved');
    return updated;
  });
}

/**
 * Suspends a provider.
 *
 * Existing offers are WITHDRAWN rather than left hanging: a suspended company must not be
 * able to acknowledge work, and a provider staring at an offer they can no longer accept
 * is worse than one that has visibly gone. The affected lines return to matching so the
 * waterfall can continue without operations noticing manually.
 */
export async function suspendProvider(
  providerCompanyId: string,
  reason: string,
  actor: Actor,
): Promise<{ readonly provider: ProviderCompany; readonly withdrawnOffers: number }> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new ApronError('reason_required', 'Suspending a provider requires a reason');
  }

  return withTransaction(async (tx) => {
    const before = await loadProvider(providerCompanyId, tx);

    const [updated] = await tx
      .update(providerCompanies)
      .set({ status: 'suspended', suspendedAt: new Date(), suspensionReason: trimmed })
      .where(eq(providerCompanies.id, providerCompanyId))
      .returning();

    if (updated === undefined) throw new ApronError('internal', 'The provider could not be updated');

    // Withdraw live offers and free their lines.
    const withdrawn = await tx.execute<{ id: string; request_service_line_id: string }>(sql`
      update provider_offers
      set status = 'withdrawn', withdrawn_at = now(),
          withdrawn_reason = ${`Provider suspended: ${trimmed}`}
      where provider_company_id = ${providerCompanyId}::uuid and status = 'sent'
      returning id, request_service_line_id
    `);

    if (withdrawn.rows.length > 0) {
      await tx.execute(sql`
        update request_service_lines
        set status = 'rematching', current_offer_id = null, acknowledgement_deadline_utc = null
        where id = any(${sql.param(withdrawn.rows.map((row) => row.request_service_line_id))}::uuid[])
      `);
    }

    await recordAuditEvent(
      {
        action: 'provider_company.suspend',
        entityType: 'provider_company',
        entityId: providerCompanyId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        reason: trimmed,
        beforeState: { status: before.status },
        afterState: { status: 'suspended', withdrawnOffers: withdrawn.rows.length },
      },
      tx,
    );

    logger().warn(
      { providerCompanyId, reason: trimmed, withdrawnOffers: withdrawn.rows.length },
      'provider suspended',
    );

    return { provider: updated, withdrawnOffers: withdrawn.rows.length };
  });
}

export async function rejectProvider(
  providerCompanyId: string,
  reason: string,
  actor: Actor,
): Promise<ProviderCompany> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new ApronError('reason_required', 'Rejecting a registration requires a reason');
  }

  return withTransaction(async (tx) => {
    const before = await loadProvider(providerCompanyId, tx);

    if (before.status === 'approved') {
      throw new ApronError(
        'precondition_failed',
        'Suspend an approved provider rather than rejecting it',
      );
    }

    const [updated] = await tx
      .update(providerCompanies)
      .set({ status: 'rejected', notes: trimmed })
      .where(eq(providerCompanies.id, providerCompanyId))
      .returning();

    if (updated === undefined) throw new ApronError('internal', 'The provider could not be updated');

    await recordAuditEvent(
      {
        action: 'provider_company.reject',
        entityType: 'provider_company',
        entityId: providerCompanyId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        reason: trimmed,
        beforeState: { status: before.status },
        afterState: { status: 'rejected' },
      },
      tx,
    );

    return updated;
  });
}

/** Changes the platform rank used as a ranking tie-break. */
export async function setProviderRank(
  providerCompanyId: string,
  rank: number,
  actor: Actor,
): Promise<ProviderCompany> {
  if (!Number.isInteger(rank) || rank < 1 || rank > 1000) {
    throw new ApronError('validation_failed', 'Rank must be a whole number between 1 and 1000');
  }

  return withTransaction(async (tx) => {
    const before = await loadProvider(providerCompanyId, tx);

    const [updated] = await tx
      .update(providerCompanies)
      .set({ rank })
      .where(eq(providerCompanies.id, providerCompanyId))
      .returning();

    if (updated === undefined) throw new ApronError('internal', 'The provider could not be updated');

    await recordAuditEvent(
      {
        action: 'provider_company.set_rank',
        entityType: 'provider_company',
        entityId: providerCompanyId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        ...diffStates({ rank: before.rank }, { rank }),
      },
      tx,
    );

    return updated;
  });
}

// ---------------------------------------------------------------------------
// service catalogue (ADR-008 — no migration required)
// ---------------------------------------------------------------------------

export interface ServiceCategoryInput {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly unitLabel: string;
  readonly assignmentStrategy: AssignmentStrategy;
  readonly sortOrder: number;
  readonly configSchema: ServiceConfigSchema;
}

/**
 * Creates a service category from the Admin console.
 *
 * This is the promise ADR-008 makes good on: a new service is a ROW. No migration, no
 * deployment, and the matching engine picks it up immediately — by its own rules if a
 * strategy is registered, otherwise by coverage, hours, lead time and capacity.
 */
export async function createServiceCategory(
  input: ServiceCategoryInput,
  actor: Actor,
): Promise<ServiceCategory> {
  if (!/^[a-z][a-z0-9_]{1,48}$/.test(input.code)) {
    throw new ApronError(
      'validation_failed',
      'The code must be lowercase letters, digits and underscores, starting with a letter',
    );
  }

  return withTransaction(async (tx) => {
    const existing = await tx
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(eq(serviceCategories.code, input.code))
      .limit(1);

    if (existing.length > 0) {
      throw new ApronError('conflict', `A service with the code "${input.code}" already exists`);
    }

    const [created] = await tx
      .insert(serviceCategories)
      .values({
        code: input.code,
        name: input.name,
        description: input.description,
        unitLabel: input.unitLabel,
        assignmentStrategy: input.assignmentStrategy,
        sortOrder: input.sortOrder,
        configSchemaJson: input.configSchema,
      })
      .returning();

    if (created === undefined) throw new ApronError('internal', 'The service could not be created');

    await recordAuditEvent(
      {
        action: 'catalogue.create_service',
        entityType: 'service_category',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        afterState: {
          code: created.code,
          name: created.name,
          assignmentStrategy: created.assignmentStrategy,
        },
      },
      tx,
    );

    logger().info({ code: created.code, actor: actor.label }, 'service category created');
    return created;
  });
}

/** Enables or disables a category. Disabling never deletes history. */
export async function setServiceCategoryActive(
  serviceCategoryId: string,
  active: boolean,
  actor: Actor,
): Promise<ServiceCategory> {
  return withTransaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(serviceCategories)
      .where(eq(serviceCategories.id, serviceCategoryId))
      .limit(1);

    if (before === undefined) throw new ApronError('not_found', 'That service does not exist');

    const [updated] = await tx
      .update(serviceCategories)
      .set({ active })
      .where(eq(serviceCategories.id, serviceCategoryId))
      .returning();

    if (updated === undefined) throw new ApronError('internal', 'The service could not be updated');

    await recordAuditEvent(
      {
        action: active ? 'catalogue.enable_service' : 'catalogue.disable_service',
        entityType: 'service_category',
        entityId: serviceCategoryId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        ...diffStates({ active: before.active }, { active }),
      },
      tx,
    );

    return updated;
  });
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export interface AirportInput {
  readonly icao: string | null;
  readonly iata: string | null;
  readonly name: string;
  readonly city: string;
  readonly stateRegion: string | null;
  readonly countryCode: string;
  readonly latitude: string;
  readonly longitude: string;
  readonly timezoneIana: string;
}

export async function createAirport(input: AirportInput, actor: Actor) {
  if (input.icao === null && input.iata === null) {
    throw new ApronError('validation_failed', 'An airport needs an ICAO or an IATA code');
  }

  // The timezone must be real: every local-time conversion for this airport depends on it,
  // and an invalid zone would fail much later, at intake, with a confusing message.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timezoneIana });
  } catch {
    throw new ApronError('validation_failed', `"${input.timezoneIana}" is not a known IANA timezone`);
  }

  return withTransaction(async (tx) => {
    const [created] = await tx
      .insert(airports)
      .values({
        icao: input.icao,
        iata: input.iata,
        name: input.name,
        city: input.city,
        stateRegion: input.stateRegion,
        countryCode: input.countryCode.toUpperCase(),
        latitude: input.latitude,
        longitude: input.longitude,
        timezoneIana: input.timezoneIana,
      })
      .returning();

    if (created === undefined) throw new ApronError('internal', 'The airport could not be created');

    await recordAuditEvent(
      {
        action: 'registry.create_airport',
        entityType: 'airport',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        afterState: { icao: created.icao, name: created.name, timezone: created.timezoneIana },
      },
      tx,
    );

    return created;
  });
}

export async function createFbo(
  input: { readonly airportId: string; readonly name: string; readonly phone: string | null },
  actor: Actor,
) {
  return withTransaction(async (tx) => {
    const [created] = await tx
      .insert(fbos)
      .values({ airportId: input.airportId, name: input.name, phone: input.phone })
      .returning();

    if (created === undefined) throw new ApronError('internal', 'The handler could not be created');

    await recordAuditEvent(
      {
        action: 'registry.create_fbo',
        entityType: 'fbo',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        afterState: { name: created.name, airportId: created.airportId },
      },
      tx,
    );

    return created;
  });
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  readonly email: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly phone: string | null;
  readonly providerCompanyId: string | null;
  readonly clientOrganizationId: string | null;
  readonly temporaryPassword: string;
}

/**
 * Creates a user.
 *
 * Tenancy is checked here for a useful message, and again by a database CHECK constraint
 * that cannot be bypassed — a provider role without a company, or an operations role with
 * one, is refused by the schema itself (§5).
 */
export async function createUser(input: CreateUserInput, actor: Actor) {
  const providerRoles: UserRole[] = ['provider_admin', 'provider_dispatcher', 'provider_staff'];
  const needsProvider = providerRoles.includes(input.role);
  const needsClient = input.role === 'client';

  if (needsProvider && input.providerCompanyId === null) {
    throw new ApronError('validation_failed', 'A provider user must belong to a provider company');
  }
  if (!needsProvider && input.providerCompanyId !== null) {
    throw new ApronError('validation_failed', 'Only provider roles belong to a provider company');
  }
  if (needsClient && input.clientOrganizationId === null) {
    throw new ApronError('validation_failed', 'A client user must belong to a client organisation');
  }
  if (!needsClient && input.clientOrganizationId !== null) {
    throw new ApronError('validation_failed', 'Only the client role belongs to a client organisation');
  }
  if (input.temporaryPassword.length < 12) {
    throw new ApronError('validation_failed', 'The temporary password must be at least 12 characters');
  }

  const passwordHash = await hashPassword(input.temporaryPassword);

  return withTransaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    if (existing.length > 0) {
      throw new ApronError('conflict', 'An account with that email already exists');
    }

    const [created] = await tx
      .insert(users)
      .values({
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        phone: input.phone,
        role: input.role,
        providerCompanyId: input.providerCompanyId,
        clientOrganizationId: input.clientOrganizationId,
        // They must choose their own password on first sign-in.
        mustChangePassword: true,
      })
      .returning({ id: users.id, email: users.email, role: users.role });

    if (created === undefined) throw new ApronError('internal', 'The account could not be created');

    await recordAuditEvent(
      {
        action: 'user.create',
        entityType: 'user',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        // The password is never recorded, not even hashed.
        afterState: { email: created.email, role: created.role },
      },
      tx,
    );

    logger().info({ userId: created.id, role: created.role }, 'user created');
    return created;
  });
}

/**
 * Suspends or reactivates an account.
 *
 * Suspending revokes every live session immediately — an account that can no longer sign
 * in but keeps working until its cookie expires is not suspended in any meaningful sense.
 */
export async function setUserStatus(
  userId: string,
  status: UserStatus,
  reason: string | null,
  actor: Actor,
): Promise<{ readonly revokedSessions: number }> {
  if (status === 'suspended' && (reason === null || reason.trim().length < 3)) {
    throw new ApronError('reason_required', 'Suspending an account requires a reason');
  }
  if (userId === actor.userId && status === 'suspended') {
    throw new ApronError('validation_failed', 'You cannot suspend your own account');
  }

  return withTransaction(async (tx) => {
    const [before] = await tx
      .select({ status: users.status, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (before === undefined) throw new ApronError('not_found', 'That account does not exist');

    await tx.update(users).set({ status }).where(eq(users.id, userId));

    const revokedSessions = status === 'active' ? 0 : await revokeAllSessionsForUser(userId, tx);

    await recordAuditEvent(
      {
        action: status === 'suspended' ? 'user.suspend' : 'user.set_status',
        entityType: 'user',
        entityId: userId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        reason: reason?.trim() ?? null,
        beforeState: { status: before.status },
        afterState: { status, revokedSessions },
      },
      tx,
    );

    logger().warn({ userId, status, revokedSessions }, 'user status changed');
    return { revokedSessions };
  });
}

// ---------------------------------------------------------------------------
// settings and flags
// ---------------------------------------------------------------------------

export async function setPlatformSetting(
  key: string,
  value: unknown,
  actor: Actor,
): Promise<void> {
  await withTransaction(async (tx) => {
    const [before] = await tx
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, key))
      .limit(1);

    if (before === undefined) {
      throw new ApronError('not_found', `There is no setting called "${key}"`);
    }

    await tx
      .update(platformSettings)
      .set({ value, updatedBy: actor.userId })
      .where(eq(platformSettings.key, key));

    await recordAuditEvent(
      {
        action: 'settings.update',
        entityType: 'platform_setting',
        entityId: key,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        beforeState: { value: before.value },
        afterState: { value },
      },
      tx,
    );

    logger().info({ key, actor: actor.label }, 'platform setting changed');
  });
}

export async function setFeatureFlag(key: string, enabled: boolean, actor: Actor): Promise<void> {
  await withTransaction(async (tx) => {
    const [before] = await tx
      .select({ enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(eq(featureFlags.key, key))
      .limit(1);

    if (before === undefined) {
      throw new ApronError('not_found', `There is no flag called "${key}"`);
    }

    await tx
      .update(featureFlags)
      .set({ enabled, updatedBy: actor.userId })
      .where(eq(featureFlags.key, key));

    await recordAuditEvent(
      {
        action: 'feature_flag.update',
        entityType: 'feature_flag',
        entityId: key,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        ...diffStates({ enabled: before.enabled }, { enabled }),
      },
      tx,
    );

    logger().warn({ key, enabled, actor: actor.label }, 'feature flag changed');
  });
}

async function loadProvider(providerCompanyId: string, tx: Transaction): Promise<ProviderCompany> {
  const rows = await tx
    .select()
    .from(providerCompanies)
    .where(eq(providerCompanies.id, providerCompanyId))
    .for('update')
    .limit(1);

  const provider = rows[0];
  if (provider === undefined) {
    throw new ApronError('not_found', 'That provider company does not exist');
  }
  return provider;
}
