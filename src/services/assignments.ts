import '@/lib/server-guard';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, withAdvisoryLock, withTransaction, type Transaction } from '@/db/client';
import {
  assignmentResources,
  assignments,
  providerOffers,
  requestServiceLines,
  requests,
  type Assignment,
} from '@/db/schema';
import type { ResourceKind, UserRole } from '@/db/schema/enums';
import { recordAuditEvent } from '@/domain/audit';
import { transitionLine } from '@/domain/requests/state-machine';
import { ApronError, sqlState } from '@/lib/errors';
import { logger } from '@/lib/logging';
import { refreshRequestStatus } from './offers';
import { emitNotification } from './notifications';

/**
 * Committing concrete resources to an acknowledged line (CLAUDE.md §11 steps 5-8).
 *
 * The integrity guarantee here is NOT in this file — it is the four `EXCLUDE USING gist`
 * constraints on `assignment_resources`. This code's job is to run inside a transaction,
 * let the database refuse an overlap, and turn that refusal into a message a dispatcher
 * can act on. It never pre-checks in place of the constraint (CLAUDE.md §30: "Do not rely
 * on frontend disabling a button for correctness").
 *
 * A pre-check would in fact be worse than useless: between the check and the insert
 * another dispatcher can commit the same vehicle. Only the constraint is atomic.
 */

const LINE_LOCK_NAMESPACE = 4201;

/** Postgres raises this when an exclusion constraint refuses an overlapping range. */
const EXCLUSION_VIOLATION = '23P01';

export interface ResourceCommitmentInput {
  readonly kind: ResourceKind;
  readonly resourceId: string;
  /** Rooms, gallons or covers for pooled kinds; 1 for singular ones. */
  readonly quantity?: number;
  /** Defaults to the assignment window. */
  readonly startUtc?: Date;
  readonly endUtc?: Date;
}

export interface CreateAssignmentInput {
  readonly requestServiceLineId: string;
  readonly providerCompanyId: string;
  readonly actorUserId: string;
  readonly actorRole: UserRole;
  readonly actorLabel: string;
  readonly startUtc: Date;
  readonly endUtc: Date;
  readonly resources: readonly ResourceCommitmentInput[];
  readonly notes?: string;
}

/** Which foreign key each kind populates. */
const RESOURCE_COLUMN: Record<ResourceKind, keyof typeof assignmentResources.$inferInsert> = {
  vehicle: 'vehicleId',
  driver: 'driverId',
  officer: 'officerId',
  hotel_room: 'hotelRoomTypeId',
  catering: 'cateringCapabilityId',
  fuel: 'fuelCapabilityId',
  hangar: 'hangarResourceId',
};

/** Kinds the database itself protects with an exclusion constraint. */
const EXCLUSIVE_KINDS: ReadonlySet<ResourceKind> = new Set(['vehicle', 'driver', 'officer', 'hangar']);

export interface AssignmentResult {
  readonly assignment: Assignment;
  readonly committed: number;
}

export async function createAssignment(input: CreateAssignmentInput): Promise<AssignmentResult> {
  if (input.resources.length === 0) {
    throw new ApronError('validation_failed', 'Assign at least one resource');
  }
  if (input.endUtc.getTime() <= input.startUtc.getTime()) {
    throw new ApronError('validation_failed', 'The assignment must end after it starts');
  }

  const committed = await withTransaction(async (tx) =>
    withAdvisoryLock(tx, LINE_LOCK_NAMESPACE, input.requestServiceLineId, async () => {
      const line = await loadLine(input.requestServiceLineId, tx);

      // The provider must actually hold the acknowledged offer for this line. Without this
      // a provider could assign against someone else's work (Journey G).
      const [offer] = await tx
        .select({ providerCompanyId: providerOffers.providerCompanyId, id: providerOffers.id })
        .from(providerOffers)
        .where(
          and(
            eq(providerOffers.requestServiceLineId, input.requestServiceLineId),
            eq(providerOffers.status, 'acknowledged'),
          ),
        )
        .limit(1);

      if (offer === undefined) {
        throw new ApronError(
          'precondition_failed',
          'This service line has not been acknowledged yet',
        );
      }

      if (offer.providerCompanyId !== input.providerCompanyId) {
        logger().warn(
          {
            requestServiceLineId: input.requestServiceLineId,
            actorProviderCompanyId: input.providerCompanyId,
            offerProviderCompanyId: offer.providerCompanyId,
          },
          'tenant isolation violated: assignment',
        );
        throw new ApronError('tenant_mismatch', 'That service line belongs to another company');
      }

      const next = transitionLine(line.status, 'assign');

      const [assignment] = await tx
        .insert(assignments)
        .values({
          requestServiceLineId: input.requestServiceLineId,
          providerCompanyId: input.providerCompanyId,
          providerOfferId: offer.id,
          status: 'confirmed',
          startUtc: input.startUtc,
          endUtc: input.endUtc,
          notes: input.notes ?? '',
          createdByUserId: input.actorUserId,
        })
        .returning();

      if (assignment === undefined) {
        throw new ApronError('internal', 'The assignment could not be created');
      }

      // Each resource is inserted individually so a conflict names the exact resource that
      // is already committed, rather than failing the batch anonymously.
      for (const resource of input.resources) {
        await commitResource(assignment.id, resource, input, tx);
      }

      await tx
        .update(requestServiceLines)
        .set({ status: next })
        .where(eq(requestServiceLines.id, input.requestServiceLineId));

      await recordAuditEvent(
        {
          action: 'assignment.create',
          entityType: 'assignment',
          entityId: assignment.id,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          actorLabel: input.actorLabel,
          afterState: {
            requestServiceLineId: input.requestServiceLineId,
            providerCompanyId: input.providerCompanyId,
            startUtc: input.startUtc,
            endUtc: input.endUtc,
            resources: input.resources.map((item) => ({ kind: item.kind, id: item.resourceId })),
          },
        },
        tx,
      );

      await refreshRequestStatus(line.requestId, tx);

      logger().info(
        {
          assignmentId: assignment.id,
          requestServiceLineId: input.requestServiceLineId,
          resources: input.resources.length,
        },
        'assignment created',
      );

      return {
        assignment,
        committed: input.resources.length,
        requestId: line.requestId,
      };
    }),
  );

  await emitNotification({
    kind: 'assignment.completed',
    requestServiceLineId: input.requestServiceLineId,
  });

  // Committing resources is the only thing that can make a request fully covered, so this
  // is the one place worth asking. The status is read AFTER the commit, so the question is
  // answered against what is actually stored rather than against what we expected.
  const [request] = await getDb()
    .select({ status: requests.status })
    .from(requests)
    .where(eq(requests.id, committed.requestId))
    .limit(1);

  if (request?.status === 'confirmed') {
    await emitNotification({ kind: 'request.confirmed', requestId: committed.requestId });
  }

  return { assignment: committed.assignment, committed: committed.committed };
}

/**
 * Inserts one resource commitment, translating a constraint violation into a message that
 * names the resource.
 *
 * "This vehicle is already committed between 07:00 and 10:00" is actionable; a raw
 * SQLSTATE is not (CLAUDE.md §28).
 */
async function commitResource(
  assignmentId: string,
  resource: ResourceCommitmentInput,
  input: CreateAssignmentInput,
  tx: Transaction,
): Promise<void> {
  const column = RESOURCE_COLUMN[resource.kind];
  const start = resource.startUtc ?? input.startUtc;
  const end = resource.endUtc ?? input.endUtc;

  if (end.getTime() <= start.getTime()) {
    throw new ApronError('validation_failed', 'A resource window must end after it starts');
  }

  try {
    // The insert runs inside a SAVEPOINT (drizzle's nested transaction). A constraint
    // violation aborts the enclosing transaction in PostgreSQL — every later statement
    // then fails with "current transaction is aborted" — so without the savepoint we
    // could not query for the conflicting commitment to build a useful message.
    await tx.transaction(async (nested) => {
      await nested.insert(assignmentResources).values({
        assignmentId,
        resourceKind: resource.kind,
        [column]: resource.resourceId,
        quantity: resource.quantity ?? 1,
        startUtc: start,
        endUtc: end,
      } as typeof assignmentResources.$inferInsert);
    });
  } catch (error) {
    if (sqlState(error) === EXCLUSION_VIOLATION) {
      // The database refused an overlap. This is the constraint doing its job, not a bug.
      const conflict = await describeConflict(resource, start, end, tx);
      throw new ApronError(
        'resource_conflict',
        conflict ?? `That ${readableKind(resource.kind)} is already committed during this window.`,
        { details: { kind: resource.kind, resourceId: resource.resourceId }, cause: error },
      );
    }
    throw error;
  }
}

/** Finds what the resource is already doing, so the message can say when. */
async function describeConflict(
  resource: ResourceCommitmentInput,
  start: Date,
  end: Date,
  tx: Transaction,
): Promise<string | null> {
  if (!EXCLUSIVE_KINDS.has(resource.kind)) return null;

  const column = {
    vehicle: 'vehicle_id',
    driver: 'driver_id',
    officer: 'officer_id',
    hangar: 'hangar_resource_id',
  }[resource.kind as 'vehicle' | 'driver' | 'officer' | 'hangar'];

  const rows = await tx.execute<{ start_utc: string; end_utc: string; reference: string | null }>(sql`
    select ar.start_utc, ar.end_utc, r.reference
    from assignment_resources ar
    join assignments a on a.id = ar.assignment_id
    join request_service_lines l on l.id = a.request_service_line_id
    join requests r on r.id = l.request_id
    where ar.${sql.identifier(column)} = ${resource.resourceId}::uuid
      and ar.released = false
      and tstzrange(ar.start_utc, ar.end_utc, '[)')
          && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)')
    order by ar.start_utc
    limit 1
  `);

  const row = rows.rows[0];
  if (row === undefined) return null;

  const from = new Date(row.start_utc).toISOString().slice(11, 16);
  const to = new Date(row.end_utc).toISOString().slice(11, 16);

  return `That ${readableKind(resource.kind)} is already committed from ${from} to ${to} UTC${
    row.reference === null ? '' : ` on ${row.reference}`
  }. Choose another, or release that commitment first.`;
}

export interface ReleaseInput {
  readonly assignmentId: string;
  readonly providerCompanyId: string;
  readonly actorUserId: string;
  readonly actorRole: UserRole;
  readonly actorLabel: string;
  readonly reason: string;
}

/**
 * Releases an assignment and frees its resources.
 *
 * The rows are marked `released` rather than deleted: the audit trail must still show that
 * the vehicle was committed and then given back. The exclusion constraints are filtered on
 * `released = false`, so a released row stops blocking immediately.
 *
 * The line returns to `acknowledged`, not to `matching` — the provider is still committed,
 * only the concrete resources changed.
 */
export async function releaseAssignment(input: ReleaseInput): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new ApronError('reason_required', 'Releasing an assignment requires a reason');
  }

  await withTransaction(async (tx) => {
    const [assignment] = await tx
      .select()
      .from(assignments)
      .where(eq(assignments.id, input.assignmentId))
      .for('update')
      .limit(1);

    if (assignment === undefined) {
      throw new ApronError('not_found', 'That assignment does not exist');
    }

    if (assignment.providerCompanyId !== input.providerCompanyId) {
      throw new ApronError('tenant_mismatch', 'That assignment belongs to another company');
    }

    if (assignment.status === 'cancelled') return;

    await withAdvisoryLock(tx, LINE_LOCK_NAMESPACE, assignment.requestServiceLineId, async () => {
      const now = new Date();

      await tx
        .update(assignmentResources)
        .set({ released: true, releasedAt: now })
        .where(
          and(
            eq(assignmentResources.assignmentId, assignment.id),
            eq(assignmentResources.released, false),
          ),
        );

      await tx
        .update(assignments)
        .set({ status: 'cancelled', releasedAt: now, releaseReason: reason })
        .where(eq(assignments.id, assignment.id));

      const line = await loadLine(assignment.requestServiceLineId, tx);
      const next = transitionLine(line.status, 'release');

      await tx
        .update(requestServiceLines)
        .set({ status: next })
        .where(eq(requestServiceLines.id, assignment.requestServiceLineId));

      await recordAuditEvent(
        {
          action: 'assignment.release',
          entityType: 'assignment',
          entityId: assignment.id,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          actorLabel: input.actorLabel,
          reason,
          beforeState: { status: assignment.status },
          afterState: { status: 'cancelled', lineStatus: next },
        },
        tx,
      );

      await refreshRequestStatus(line.requestId, tx);

      logger().info({ assignmentId: assignment.id, reason }, 'assignment released');
    });
  });
}

async function loadLine(requestServiceLineId: string, tx: Transaction) {
  const rows = await tx
    .select({
      id: requestServiceLines.id,
      requestId: requestServiceLines.requestId,
      status: requestServiceLines.status,
    })
    .from(requestServiceLines)
    .where(eq(requestServiceLines.id, requestServiceLineId))
    .for('update')
    .limit(1);

  const line = rows[0];
  if (line === undefined) {
    throw new ApronError('not_found', 'That service line does not exist');
  }
  return line;
}

function readableKind(kind: ResourceKind): string {
  switch (kind) {
    case 'vehicle':
      return 'vehicle';
    case 'driver':
      return 'driver';
    case 'officer':
      return 'officer';
    case 'hangar':
      return 'hangar bay';
    case 'hotel_room':
      return 'room type';
    case 'catering':
      return 'kitchen';
    case 'fuel':
      return 'fuel truck';
  }
}
