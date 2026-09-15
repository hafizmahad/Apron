import '@/lib/server-guard';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb, type Executor } from '@/db/client';
import { qualified } from '@/db/sql';
import {
  aircraft,
  airports,
  assignmentResources,
  assignments,
  drivers,
  fbos,
  providerOffers,
  requestServiceLines,
  requests,
  securityOfficers,
  serviceCategories,
  vehicles,
} from '@/db/schema';
import type { ResourceKind } from '@/db/schema/enums';

/**
 * Read models for the Provider Portal (CLAUDE.md §13).
 *
 * Every query in this module takes `providerCompanyId` as its FIRST argument and filters
 * on it. There is no variant that omits it. That is deliberate: a query that could return
 * another company's work, even by accident, is the one bug this portal cannot have.
 *
 * Client contact details are NOT selected here at all. Before acknowledgement they must
 * not be disclosed (§5, §13), and the safest way to honour that is for the query never to
 * fetch them — a template cannot leak a column that was never read.
 */

export interface QueueItem {
  readonly offerId: string;
  readonly requestServiceLineId: string;
  readonly requestId: string;
  readonly reference: string;
  readonly serviceName: string;
  readonly serviceCode: string;
  readonly unitLabel: string;
  readonly quantity: number;
  readonly requirements: Record<string, unknown>;
  readonly airportLabel: string;
  readonly airportTimezone: string;
  readonly fboName: string | null;
  readonly aircraftLabel: string | null;
  readonly passengerCount: number;
  readonly crewCount: number;
  readonly arrivalUtc: Date | null;
  readonly departureUtc: Date | null;
  readonly serviceStartUtc: Date | null;
  readonly serviceEndUtc: Date | null;
  readonly sentAt: Date;
  readonly expiresAt: Date;
  readonly selectionReason: string;
  readonly priority: string;
}

/** Offers awaiting this company's response, most urgent deadline first. */
export async function loadOfferQueue(
  providerCompanyId: string,
  executor: Executor = getDb(),
): Promise<QueueItem[]> {
  const rows = await executor
    .select({
      offerId: providerOffers.id,
      requestServiceLineId: providerOffers.requestServiceLineId,
      sentAt: providerOffers.sentAt,
      expiresAt: providerOffers.expiresAt,
      selectionReason: providerOffers.selectionReason,

      requestId: requests.id,
      reference: requests.reference,
      passengerCount: requests.passengerCount,
      crewCount: requests.crewCount,
      arrivalUtc: requests.arrivalUtc,
      departureUtc: requests.departureUtc,
      priority: requests.priority,

      quantity: requestServiceLines.quantity,
      requirements: requestServiceLines.requirementsJson,
      serviceStartUtc: requestServiceLines.serviceStartUtc,
      serviceEndUtc: requestServiceLines.serviceEndUtc,

      serviceName: serviceCategories.name,
      serviceCode: serviceCategories.code,
      unitLabel: serviceCategories.unitLabel,

      airportIcao: airports.icao,
      airportName: airports.name,
      airportTimezone: airports.timezoneIana,
      fboName: fbos.name,

      aircraftTail: aircraft.tailNumber,
      aircraftModel: aircraft.model,
    })
    .from(providerOffers)
    .innerJoin(requestServiceLines, eq(requestServiceLines.id, providerOffers.requestServiceLineId))
    .innerJoin(requests, eq(requests.id, requestServiceLines.requestId))
    .innerJoin(serviceCategories, eq(serviceCategories.id, requestServiceLines.serviceCategoryId))
    .innerJoin(airports, eq(airports.id, requests.airportId))
    .leftJoin(fbos, eq(fbos.id, requests.fboId))
    .leftJoin(aircraft, eq(aircraft.id, requests.aircraftId))
    .where(
      and(
        eq(providerOffers.providerCompanyId, providerCompanyId),
        eq(providerOffers.status, 'sent'),
      ),
    )
    // The oldest deadline is the one that will lapse first — that is the order a
    // dispatcher needs, not the order the offers arrived.
    .orderBy(asc(providerOffers.expiresAt), asc(providerOffers.id));

  return rows.map(toQueueItem);
}

/** One offer, scoped to the company. Returns null rather than another company's row. */
export async function loadOffer(
  providerCompanyId: string,
  offerId: string,
  executor: Executor = getDb(),
): Promise<QueueItem | null> {
  const rows = await executor
    .select({
      offerId: providerOffers.id,
      requestServiceLineId: providerOffers.requestServiceLineId,
      sentAt: providerOffers.sentAt,
      expiresAt: providerOffers.expiresAt,
      selectionReason: providerOffers.selectionReason,
      requestId: requests.id,
      reference: requests.reference,
      passengerCount: requests.passengerCount,
      crewCount: requests.crewCount,
      arrivalUtc: requests.arrivalUtc,
      departureUtc: requests.departureUtc,
      priority: requests.priority,
      quantity: requestServiceLines.quantity,
      requirements: requestServiceLines.requirementsJson,
      serviceStartUtc: requestServiceLines.serviceStartUtc,
      serviceEndUtc: requestServiceLines.serviceEndUtc,
      serviceName: serviceCategories.name,
      serviceCode: serviceCategories.code,
      unitLabel: serviceCategories.unitLabel,
      airportIcao: airports.icao,
      airportName: airports.name,
      airportTimezone: airports.timezoneIana,
      fboName: fbos.name,
      aircraftTail: aircraft.tailNumber,
      aircraftModel: aircraft.model,
    })
    .from(providerOffers)
    .innerJoin(requestServiceLines, eq(requestServiceLines.id, providerOffers.requestServiceLineId))
    .innerJoin(requests, eq(requests.id, requestServiceLines.requestId))
    .innerJoin(serviceCategories, eq(serviceCategories.id, requestServiceLines.serviceCategoryId))
    .innerJoin(airports, eq(airports.id, requests.airportId))
    .leftJoin(fbos, eq(fbos.id, requests.fboId))
    .leftJoin(aircraft, eq(aircraft.id, requests.aircraftId))
    .where(
      and(
        eq(providerOffers.id, offerId),
        // Scoping in the WHERE clause, not in a later check: another company's offer is
        // simply not found.
        eq(providerOffers.providerCompanyId, providerCompanyId),
      ),
    )
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toQueueItem(row);
}

export interface AcknowledgedWork {
  readonly requestServiceLineId: string;
  readonly offerId: string;
  readonly reference: string;
  readonly serviceName: string;
  readonly serviceCode: string;
  readonly quantity: number;
  readonly unitLabel: string;
  readonly requirements: Record<string, unknown>;
  readonly airportLabel: string;
  readonly airportTimezone: string;
  readonly serviceStartUtc: Date | null;
  readonly serviceEndUtc: Date | null;
  readonly assignmentId: string | null;
  readonly assignedResourceCount: number;
  readonly lineStatus: string;
}

/**
 * Work this company has accepted: acknowledged lines awaiting resources, and assigned
 * lines already covered.
 */
export async function loadAcknowledgedWork(
  providerCompanyId: string,
  executor: Executor = getDb(),
): Promise<AcknowledgedWork[]> {
  const rows = await executor
    .select({
      requestServiceLineId: requestServiceLines.id,
      offerId: providerOffers.id,
      reference: requests.reference,
      serviceName: serviceCategories.name,
      serviceCode: serviceCategories.code,
      quantity: requestServiceLines.quantity,
      unitLabel: serviceCategories.unitLabel,
      requirements: requestServiceLines.requirementsJson,
      airportIcao: airports.icao,
      airportName: airports.name,
      airportTimezone: airports.timezoneIana,
      serviceStartUtc: requestServiceLines.serviceStartUtc,
      serviceEndUtc: requestServiceLines.serviceEndUtc,
      lineStatus: requestServiceLines.status,
      assignmentId: assignments.id,
      assignedResourceCount: sql<number>`(
        select count(*)::int from assignment_resources ar
        where ar.assignment_id = ${qualified(assignments.id)} and ar.released = false
      )`,
    })
    .from(providerOffers)
    .innerJoin(requestServiceLines, eq(requestServiceLines.id, providerOffers.requestServiceLineId))
    .innerJoin(requests, eq(requests.id, requestServiceLines.requestId))
    .innerJoin(serviceCategories, eq(serviceCategories.id, requestServiceLines.serviceCategoryId))
    .innerJoin(airports, eq(airports.id, requests.airportId))
    .leftJoin(
      assignments,
      and(
        eq(assignments.requestServiceLineId, requestServiceLines.id),
        sql`${assignments.status} <> 'cancelled'`,
      ),
    )
    .where(
      and(
        eq(providerOffers.providerCompanyId, providerCompanyId),
        eq(providerOffers.status, 'acknowledged'),
        sql`${requestServiceLines.status} in ('acknowledged', 'assigned', 'in_progress')`,
      ),
    )
    .orderBy(asc(requestServiceLines.serviceStartUtc), asc(requestServiceLines.id));

  return rows.map((row) => ({
    requestServiceLineId: row.requestServiceLineId,
    offerId: row.offerId,
    reference: row.reference,
    serviceName: row.serviceName,
    serviceCode: row.serviceCode,
    quantity: row.quantity,
    unitLabel: row.unitLabel,
    requirements: row.requirements,
    airportLabel: row.airportIcao ?? row.airportName,
    airportTimezone: row.airportTimezone,
    serviceStartUtc: row.serviceStartUtc,
    serviceEndUtc: row.serviceEndUtc,
    assignmentId: row.assignmentId,
    assignedResourceCount: row.assignedResourceCount ?? 0,
    lineStatus: row.lineStatus,
  }));
}

export interface AssignableResource {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly label: string;
  readonly detail: string;
  /** Commitments overlapping the line's window, so the UI can grey out what is busy. */
  readonly busy: boolean;
  readonly busyReason: string | null;
}

/**
 * The resources this company could commit to a given window.
 *
 * `busy` is a CONVENIENCE for the UI, not a guarantee. The database's exclusion
 * constraint is the guarantee; a dispatcher who submits anyway — or who races another
 * dispatcher — is refused at the point of writing, with a message naming the conflict
 * (CLAUDE.md §30).
 */
export async function loadAssignableResources(
  providerCompanyId: string,
  serviceCode: string,
  window: { readonly start: Date; readonly end: Date } | null,
  executor: Executor = getDb(),
): Promise<AssignableResource[]> {
  if (serviceCode === 'ground_transport') {
    const [fleet, crew] = await Promise.all([
      executor
        .select()
        .from(vehicles)
        .where(and(eq(vehicles.providerCompanyId, providerCompanyId), eq(vehicles.active, true)))
        .orderBy(asc(vehicles.vehicleClass), asc(vehicles.plateReference)),
      executor
        .select()
        .from(drivers)
        .where(and(eq(drivers.providerCompanyId, providerCompanyId), eq(drivers.active, true)))
        .orderBy(asc(drivers.fullName)),
    ]);

    const busy = await loadBusyResourceIds(providerCompanyId, window, executor);

    return [
      ...fleet.map((vehicle) => ({
        id: vehicle.id,
        kind: 'vehicle' as const,
        label: `${vehicle.make} ${vehicle.model}`,
        detail: `${vehicle.plateReference} · ${vehicle.vehicleClass} · ${vehicle.passengerCapacity} seats`,
        busy: busy.has(vehicle.id) || vehicle.status !== 'available',
        busyReason: busy.has(vehicle.id)
          ? 'already committed in this window'
          : vehicle.status !== 'available'
            ? vehicle.status
            : null,
      })),
      ...crew.map((driver) => ({
        id: driver.id,
        kind: 'driver' as const,
        label: driver.fullName,
        detail: driver.languages.length > 0 ? driver.languages.join(', ') : 'driver',
        busy: busy.has(driver.id) || driver.status !== 'available',
        busyReason: busy.has(driver.id)
          ? 'already committed in this window'
          : driver.status !== 'available'
            ? driver.status
            : null,
      })),
    ];
  }

  if (serviceCode === 'close_protection') {
    const roster = await executor
      .select()
      .from(securityOfficers)
      .where(
        and(
          eq(securityOfficers.providerCompanyId, providerCompanyId),
          eq(securityOfficers.active, true),
        ),
      )
      .orderBy(asc(securityOfficers.fullName));

    const busy = await loadBusyResourceIds(providerCompanyId, window, executor);

    return roster.map((officer) => ({
      id: officer.id,
      kind: 'officer' as const,
      label: officer.fullName,
      detail: officer.armedCertified ? 'armed certified' : 'unarmed',
      busy: busy.has(officer.id) || officer.status !== 'available',
      busyReason: busy.has(officer.id) ? 'already committed in this window' : null,
    }));
  }

  // Other services commit pooled capacity rather than a named object; the pool limit is
  // checked in the assignment transaction.
  return [];
}

/** Ids already committed by this company across the window. */
async function loadBusyResourceIds(
  providerCompanyId: string,
  window: { readonly start: Date; readonly end: Date } | null,
  executor: Executor,
): Promise<Set<string>> {
  if (window === null) return new Set();

  const rows = await executor
    .select({
      vehicleId: assignmentResources.vehicleId,
      driverId: assignmentResources.driverId,
      officerId: assignmentResources.officerId,
    })
    .from(assignmentResources)
    .innerJoin(assignments, eq(assignments.id, assignmentResources.assignmentId))
    .where(
      and(
        eq(assignments.providerCompanyId, providerCompanyId),
        eq(assignmentResources.released, false),
        sql`${assignments.status} <> 'cancelled'`,
        sql`tstzrange(${assignmentResources.startUtc}, ${assignmentResources.endUtc}, '[)')
            && tstzrange(${window.start.toISOString()}::timestamptz, ${window.end.toISOString()}::timestamptz, '[)')`,
      ),
    );

  const busy = new Set<string>();
  for (const row of rows) {
    for (const id of [row.vehicleId, row.driverId, row.officerId]) {
      if (id !== null) busy.add(id);
    }
  }
  return busy;
}

function toQueueItem(row: {
  offerId: string;
  requestServiceLineId: string;
  requestId: string;
  reference: string;
  sentAt: Date;
  expiresAt: Date;
  selectionReason: string;
  passengerCount: number;
  crewCount: number;
  arrivalUtc: Date | null;
  departureUtc: Date | null;
  priority: string;
  quantity: number;
  requirements: Record<string, unknown>;
  serviceStartUtc: Date | null;
  serviceEndUtc: Date | null;
  serviceName: string;
  serviceCode: string;
  unitLabel: string;
  airportIcao: string | null;
  airportName: string;
  airportTimezone: string;
  fboName: string | null;
  aircraftTail: string | null;
  aircraftModel: string | null;
}): QueueItem {
  return {
    offerId: row.offerId,
    requestServiceLineId: row.requestServiceLineId,
    requestId: row.requestId,
    reference: row.reference,
    serviceName: row.serviceName,
    serviceCode: row.serviceCode,
    unitLabel: row.unitLabel,
    quantity: row.quantity,
    requirements: row.requirements,
    airportLabel: row.airportIcao ?? row.airportName,
    airportTimezone: row.airportTimezone,
    fboName: row.fboName,
    aircraftLabel:
      row.aircraftTail === null ? null : `${row.aircraftTail}${row.aircraftModel === null ? '' : ` · ${row.aircraftModel}`}`,
    passengerCount: row.passengerCount,
    crewCount: row.crewCount,
    arrivalUtc: row.arrivalUtc,
    departureUtc: row.departureUtc,
    serviceStartUtc: row.serviceStartUtc,
    serviceEndUtc: row.serviceEndUtc,
    sentAt: row.sentAt,
    expiresAt: row.expiresAt,
    selectionReason: row.selectionReason,
    priority: row.priority,
  };
}
