import '@/lib/server-guard';
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withTransaction, type Transaction } from '@/db/client';
import {
  requestPassengers,
  requestServiceLines,
  requests,
  serviceCategories,
  type Request,
} from '@/db/schema';
import type { RequestChannel, RequestPriority } from '@/db/schema/enums';
import { recordAuditEvent } from '@/domain/audit';
import { validateRequirements } from '@/domain/services/requirements';
import { ApronError } from '@/lib/errors';
import { logger } from '@/lib/logging';
import { makeInterval, type Interval } from '@/lib/time';

/**
 * Creating a confirmed request (CLAUDE.md §8 step 4).
 *
 * Runs in ONE transaction: the request, its passengers, its service lines and the audit
 * event either all exist or none do. A half-written request that appears in Operations
 * with no lines would be worse than a clean failure.
 *
 * Requirements are re-validated here against the live catalogue even though intake
 * already validated them — the client may have edited the read-back, and the server never
 * trusts what came back from a browser (CLAUDE.md §27).
 */

export interface ServiceLineInput {
  readonly serviceCategoryId: string;
  readonly quantity: number;
  readonly requirements: Record<string, unknown>;
  /** Resolved from the request window by `deriveServiceWindow` when not supplied. */
  readonly serviceStartUtc?: Date;
  readonly serviceEndUtc?: Date;
}

export interface PassengerInput {
  readonly fullName: string;
  readonly personType: 'passenger' | 'crew';
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly notes?: string;
  readonly isPrimary?: boolean;
}

export interface CreateRequestInput {
  readonly clientOrganizationId: string;
  readonly createdByUserId: string | null;
  readonly createdVia: RequestChannel;
  /** Verbatim. Never rewritten (CLAUDE.md §22). */
  readonly sourceSentence: string;
  readonly airportId: string;
  readonly fboId: string | null;
  readonly aircraftId: string | null;
  readonly flightReference?: string | null;
  readonly arrivalUtc: Date | null;
  readonly departureUtc: Date | null;
  readonly passengerCount: number;
  readonly crewCount: number;
  readonly priority?: RequestPriority;
  readonly operationalNotes?: string;
  readonly lines: readonly ServiceLineInput[];
  readonly passengers?: readonly PassengerInput[];
  /** Guest requests carry their own contact and get a secure link. */
  readonly guestContact?: {
    readonly name: string;
    readonly email: string;
    readonly phone?: string | null;
    readonly linkTtlHours: number;
  };
}

export interface CreatedRequest {
  readonly request: Request;
  readonly lineIds: readonly string[];
  /** Returned once, never stored in plain form. */
  readonly guestToken: string | null;
}

/**
 * Default service windows per category, relative to the flight window.
 *
 * These are STARTING POINTS a person can edit, not assertions about the world. Each is
 * derived from the request's own instants — nothing is invented when the flight window is
 * unknown, in which case the line is created with a null window and the matching engine
 * reports `service_window_unknown` rather than guessing.
 */
export function deriveServiceWindow(
  categoryCode: string,
  arrivalUtc: Date | null,
  departureUtc: Date | null,
): Interval | null {
  const hour = 3_600_000;

  switch (categoryCode) {
    case 'ground_transport': {
      // Meets the arrival: from touchdown to three hours after.
      if (arrivalUtc !== null) return makeInterval(arrivalUtc, new Date(arrivalUtc.getTime() + 3 * hour));
      // Departure-only trip: positions two hours before the wheels-up time.
      if (departureUtc !== null) {
        return makeInterval(new Date(departureUtc.getTime() - 2 * hour), departureUtc);
      }
      return null;
    }

    case 'close_protection': {
      // Spans the whole ground period when both instants are known.
      if (arrivalUtc !== null && departureUtc !== null && departureUtc > arrivalUtc) {
        return makeInterval(arrivalUtc, departureUtc);
      }
      if (arrivalUtc !== null) return makeInterval(arrivalUtc, new Date(arrivalUtc.getTime() + 8 * hour));
      if (departureUtc !== null) {
        return makeInterval(new Date(departureUtc.getTime() - 4 * hour), departureUtc);
      }
      return null;
    }

    case 'hotel': {
      // Arrival evening to the following morning, or the real gap between the two flights.
      if (arrivalUtc !== null && departureUtc !== null && departureUtc > arrivalUtc) {
        return makeInterval(arrivalUtc, departureUtc);
      }
      if (arrivalUtc !== null) {
        return makeInterval(arrivalUtc, new Date(arrivalUtc.getTime() + 20 * hour));
      }
      return null;
    }

    case 'catering': {
      // Delivered before departure; falls back to the arrival for a same-day turn.
      const anchor = departureUtc ?? arrivalUtc;
      if (anchor === null) return null;
      return makeInterval(new Date(anchor.getTime() - 3 * hour), anchor);
    }

    case 'fuel': {
      const anchor = arrivalUtc ?? departureUtc;
      if (anchor === null) return null;
      return makeInterval(anchor, new Date(anchor.getTime() + 2 * hour));
    }

    case 'hangar': {
      if (arrivalUtc !== null && departureUtc !== null && departureUtc > arrivalUtc) {
        return makeInterval(arrivalUtc, departureUtc);
      }
      if (arrivalUtc !== null) {
        return makeInterval(arrivalUtc, new Date(arrivalUtc.getTime() + 24 * hour));
      }
      return null;
    }

    default: {
      // An admin-created category with no window convention: use the flight window when
      // there is one, and otherwise leave it for a person to set.
      if (arrivalUtc !== null && departureUtc !== null && departureUtc > arrivalUtc) {
        return makeInterval(arrivalUtc, departureUtc);
      }
      if (arrivalUtc !== null) return makeInterval(arrivalUtc, new Date(arrivalUtc.getTime() + 4 * hour));
      return null;
    }
  }
}

/**
 * Generates `RQ-XXXXXX`.
 *
 * Crockford-style alphabet with I, L, O and U removed, so a reference read aloud over a
 * radio or written on a handling sheet cannot be confused between 1/I/L or 0/O.
 */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateReference(): string {
  const bytes = randomBytes(6);
  let reference = 'RQ-';
  for (const byte of bytes) {
    reference += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return reference;
}

export async function createRequest(input: CreateRequestInput): Promise<CreatedRequest> {
  if (input.lines.length === 0) {
    throw new ApronError('validation_failed', 'A request needs at least one service');
  }

  if (input.arrivalUtc === null && input.departureUtc === null) {
    throw new ApronError('validation_failed', 'A request needs an arrival or a departure time');
  }

  if (
    input.arrivalUtc !== null &&
    input.departureUtc !== null &&
    input.departureUtc.getTime() < input.arrivalUtc.getTime()
  ) {
    throw new ApronError('validation_failed', 'The departure cannot be before the arrival');
  }

  return withTransaction(async (tx) => {
    // Categories are loaded once and re-validated against; the client's copy is not trusted.
    const categoryIds = [...new Set(input.lines.map((line) => line.serviceCategoryId))];
    const categories = await tx
      .select()
      .from(serviceCategories)
      .where(
        and(
          eq(serviceCategories.active, true),
          sql`${serviceCategories.id} = any(${sql.raw(`array[${categoryIds.map((id) => `'${id}'::uuid`).join(',')}]`)})`,
        ),
      );

    const categoryById = new Map(categories.map((category) => [category.id, category]));

    for (const line of input.lines) {
      if (!categoryById.has(line.serviceCategoryId)) {
        throw new ApronError('unresolvable_reference', 'One of the services is not available', {
          details: { serviceCategoryId: line.serviceCategoryId },
        });
      }
    }

    // Duplicate categories would violate the unique index; catching it here gives the
    // caller a message rather than a constraint violation.
    if (categoryIds.length !== input.lines.length) {
      throw new ApronError(
        'validation_failed',
        'Each service can appear only once — use the quantity instead',
      );
    }

    const reference = await allocateReference(tx);

    const guestToken = input.guestContact === undefined ? null : randomBytes(32).toString('base64url');
    const guestTokenHash =
      guestToken === null
        ? null
        : (await import('node:crypto')).createHash('sha256').update(guestToken).digest('hex');

    const [created] = await tx
      .insert(requests)
      .values({
        reference,
        clientOrganizationId: input.clientOrganizationId,
        createdByUserId: input.createdByUserId,
        createdVia: input.createdVia,
        sourceSentence: input.sourceSentence,
        airportId: input.airportId,
        fboId: input.fboId,
        aircraftId: input.aircraftId,
        flightReference: input.flightReference ?? null,
        arrivalUtc: input.arrivalUtc,
        departureUtc: input.departureUtc,
        passengerCount: input.passengerCount,
        crewCount: input.crewCount,
        // Confirmed by the user; sourcing begins when matching is enqueued.
        status: 'sent',
        priority: input.priority ?? 'normal',
        operationalNotes: input.operationalNotes ?? '',
        confirmedAt: new Date(),
        ...(input.guestContact === undefined
          ? {}
          : {
              guestContactName: input.guestContact.name,
              guestContactEmail: input.guestContact.email,
              guestContactPhone: input.guestContact.phone ?? null,
              guestTokenHash,
              guestTokenExpiresAt: new Date(
                Date.now() + input.guestContact.linkTtlHours * 3_600_000,
              ),
            }),
      })
      .returning();

    if (created === undefined) {
      throw new ApronError('internal', 'The request could not be created');
    }

    // --- passengers ---------------------------------------------------------
    const people = input.passengers ?? [];
    if (people.length > 0) {
      const primaryCount = people.filter((person) => person.isPrimary === true).length;
      if (primaryCount > 1) {
        throw new ApronError('validation_failed', 'Only one passenger can be the primary contact');
      }

      await tx.insert(requestPassengers).values(
        people.map((person, index) => ({
          requestId: created.id,
          fullName: person.fullName,
          personType: person.personType,
          phone: person.phone ?? null,
          email: person.email ?? null,
          notes: person.notes ?? '',
          isPrimary: person.isPrimary === true,
          sortOrder: index,
        })),
      );
    }

    // --- service lines ------------------------------------------------------
    const lineIds: string[] = [];

    for (const [index, line] of input.lines.entries()) {
      const category = categoryById.get(line.serviceCategoryId);
      if (category === undefined) continue; // unreachable: validated above

      const validation = validateRequirements(
        category.code,
        category.configSchemaJson,
        line.requirements,
      );

      if (!validation.ok) {
        throw new ApronError('validation_failed', `${category.name}: ${validation.issues[0]?.message ?? 'invalid requirements'}`, {
          details: { serviceCode: category.code, issues: validation.issues },
        });
      }

      const window =
        line.serviceStartUtc !== undefined && line.serviceEndUtc !== undefined
          ? makeInterval(line.serviceStartUtc, line.serviceEndUtc)
          : deriveServiceWindow(category.code, input.arrivalUtc, input.departureUtc);

      const [createdLine] = await tx
        .insert(requestServiceLines)
        .values({
          requestId: created.id,
          serviceCategoryId: category.id,
          sequence: index + 1,
          quantity: line.quantity,
          requirementsJson: validation.value,
          serviceStartUtc: window?.start ?? null,
          serviceEndUtc: window?.end ?? null,
          // Lines begin in `matching`; the matching service picks them up from here.
          status: 'matching',
        })
        .returning({ id: requestServiceLines.id });

      if (createdLine === undefined) {
        throw new ApronError('internal', 'A service line could not be created');
      }
      lineIds.push(createdLine.id);
    }

    await recordAuditEvent(
      {
        action: 'request.create',
        entityType: 'request',
        entityId: created.id,
        actorUserId: input.createdByUserId,
        actorLabel: input.createdVia === 'guest' ? (input.guestContact?.email ?? 'guest') : 'user',
        afterState: {
          reference: created.reference,
          airportId: created.airportId,
          arrivalUtc: created.arrivalUtc,
          departureUtc: created.departureUtc,
          serviceCount: lineIds.length,
          createdVia: created.createdVia,
        },
      },
      tx,
    );

    logger().info(
      { requestId: created.id, reference: created.reference, lines: lineIds.length },
      'request created',
    );

    return { request: created, lineIds, guestToken };
  });
}

/**
 * Allocates an unused reference.
 *
 * The unique index is the real guarantee; this loop just avoids surfacing a constraint
 * violation for what is a one-in-a-billion collision.
 */
async function allocateReference(tx: Transaction): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateReference();
    const existing = await tx
      .select({ id: requests.id })
      .from(requests)
      .where(eq(requests.reference, candidate))
      .limit(1);

    if (existing.length === 0) return candidate;
  }
  throw new ApronError('internal', 'Could not allocate a request reference');
}
