import '@/lib/server-guard';
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { getDb, type Executor } from '@/db/client';
import { qualified } from '@/db/sql';
import {
  aircraft,
  airports,
  assignmentResources,
  assignments,
  auditEvents,
  clientOrganizations,
  drivers,
  fbos,
  matchAttempts,
  providerCompanies,
  providerOffers,
  requestPassengers,
  requestServiceLines,
  requests,
  securityOfficers,
  serviceCategories,
  users,
  vehicles,
} from '@/db/schema';
import type { RequestLineStatus, RequestPriority, RequestStatus } from '@/db/schema/enums';

/**
 * Read models for the Operations Portal (CLAUDE.md §12).
 *
 * Operations sees everything, so these queries are NOT tenant-scoped — the permission
 * layer decides who may call them. What they are careful about instead is ORDERING: every
 * list has a deterministic order down to the id (CLAUDE.md §33), because a list that
 * reshuffles between refreshes is unusable on a busy shift.
 */

export interface RequestFilters {
  readonly status?: readonly RequestStatus[];
  readonly airportId?: string;
  readonly clientOrganizationId?: string;
  readonly serviceCategoryId?: string;
  readonly providerCompanyId?: string;
  readonly priority?: readonly RequestPriority[];
  /** Only requests with at least one line past its acknowledgement deadline. */
  readonly overdueOnly?: boolean;
  /** Only requests with at least one line needing operations attention. */
  readonly exceptionsOnly?: boolean;
  readonly search?: string;
  readonly fromUtc?: Date;
  readonly toUtc?: Date;
  readonly limit?: number;
}

export interface RequestListRow {
  readonly id: string;
  readonly reference: string;
  readonly status: RequestStatus;
  readonly priority: RequestPriority;
  readonly clientName: string;
  readonly airportLabel: string;
  readonly airportTimezone: string;
  readonly fboName: string | null;
  readonly arrivalUtc: Date | null;
  readonly departureUtc: Date | null;
  readonly passengerCount: number;
  readonly lineCount: number;
  readonly coveredCount: number;
  readonly awaitingCount: number;
  readonly failedCount: number;
  readonly nextDeadlineUtc: Date | null;
  readonly providerNames: string;
}

export async function loadRequestList(
  filters: RequestFilters = {},
  executor: Executor = getDb(),
): Promise<RequestListRow[]> {
  const conditions = [];

  if (filters.status !== undefined && filters.status.length > 0) {
    conditions.push(inArray(requests.status, [...filters.status]));
  }
  if (filters.priority !== undefined && filters.priority.length > 0) {
    conditions.push(inArray(requests.priority, [...filters.priority]));
  }
  if (filters.airportId !== undefined) {
    conditions.push(eq(requests.airportId, filters.airportId));
  }
  if (filters.clientOrganizationId !== undefined) {
    conditions.push(eq(requests.clientOrganizationId, filters.clientOrganizationId));
  }
  if (filters.fromUtc !== undefined) {
    conditions.push(gte(requests.arrivalUtc, filters.fromUtc));
  }
  if (filters.toUtc !== undefined) {
    conditions.push(lte(requests.arrivalUtc, filters.toUtc));
  }
  if (filters.search !== undefined && filters.search.trim().length > 0) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        ilike(requests.reference, term),
        ilike(clientOrganizations.name, term),
        ilike(airports.name, term),
        ilike(airports.icao, term),
      ),
    );
  }
  if (filters.serviceCategoryId !== undefined) {
    conditions.push(sql`exists (
      select 1 from request_service_lines l
      where l.request_id = ${qualified(requests.id)}
        and l.service_category_id = ${filters.serviceCategoryId}::uuid
    )`);
  }
  if (filters.providerCompanyId !== undefined) {
    conditions.push(sql`exists (
      select 1 from request_service_lines l
      join provider_offers o on o.request_service_line_id = l.id
      where l.request_id = ${qualified(requests.id)}
        and o.provider_company_id = ${filters.providerCompanyId}::uuid
    )`);
  }
  if (filters.overdueOnly === true) {
    conditions.push(sql`exists (
      select 1 from request_service_lines l
      where l.request_id = ${qualified(requests.id)}
        and l.acknowledgement_deadline_utc is not null
        and l.acknowledgement_deadline_utc <= now()
        and l.status in ('offered', 'waiting')
    )`);
  }
  if (filters.exceptionsOnly === true) {
    conditions.push(sql`exists (
      select 1 from request_service_lines l
      where l.request_id = ${qualified(requests.id)} and l.status = 'failed'
    )`);
  }

  const rows = await executor
    .select({
      id: requests.id,
      reference: requests.reference,
      status: requests.status,
      priority: requests.priority,
      clientName: clientOrganizations.name,
      airportIcao: airports.icao,
      airportName: airports.name,
      airportTimezone: airports.timezoneIana,
      fboName: fbos.name,
      arrivalUtc: requests.arrivalUtc,
      departureUtc: requests.departureUtc,
      passengerCount: requests.passengerCount,
      lineCount: sql<number>`(
        select count(*)::int from request_service_lines l
        where l.request_id = ${qualified(requests.id)} and l.status <> 'cancelled'
      )`,
      coveredCount: sql<number>`(
        select count(*)::int from request_service_lines l
        where l.request_id = ${qualified(requests.id)}
          and l.status in ('acknowledged', 'assigned', 'in_progress', 'completed')
      )`,
      awaitingCount: sql<number>`(
        select count(*)::int from request_service_lines l
        where l.request_id = ${qualified(requests.id)} and l.status in ('offered', 'waiting')
      )`,
      failedCount: sql<number>`(
        select count(*)::int from request_service_lines l
        where l.request_id = ${qualified(requests.id)} and l.status = 'failed'
      )`,
      // Raw SQL expressions come back from the driver as STRINGS — Drizzle only applies
      // its `mode: 'date'` mapping to declared columns. Typing this as Date would be a
      // lie that only surfaces when something calls .getTime() on it.
      nextDeadlineUtc: sql<string | null>`(
        select min(l.acknowledgement_deadline_utc) from request_service_lines l
        where l.request_id = ${qualified(requests.id)} and l.status in ('offered', 'waiting')
      )`,
      providerNames: sql<string>`(
        select coalesce(string_agg(distinct p.display_name, ', ' order by p.display_name), '')
        from request_service_lines l
        join provider_offers o on o.request_service_line_id = l.id
        join provider_companies p on p.id = o.provider_company_id
        where l.request_id = ${qualified(requests.id)}
          and o.status in ('sent', 'acknowledged')
      )`,
    })
    .from(requests)
    .innerJoin(clientOrganizations, eq(clientOrganizations.id, requests.clientOrganizationId))
    .innerJoin(airports, eq(airports.id, requests.airportId))
    .leftJoin(fbos, eq(fbos.id, requests.fboId))
    .where(conditions.length === 0 ? undefined : and(...conditions))
    // Soonest arrival first; requests with no arrival sort last. Deterministic to the id.
    .orderBy(asc(requests.arrivalUtc), asc(requests.reference), asc(requests.id))
    .limit(filters.limit ?? 200);

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    priority: row.priority,
    clientName: row.clientName,
    airportLabel: row.airportIcao ?? row.airportName,
    airportTimezone: row.airportTimezone,
    fboName: row.fboName,
    arrivalUtc: row.arrivalUtc,
    departureUtc: row.departureUtc,
    passengerCount: row.passengerCount,
    lineCount: row.lineCount,
    coveredCount: row.coveredCount,
    awaitingCount: row.awaitingCount,
    failedCount: row.failedCount,
    nextDeadlineUtc: row.nextDeadlineUtc === null ? null : new Date(row.nextDeadlineUtc),
    providerNames: row.providerNames,
  }));
}

// ---------------------------------------------------------------------------
// request detail
// ---------------------------------------------------------------------------

export interface RequestDetailLine {
  readonly id: string;
  readonly sequence: number;
  readonly serviceName: string;
  readonly serviceCode: string;
  readonly unitLabel: string;
  readonly quantity: number;
  readonly requirements: Record<string, unknown>;
  readonly status: RequestLineStatus;
  readonly serviceStartUtc: Date | null;
  readonly serviceEndUtc: Date | null;
  readonly acknowledgementDeadlineUtc: Date | null;
  readonly rematchCount: number;
  readonly failureReason: string | null;
  readonly modelExplanation: string | null;
  readonly modelVerified: boolean | null;
  readonly selectionSource: string | null;
  readonly currentProviderName: string | null;
  readonly currentProviderId: string | null;
  readonly currentOfferStatus: string | null;
  readonly assignmentId: string | null;
  readonly assignedResources: readonly { kind: string; label: string }[];
}

export interface RequestDetail {
  readonly id: string;
  readonly reference: string;
  readonly status: RequestStatus;
  readonly priority: RequestPriority;
  readonly sourceSentence: string;
  readonly createdVia: string;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
  readonly cancellationReason: string | null;
  readonly operationalNotes: string;

  readonly clientName: string;
  readonly clientId: string;

  readonly airportId: string;
  readonly airportLabel: string;
  readonly airportCity: string;
  readonly airportTimezone: string;
  readonly airportLatitude: string;
  readonly airportLongitude: string;
  readonly fboName: string | null;

  readonly aircraftLabel: string | null;
  readonly aircraftDimensions: string | null;

  readonly arrivalUtc: Date | null;
  readonly departureUtc: Date | null;
  readonly passengerCount: number;
  readonly crewCount: number;

  readonly lines: readonly RequestDetailLine[];
  readonly passengers: readonly {
    readonly fullName: string;
    readonly personType: string;
    readonly phone: string | null;
    readonly email: string | null;
    readonly isPrimary: boolean;
  }[];
}

export async function loadRequestDetail(
  requestId: string,
  executor: Executor = getDb(),
): Promise<RequestDetail | null> {
  const [row] = await executor
    .select({
      id: requests.id,
      reference: requests.reference,
      status: requests.status,
      priority: requests.priority,
      sourceSentence: requests.sourceSentence,
      createdVia: requests.createdVia,
      createdAt: requests.createdAt,
      confirmedAt: requests.confirmedAt,
      cancellationReason: requests.cancellationReason,
      operationalNotes: requests.operationalNotes,
      clientName: clientOrganizations.name,
      clientId: clientOrganizations.id,
      airportId: airports.id,
      airportIcao: airports.icao,
      airportName: airports.name,
      airportCity: airports.city,
      airportTimezone: airports.timezoneIana,
      airportLatitude: airports.latitude,
      airportLongitude: airports.longitude,
      fboName: fbos.name,
      aircraftTail: aircraft.tailNumber,
      aircraftModel: aircraft.model,
      aircraftWingspan: aircraft.wingspanFt,
      aircraftLength: aircraft.lengthFt,
      aircraftTailHeight: aircraft.tailHeightFt,
      arrivalUtc: requests.arrivalUtc,
      departureUtc: requests.departureUtc,
      passengerCount: requests.passengerCount,
      crewCount: requests.crewCount,
    })
    .from(requests)
    .innerJoin(clientOrganizations, eq(clientOrganizations.id, requests.clientOrganizationId))
    .innerJoin(airports, eq(airports.id, requests.airportId))
    .leftJoin(fbos, eq(fbos.id, requests.fboId))
    .leftJoin(aircraft, eq(aircraft.id, requests.aircraftId))
    .where(eq(requests.id, requestId))
    .limit(1);

  if (row === undefined) return null;

  const lineRows = await executor
    .select({
      id: requestServiceLines.id,
      sequence: requestServiceLines.sequence,
      serviceName: serviceCategories.name,
      serviceCode: serviceCategories.code,
      unitLabel: serviceCategories.unitLabel,
      quantity: requestServiceLines.quantity,
      requirements: requestServiceLines.requirementsJson,
      status: requestServiceLines.status,
      serviceStartUtc: requestServiceLines.serviceStartUtc,
      serviceEndUtc: requestServiceLines.serviceEndUtc,
      acknowledgementDeadlineUtc: requestServiceLines.acknowledgementDeadlineUtc,
      rematchCount: requestServiceLines.rematchCount,
      failureReason: requestServiceLines.failureReason,
      modelExplanation: requestServiceLines.modelExplanation,
      modelVerified: requestServiceLines.modelVerified,
      selectionSource: requestServiceLines.selectionSource,
      currentProviderName: providerCompanies.displayName,
      currentProviderId: providerCompanies.id,
      currentOfferStatus: providerOffers.status,
      assignmentId: assignments.id,
    })
    .from(requestServiceLines)
    .innerJoin(serviceCategories, eq(serviceCategories.id, requestServiceLines.serviceCategoryId))
    .leftJoin(
      providerOffers,
      and(
        eq(providerOffers.requestServiceLineId, requestServiceLines.id),
        sql`${providerOffers.status} in ('sent', 'acknowledged')`,
      ),
    )
    .leftJoin(providerCompanies, eq(providerCompanies.id, providerOffers.providerCompanyId))
    .leftJoin(
      assignments,
      and(
        eq(assignments.requestServiceLineId, requestServiceLines.id),
        sql`${assignments.status} <> 'cancelled'`,
      ),
    )
    .where(eq(requestServiceLines.requestId, requestId))
    .orderBy(asc(requestServiceLines.sequence), asc(requestServiceLines.id));

  const assignmentIds = lineRows
    .map((line) => line.assignmentId)
    .filter((id): id is string => id !== null);

  const resourcesByAssignment = await loadAssignedResources(assignmentIds, executor);

  const passengerRows = await executor
    .select({
      fullName: requestPassengers.fullName,
      personType: requestPassengers.personType,
      phone: requestPassengers.phone,
      email: requestPassengers.email,
      isPrimary: requestPassengers.isPrimary,
    })
    .from(requestPassengers)
    .where(eq(requestPassengers.requestId, requestId))
    .orderBy(
      desc(requestPassengers.isPrimary),
      asc(requestPassengers.sortOrder),
      asc(requestPassengers.id),
    );

  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    priority: row.priority,
    sourceSentence: row.sourceSentence,
    createdVia: row.createdVia,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    cancellationReason: row.cancellationReason,
    operationalNotes: row.operationalNotes,
    clientName: row.clientName,
    clientId: row.clientId,
    airportId: row.airportId,
    airportLabel: row.airportIcao === null ? row.airportName : `${row.airportName} (${row.airportIcao})`,
    airportCity: row.airportCity,
    airportTimezone: row.airportTimezone,
    airportLatitude: row.airportLatitude,
    airportLongitude: row.airportLongitude,
    fboName: row.fboName,
    aircraftLabel:
      row.aircraftTail === null
        ? null
        : `${row.aircraftTail}${row.aircraftModel === null ? '' : ` · ${row.aircraftModel}`}`,
    aircraftDimensions:
      row.aircraftWingspan === null
        ? null
        : `${row.aircraftWingspan} ft span · ${row.aircraftLength ?? '?'} ft long · ${row.aircraftTailHeight ?? '?'} ft tail`,
    arrivalUtc: row.arrivalUtc,
    departureUtc: row.departureUtc,
    passengerCount: row.passengerCount,
    crewCount: row.crewCount,
    lines: lineRows.map((line) => ({
      ...line,
      assignedResources: line.assignmentId === null ? [] : (resourcesByAssignment.get(line.assignmentId) ?? []),
    })),
    passengers: passengerRows,
  };
}

/** Human labels for the concrete resources committed to each assignment. */
async function loadAssignedResources(
  assignmentIds: readonly string[],
  executor: Executor,
): Promise<Map<string, { kind: string; label: string }[]>> {
  if (assignmentIds.length === 0) return new Map();

  const rows = await executor
    .select({
      assignmentId: assignmentResources.assignmentId,
      kind: assignmentResources.resourceKind,
      quantity: assignmentResources.quantity,
      vehicleMake: vehicles.make,
      vehicleModel: vehicles.model,
      vehiclePlate: vehicles.plateReference,
      driverName: drivers.fullName,
      officerName: securityOfficers.fullName,
    })
    .from(assignmentResources)
    .leftJoin(vehicles, eq(vehicles.id, assignmentResources.vehicleId))
    .leftJoin(drivers, eq(drivers.id, assignmentResources.driverId))
    .leftJoin(securityOfficers, eq(securityOfficers.id, assignmentResources.officerId))
    .where(
      and(
        inArray(assignmentResources.assignmentId, [...assignmentIds]),
        eq(assignmentResources.released, false),
      ),
    )
    .orderBy(asc(assignmentResources.resourceKind), asc(assignmentResources.id));

  const grouped = new Map<string, { kind: string; label: string }[]>();
  for (const row of rows) {
    const label =
      row.vehiclePlate !== null
        ? `${row.vehicleMake} ${row.vehicleModel} (${row.vehiclePlate})`
        : (row.driverName ?? row.officerName ?? `${row.quantity} × ${row.kind}`);

    grouped.set(row.assignmentId, [
      ...(grouped.get(row.assignmentId) ?? []),
      { kind: row.kind, label },
    ]);
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// decision trace
// ---------------------------------------------------------------------------

export interface TraceCandidate {
  readonly providerCompanyId: string;
  readonly providerName: string;
  readonly eligible: boolean;
  readonly reasonCodes: readonly string[];
  readonly spareCapacity: number;
  readonly leadTimeMarginMinutes: number | null;
}

export interface TraceAttempt {
  readonly attemptNumber: number;
  readonly evaluatedAt: Date;
  readonly evaluationNowUtc: Date;
  readonly engineVersion: string;
  readonly eligible: readonly TraceCandidate[];
  readonly rejected: readonly TraceCandidate[];
  readonly chosenProviderName: string | null;
  readonly deterministicTopName: string | null;
  readonly aiConsulted: boolean;
  readonly aiVerified: boolean | null;
  readonly aiReason: string | null;
  readonly aiConfidence: string | null;
  readonly fallbackReason: string | null;
}

/** Every evaluation of a line, newest attempt last — the order a person reads it in. */
export async function loadDecisionTrace(
  requestServiceLineId: string,
  executor: Executor = getDb(),
): Promise<TraceAttempt[]> {
  const rows = await executor
    .select({
      attemptNumber: matchAttempts.attemptNumber,
      evaluatedAt: matchAttempts.evaluatedAt,
      evaluationNowUtc: matchAttempts.evaluationNowUtc,
      engineVersion: matchAttempts.engineVersion,
      eligibleCandidates: matchAttempts.eligibleCandidates,
      rejectedCandidates: matchAttempts.rejectedCandidates,
      aiConsulted: matchAttempts.aiConsulted,
      aiVerified: matchAttempts.aiVerified,
      aiReason: matchAttempts.aiReason,
      aiConfidence: matchAttempts.aiConfidence,
      fallbackReason: matchAttempts.fallbackReason,
      chosenProviderId: matchAttempts.chosenProviderId,
      deterministicTopId: matchAttempts.deterministicTopId,
    })
    .from(matchAttempts)
    .where(eq(matchAttempts.requestServiceLineId, requestServiceLineId))
    .orderBy(asc(matchAttempts.attemptNumber));

  if (rows.length === 0) return [];

  // Resolve the two provider references to names in one query.
  const ids = [
    ...new Set(
      rows.flatMap((row) => [row.chosenProviderId, row.deterministicTopId]).filter((id): id is string => id !== null),
    ),
  ];

  const names = new Map<string, string>();
  if (ids.length > 0) {
    const providerRows = await executor
      .select({ id: providerCompanies.id, displayName: providerCompanies.displayName })
      .from(providerCompanies)
      .where(inArray(providerCompanies.id, ids));
    for (const provider of providerRows) names.set(provider.id, provider.displayName);
  }

  return rows.map((row) => ({
    attemptNumber: row.attemptNumber,
    evaluatedAt: row.evaluatedAt,
    evaluationNowUtc: row.evaluationNowUtc,
    engineVersion: row.engineVersion,
    eligible: row.eligibleCandidates.map(toTraceCandidate),
    rejected: row.rejectedCandidates.map(toTraceCandidate),
    chosenProviderName: row.chosenProviderId === null ? null : (names.get(row.chosenProviderId) ?? null),
    deterministicTopName:
      row.deterministicTopId === null ? null : (names.get(row.deterministicTopId) ?? null),
    aiConsulted: row.aiConsulted,
    aiVerified: row.aiVerified,
    aiReason: row.aiReason,
    aiConfidence: row.aiConfidence,
    fallbackReason: row.fallbackReason,
  }));
}

function toTraceCandidate(candidate: {
  providerCompanyId: string;
  providerName: string;
  eligible: boolean;
  reasonCodes: readonly string[];
  spareCapacity: number;
  leadTimeMarginMinutes: number | null;
}): TraceCandidate {
  return {
    providerCompanyId: candidate.providerCompanyId,
    providerName: candidate.providerName,
    eligible: candidate.eligible,
    reasonCodes: candidate.reasonCodes,
    spareCapacity: candidate.spareCapacity,
    leadTimeMarginMinutes: candidate.leadTimeMarginMinutes,
  };
}

// ---------------------------------------------------------------------------
// offer history and audit
// ---------------------------------------------------------------------------

export interface OfferHistoryRow {
  readonly id: string;
  readonly attemptNumber: number;
  readonly providerName: string;
  readonly status: string;
  readonly selectionSource: string;
  readonly selectionReason: string;
  readonly sentAt: Date;
  readonly expiresAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly declinedAt: Date | null;
  readonly declineReason: string | null;
  readonly expiredAt: Date | null;
}

export async function loadOfferHistory(
  requestServiceLineId: string,
  executor: Executor = getDb(),
): Promise<OfferHistoryRow[]> {
  return executor
    .select({
      id: providerOffers.id,
      attemptNumber: providerOffers.attemptNumber,
      providerName: providerCompanies.displayName,
      status: providerOffers.status,
      selectionSource: providerOffers.selectionSource,
      selectionReason: providerOffers.selectionReason,
      sentAt: providerOffers.sentAt,
      expiresAt: providerOffers.expiresAt,
      acknowledgedAt: providerOffers.acknowledgedAt,
      declinedAt: providerOffers.declinedAt,
      declineReason: providerOffers.declineReason,
      expiredAt: providerOffers.expiredAt,
    })
    .from(providerOffers)
    .innerJoin(providerCompanies, eq(providerCompanies.id, providerOffers.providerCompanyId))
    .where(eq(providerOffers.requestServiceLineId, requestServiceLineId))
    .orderBy(asc(providerOffers.attemptNumber), asc(providerOffers.id));
}

export interface AuditRow {
  readonly id: number;
  readonly occurredAt: Date;
  readonly action: string;
  readonly actorLabel: string;
  readonly actorName: string | null;
  readonly reason: string | null;
  readonly entityType: string;
}

/** The audit trail for a request and everything beneath it. */
export async function loadRequestAudit(
  requestId: string,
  executor: Executor = getDb(),
): Promise<AuditRow[]> {
  const rows = await executor
    .select({
      id: auditEvents.id,
      occurredAt: auditEvents.occurredAt,
      action: auditEvents.action,
      actorLabel: auditEvents.actorLabel,
      actorName: users.fullName,
      reason: auditEvents.reason,
      entityType: auditEvents.entityType,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(sql`${auditEvents.entityId} in (
      select ${requestId}::text
      union select l.id::text from request_service_lines l where l.request_id = ${requestId}::uuid
      union select o.id::text from provider_offers o
        join request_service_lines l on l.id = o.request_service_line_id
        where l.request_id = ${requestId}::uuid
      union select a.id::text from assignments a
        join request_service_lines l on l.id = a.request_service_line_id
        where l.request_id = ${requestId}::uuid
    )`)
    .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));

  return rows;
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  readonly arrivalsToday: number;
  readonly activeRequests: number;
  readonly awaitingAcknowledgement: number;
  readonly overdue: number;
  readonly exceptions: number;
  readonly completedToday: number;
  readonly servicesAtRisk: number;
}

export async function loadDashboardSummary(
  now: Date,
  executor: Executor = getDb(),
): Promise<DashboardSummary> {
  const dayStart = new Date(now.getTime() - 12 * 3_600_000);
  const dayEnd = new Date(now.getTime() + 36 * 3_600_000);

  const [row] = await executor
    .select({
      arrivalsToday: sql<number>`count(*) filter (
        where ${requests.arrivalUtc} between ${dayStart} and ${dayEnd}
          and ${requests.status} <> 'cancelled'
      )::int`,
      activeRequests: sql<number>`count(*) filter (
        where ${requests.status} in ('sent','sourcing','partial','confirmed','in_progress')
      )::int`,
      completedToday: sql<number>`count(*) filter (
        where ${requests.status} = 'completed' and ${requests.completedAt} >= ${dayStart}
      )::int`,
    })
    .from(requests);

  const [lineRow] = await executor
    .select({
      awaiting: sql<number>`count(*) filter (where ${requestServiceLines.status} in ('offered','waiting'))::int`,
      overdue: sql<number>`count(*) filter (
        where ${requestServiceLines.status} in ('offered','waiting')
          and ${requestServiceLines.acknowledgementDeadlineUtc} <= ${now}
      )::int`,
      exceptions: sql<number>`count(*) filter (where ${requestServiceLines.status} = 'failed')::int`,
      atRisk: sql<number>`count(*) filter (
        where ${requestServiceLines.status} not in ('acknowledged','assigned','in_progress','completed','cancelled')
          and ${requestServiceLines.serviceStartUtc} is not null
          and ${requestServiceLines.serviceStartUtc} <= ${new Date(now.getTime() + 6 * 3_600_000)}
      )::int`,
    })
    .from(requestServiceLines);

  return {
    arrivalsToday: row?.arrivalsToday ?? 0,
    activeRequests: row?.activeRequests ?? 0,
    completedToday: row?.completedToday ?? 0,
    awaitingAcknowledgement: lineRow?.awaiting ?? 0,
    overdue: lineRow?.overdue ?? 0,
    exceptions: lineRow?.exceptions ?? 0,
    servicesAtRisk: lineRow?.atRisk ?? 0,
  };
}

/** Filter options, read from the live data rather than hard-coded. */
export async function loadFilterOptions(executor: Executor = getDb()) {
  const [airportRows, clientRows, serviceRows, providerRows] = await Promise.all([
    executor
      .select({ id: airports.id, icao: airports.icao, name: airports.name })
      .from(airports)
      .where(eq(airports.active, true))
      .orderBy(asc(airports.icao), asc(airports.name)),
    executor
      .select({ id: clientOrganizations.id, name: clientOrganizations.name })
      .from(clientOrganizations)
      .where(eq(clientOrganizations.active, true))
      .orderBy(asc(clientOrganizations.name)),
    executor
      .select({ id: serviceCategories.id, name: serviceCategories.name })
      .from(serviceCategories)
      .where(eq(serviceCategories.active, true))
      .orderBy(asc(serviceCategories.sortOrder), asc(serviceCategories.name)),
    executor
      .select({ id: providerCompanies.id, name: providerCompanies.displayName })
      .from(providerCompanies)
      .where(eq(providerCompanies.status, 'approved'))
      .orderBy(asc(providerCompanies.displayName)),
  ]);

  return { airports: airportRows, clients: clientRows, services: serviceRows, providers: providerRows };
}

/** A provider Operations may legitimately hand a service line to. */
export interface OverrideCandidate {
  readonly providerCompanyId: string;
  readonly displayName: string;
  readonly rank: number;
  /** True when this provider has already declined or let an offer expire on this line. */
  readonly previouslyRefused: boolean;
}

/**
 * Approved providers that actually cover each line's service at this request's airport.
 *
 * This is the list the override control offers, and it matches the check
 * {@link import('@/services/interventions').overrideProvider} performs server-side: an
 * override is a judgement about *ranking*, never a licence to send work to a company that
 * cannot do it. A provider that already refused this line is still listed — Operations may
 * have spoken to them since — but it is labelled, so the choice is made knowingly.
 *
 * One query for the whole request, not one per line.
 */
export async function loadOverrideCandidates(
  requestId: string,
  executor: Executor = getDb(),
): Promise<ReadonlyMap<string, readonly OverrideCandidate[]>> {
  const result = await executor.execute<{
    line_id: string;
    provider_company_id: string;
    display_name: string;
    rank: number;
    previously_refused: boolean;
  }>(sql`
    select
      l.id                as line_id,
      p.id                as provider_company_id,
      p.display_name      as display_name,
      p.rank              as rank,
      exists (
        select 1 from provider_offers o
        where o.request_service_line_id = l.id
          and o.provider_company_id = p.id
          and o.status in ('declined', 'expired')
      )                   as previously_refused
    from request_service_lines l
    join requests r on r.id = l.request_id
    join provider_coverage pc
      on pc.service_category_id = l.service_category_id
     and pc.airport_id = r.airport_id
     and pc.active
    join provider_companies p
      on p.id = pc.provider_company_id
     and p.status = 'approved'
     and p.active
    where l.request_id = ${requestId}::uuid
    group by l.id, p.id, p.display_name, p.rank
    order by l.id, p.rank asc, p.display_name asc, p.id asc
  `);

  const byLine = new Map<string, OverrideCandidate[]>();
  for (const row of result.rows) {
    const list = byLine.get(row.line_id) ?? [];
    list.push({
      providerCompanyId: row.provider_company_id,
      displayName: row.display_name,
      rank: row.rank,
      previouslyRefused: row.previously_refused,
    });
    byLine.set(row.line_id, list);
  }
  return byLine;
}

/**
 * Governance oversight of a request (CLAUDE.md §14 "Requests: all requests, full trace,
 * provider offers, overrides, failures, audit").
 *
 * What Admin needs that Operations does not: how often a person overruled the engine, how
 * often the model's choice failed verification, and how much of the trail exists. These are
 * the numbers that answer "is this platform being operated properly", which is a different
 * question from "is this trip covered".
 */
export interface RequestOversightRow {
  readonly id: string;
  readonly reference: string;
  readonly status: RequestStatus;
  readonly clientName: string;
  readonly airportLabel: string;
  readonly createdAt: Date;
  readonly createdVia: string;
  readonly lineCount: number;
  readonly failedLines: number;
  readonly offerCount: number;
  readonly declinedOffers: number;
  readonly expiredOffers: number;
  readonly overrideCount: number;
  readonly aiSelections: number;
  readonly aiUnverified: number;
  readonly auditEventCount: number;
  readonly totalRematches: number;
}

export async function loadRequestOversight(
  options: { readonly limit?: number } = {},
  executor: Executor = getDb(),
): Promise<readonly RequestOversightRow[]> {
  const result = await executor.execute<{
    id: string;
    reference: string;
    status: RequestStatus;
    client_name: string;
    airport_label: string;
    created_at: Date;
    created_via: string;
    line_count: number;
    failed_lines: number;
    offer_count: number;
    declined_offers: number;
    expired_offers: number;
    override_count: number;
    ai_selections: number;
    ai_unverified: number;
    audit_event_count: number;
    total_rematches: number;
  }>(sql`
    select
      r.id,
      r.reference,
      r.status,
      c.name                                  as client_name,
      coalesce(a.icao, a.iata, a.name)        as airport_label,
      r.created_at,
      r.created_via,
      (select count(*)::int from request_service_lines l where l.request_id = r.id)
                                              as line_count,
      (select count(*)::int from request_service_lines l
        where l.request_id = r.id and l.status = 'failed')
                                              as failed_lines,
      (select coalesce(sum(l.rematch_count), 0)::int from request_service_lines l
        where l.request_id = r.id)            as total_rematches,
      (select count(*)::int from provider_offers o
        join request_service_lines l on l.id = o.request_service_line_id
        where l.request_id = r.id)            as offer_count,
      (select count(*)::int from provider_offers o
        join request_service_lines l on l.id = o.request_service_line_id
        where l.request_id = r.id and o.status = 'declined')
                                              as declined_offers,
      (select count(*)::int from provider_offers o
        join request_service_lines l on l.id = o.request_service_line_id
        where l.request_id = r.id and o.status = 'expired')
                                              as expired_offers,
      -- An override is an audit event against one of this request's lines.
      (select count(*)::int from audit_events e
        where e.action like 'request%override%'
          and e.entity_id in (
            select l.id::text from request_service_lines l where l.request_id = r.id
          ))                                  as override_count,
      (select count(*)::int from match_attempts m
        join request_service_lines l on l.id = m.request_service_line_id
        where l.request_id = r.id and m.ai_consulted)
                                              as ai_selections,
      -- "is not true" deliberately counts NULL as well as false: an attempt where the
      -- model was consulted but verification never recorded a verdict is exactly as
      -- interesting to a governance reader as one that failed it.
      (select count(*)::int from match_attempts m
        join request_service_lines l on l.id = m.request_service_line_id
        where l.request_id = r.id
          and m.ai_consulted
          and m.ai_verified is not true)      as ai_unverified,
      (select count(*)::int from audit_events e
        where e.entity_id = r.id::text
           or e.entity_id in (
             select l.id::text from request_service_lines l where l.request_id = r.id
           ))                                 as audit_event_count
    from requests r
    join client_organizations c on c.id = r.client_organization_id
    join airports a on a.id = r.airport_id
    order by r.created_at desc, r.id desc
    limit ${options.limit ?? 200}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    clientName: row.client_name,
    airportLabel: row.airport_label,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    createdVia: row.created_via,
    lineCount: row.line_count,
    failedLines: row.failed_lines,
    offerCount: row.offer_count,
    declinedOffers: row.declined_offers,
    expiredOffers: row.expired_offers,
    overrideCount: row.override_count,
    aiSelections: row.ai_selections,
    aiUnverified: row.ai_unverified,
    auditEventCount: row.audit_event_count,
    totalRematches: row.total_rematches,
  }));
}
