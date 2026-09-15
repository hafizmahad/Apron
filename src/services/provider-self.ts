import '@/lib/server-guard';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, withTransaction } from '@/db/client';
import {
  drivers,
  providerCoverage,
  securityOfficers,
  vehicles,
  assignmentResources,
} from '@/db/schema';
import type { UserRole, VehicleClass } from '@/db/schema/enums';
import { recordAuditEvent } from '@/domain/audit';
import { ApronError } from '@/lib/errors';
import { logger } from '@/lib/logging';

/**
 * Provider self-management (CLAUDE.md §13).
 *
 * A provider maintains its own fleet, staff and coverage. Everything here is scoped to the
 * caller's own company by putting `providerCompanyId` in the WHERE clause of the write
 * itself, rather than reading the row, checking ownership and then writing — there is no
 * window between the two, and another company's id simply matches nothing.
 *
 * Two rules worth stating, because both protect work already promised to a client:
 *
 *  - **Deactivating is not deleting.** A vehicle with history keeps it. `active = false`
 *    removes it from future matching and leaves every past assignment intact and
 *    explicable.
 *  - **A resource committed to future work cannot be deactivated.** Otherwise a provider
 *    could quietly retire the car that is meeting an arrival tomorrow, and nothing would
 *    notice until nobody turned up.
 */

export interface ProviderActor {
  readonly userId: string;
  readonly role: UserRole;
  readonly label: string;
  readonly providerCompanyId: string;
}

export type ResourceKindSelf = 'vehicle' | 'driver' | 'officer';

// ---------------------------------------------------------------------------
// adding
// ---------------------------------------------------------------------------

export interface NewVehicleInput {
  readonly vehicleClass: VehicleClass;
  readonly make: string;
  readonly model: string;
  readonly plateReference: string;
  readonly passengerCapacity: number;
  readonly luggageCapacity: number;
  readonly homeAirportId: string | null;
}

export async function addVehicle(
  input: NewVehicleInput,
  actor: ProviderActor,
): Promise<{ readonly id: string }> {
  return withTransaction(async (tx) => {
    const [created] = await tx
      .insert(vehicles)
      .values({
        providerCompanyId: actor.providerCompanyId,
        vehicleClass: input.vehicleClass,
        make: input.make,
        model: input.model,
        plateReference: input.plateReference,
        passengerCapacity: input.passengerCapacity,
        luggageCapacity: input.luggageCapacity,
        homeAirportId: input.homeAirportId,
      })
      .returning({ id: vehicles.id });

    if (created === undefined) throw new ApronError('internal', 'The vehicle could not be added');

    await recordAuditEvent(
      {
        action: 'provider.add_vehicle',
        entityType: 'vehicle',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        afterState: {
          providerCompanyId: actor.providerCompanyId,
          plate: input.plateReference,
          class: input.vehicleClass,
          passengerCapacity: input.passengerCapacity,
        },
      },
      tx,
    );

    return created;
  });
}

export interface NewStaffInput {
  readonly fullName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly timezoneIana: string;
  readonly homeAirportId: string | null;
  /** Officers only. A request asking for armed cover filters on this; never inferred. */
  readonly armedCertified?: boolean;
}

export async function addDriver(
  input: NewStaffInput,
  actor: ProviderActor,
): Promise<{ readonly id: string }> {
  assertKnownTimezone(input.timezoneIana);

  return withTransaction(async (tx) => {
    const [created] = await tx
      .insert(drivers)
      .values({
        providerCompanyId: actor.providerCompanyId,
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        timezoneIana: input.timezoneIana,
        homeAirportId: input.homeAirportId,
      })
      .returning({ id: drivers.id });

    if (created === undefined) throw new ApronError('internal', 'The driver could not be added');

    await recordAuditEvent(
      {
        action: 'provider.add_driver',
        entityType: 'driver',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        afterState: { providerCompanyId: actor.providerCompanyId, name: input.fullName },
      },
      tx,
    );

    return created;
  });
}

export async function addOfficer(
  input: NewStaffInput,
  actor: ProviderActor,
): Promise<{ readonly id: string }> {
  assertKnownTimezone(input.timezoneIana);

  return withTransaction(async (tx) => {
    const [created] = await tx
      .insert(securityOfficers)
      .values({
        providerCompanyId: actor.providerCompanyId,
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        timezoneIana: input.timezoneIana,
        homeAirportId: input.homeAirportId,
        armedCertified: input.armedCertified ?? false,
      })
      .returning({ id: securityOfficers.id });

    if (created === undefined) throw new ApronError('internal', 'The officer could not be added');

    await recordAuditEvent(
      {
        action: 'provider.add_officer',
        entityType: 'security_officer',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        afterState: {
          providerCompanyId: actor.providerCompanyId,
          name: input.fullName,
          armed: input.armedCertified ?? false,
        },
      },
      tx,
    );

    return created;
  });
}

/**
 * A driver's or officer's shift zone drives every availability comparison for them.
 *
 * An unrecognised zone would not fail here; it would fail much later, during matching,
 * as an unexplained "not available".
 */
function assertKnownTimezone(zone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new ApronError('validation_failed', `"${zone}" is not a known IANA timezone`);
  }
}

// ---------------------------------------------------------------------------
// retiring and restoring
// ---------------------------------------------------------------------------

const TABLES = {
  vehicle: vehicles,
  driver: drivers,
  officer: securityOfficers,
} as const;

const RESOURCE_COLUMN = {
  vehicle: assignmentResources.vehicleId,
  driver: assignmentResources.driverId,
  officer: assignmentResources.officerId,
} as const;

/**
 * Takes a resource out of service, or puts it back.
 *
 * Refuses to retire anything committed to work that has not happened yet. The provider is
 * told which window is in the way, because "you cannot" without "why" is not actionable.
 */
export async function setResourceActive(
  input: {
    readonly kind: ResourceKindSelf;
    readonly resourceId: string;
    readonly active: boolean;
    readonly now?: Date;
  },
  actor: ProviderActor,
): Promise<void> {
  const now = input.now ?? new Date();
  const table = TABLES[input.kind];

  if (!input.active) {
    const committed = await getDb()
      .select({ id: assignmentResources.id })
      .from(assignmentResources)
      .where(
        and(
          eq(RESOURCE_COLUMN[input.kind], input.resourceId),
          eq(assignmentResources.released, false),
          // Still in the future: the job has not finished yet.
          sql`${assignmentResources.endUtc} > ${now.toISOString()}::timestamptz`,
        ),
      )
      .limit(1);

    if (committed.length > 0) {
      throw new ApronError(
        'precondition_failed',
        'This is committed to work that has not happened yet. Release the assignment first, ' +
          'or wait until the job is done.',
      );
    }
  }

  await withTransaction(async (tx) => {
    // Scoped by company in the WHERE clause: another company's id matches nothing.
    const updated = await tx
      .update(table)
      .set({ active: input.active })
      .where(and(eq(table.id, input.resourceId), eq(table.providerCompanyId, actor.providerCompanyId)))
      .returning({ id: table.id });

    if (updated.length === 0) {
      logger().warn(
        { kind: input.kind, resourceId: input.resourceId, actor: actor.label },
        'provider resource update matched nothing — wrong company or unknown id',
      );
      throw new ApronError('not_found', 'That is not one of your resources');
    }

    await recordAuditEvent(
      {
        action: input.active ? 'provider.restore_resource' : 'provider.retire_resource',
        entityType: input.kind,
        entityId: input.resourceId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        afterState: { active: input.active, providerCompanyId: actor.providerCompanyId },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

/**
 * Changes what this company can take on at one location.
 *
 * Capacity and lead time are what the eligibility engine reads, so an edit here changes
 * the next match. Lowering capacity below what is already committed is allowed — it stops
 * NEW work without disturbing a promise already made.
 */
export async function updateCoverage(
  input: {
    readonly coverageId: string;
    readonly totalCapacity?: number;
    readonly leadTimeMinutes?: number;
    readonly active?: boolean;
  },
  actor: ProviderActor,
): Promise<void> {
  const changes: Record<string, unknown> = {};
  if (input.totalCapacity !== undefined) changes['totalCapacity'] = input.totalCapacity;
  if (input.leadTimeMinutes !== undefined) changes['leadTimeMinutes'] = input.leadTimeMinutes;
  if (input.active !== undefined) changes['active'] = input.active;

  if (Object.keys(changes).length === 0) {
    throw new ApronError('validation_failed', 'Nothing to change');
  }

  await withTransaction(async (tx) => {
    const [before] = await tx
      .select({
        totalCapacity: providerCoverage.totalCapacity,
        leadTimeMinutes: providerCoverage.leadTimeMinutes,
        active: providerCoverage.active,
      })
      .from(providerCoverage)
      .where(
        and(
          eq(providerCoverage.id, input.coverageId),
          eq(providerCoverage.providerCompanyId, actor.providerCompanyId),
        ),
      )
      .limit(1);

    if (before === undefined) {
      throw new ApronError('not_found', 'That is not one of your coverage entries');
    }

    await tx
      .update(providerCoverage)
      .set(changes)
      .where(
        and(
          eq(providerCoverage.id, input.coverageId),
          eq(providerCoverage.providerCompanyId, actor.providerCompanyId),
        ),
      );

    await recordAuditEvent(
      {
        action: 'provider.update_coverage',
        entityType: 'provider_coverage',
        entityId: input.coverageId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        beforeState: { ...before },
        afterState: changes,
      },
      tx,
    );
  });
}
