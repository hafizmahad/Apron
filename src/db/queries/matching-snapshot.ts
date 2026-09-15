import '@/lib/server-guard';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, type Executor } from '@/db/client';
import { qualified } from '@/db/sql';
import {
  aircraft,
  airports,
  assignmentResources,
  assignments,
  cateringCapabilities,
  drivers,
  fuelCapabilities,
  hangarResources,
  hotelProperties,
  hotelRoomTypes,
  providerBlackouts,
  providerCompanies,
  providerCoverage,
  requestServiceLines,
  requests,
  securityOfficers,
  serviceCategories,
  vehicles,
} from '@/db/schema';
import { ApronError } from '@/lib/errors';
import { makeInterval, type Interval } from '@/lib/time';
import {
  emptyProviderResources,
  type AircraftSnapshot,
  type EligibilityInput,
  type MatchingContext,
  type OpeningSchedule,
  type ProviderCandidate,
  type ProviderResources,
  type ResourceCommitment,
  type ServiceLineSnapshot,
} from '@/domain/matching';

/**
 * Loads the database into the immutable snapshot the pure engine consumes (ADR-009).
 *
 * This module is the ONLY bridge between persistence and `src/domain/matching`'s pure
 * functions, and it lives HERE rather than inside that directory precisely because it
 * imports the database — a boundary test fails the build if anything under
 * `src/domain/matching/` ever gains such an import. The engine cannot reach the database;
 * the database reaches the engine only by handing it a finished snapshot. That separation
 * is what makes a stored decision trace reproducible months later.
 *
 * It is deliberately read-only and deliberately eager: everything a candidate needs is
 * loaded up front so evaluation is a pure function of a single snapshot, rather than a
 * sequence of lazy queries whose results could shift mid-evaluation.
 */

export interface LoadedLine {
  readonly line: ServiceLineSnapshot;
  readonly context: MatchingContext;
  readonly serviceCode: string;
}

/**
 * Builds the full evaluation input for one service line.
 *
 * `evaluationNow` is supplied by the caller — the worker passes the job's start instant,
 * a re-match passes its own. Nothing here reads the clock.
 */
export async function loadEligibilityInput(
  requestServiceLineId: string,
  evaluationNow: Date,
  options: {
    readonly excludedProviderIds?: readonly string[];
    readonly executor?: Executor;
  } = {},
): Promise<EligibilityInput> {
  const executor = options.executor ?? getDb();

  // --- the line and its request ------------------------------------------
  const [row] = await executor
    .select({
      lineId: requestServiceLines.id,
      quantity: requestServiceLines.quantity,
      requirements: requestServiceLines.requirementsJson,
      serviceStartUtc: requestServiceLines.serviceStartUtc,
      serviceEndUtc: requestServiceLines.serviceEndUtc,

      serviceCategoryId: serviceCategories.id,
      serviceCode: serviceCategories.code,
      assignmentStrategy: serviceCategories.assignmentStrategy,

      requestId: requests.id,
      airportId: requests.airportId,
      fboId: requests.fboId,
      passengerCount: requests.passengerCount,
      crewCount: requests.crewCount,
      aircraftId: requests.aircraftId,

      airportTimezone: airports.timezoneIana,
    })
    .from(requestServiceLines)
    .innerJoin(requests, eq(requests.id, requestServiceLines.requestId))
    .innerJoin(serviceCategories, eq(serviceCategories.id, requestServiceLines.serviceCategoryId))
    .innerJoin(airports, eq(airports.id, requests.airportId))
    .where(eq(requestServiceLines.id, requestServiceLineId))
    .limit(1);

  if (row === undefined) {
    throw new ApronError('not_found', 'That service line does not exist', {
      details: { requestServiceLineId },
    });
  }

  const serviceWindow =
    row.serviceStartUtc !== null && row.serviceEndUtc !== null
      ? makeInterval(row.serviceStartUtc, row.serviceEndUtc)
      : null;

  // --- aircraft, needed by the hangar rule --------------------------------
  const aircraftSnapshot = await loadAircraft(row.aircraftId, executor);

  // --- providers already chosen on other lines of this request ------------
  const providersOnOtherLines = await executor
    .select({ providerCompanyId: assignments.providerCompanyId })
    .from(assignments)
    .innerJoin(requestServiceLines, eq(requestServiceLines.id, assignments.requestServiceLineId))
    .where(
      and(
        eq(requestServiceLines.requestId, row.requestId),
        sql`${assignments.requestServiceLineId} <> ${requestServiceLineId}::uuid`,
        sql`${assignments.status} <> 'cancelled'`,
      ),
    );

  const context: MatchingContext = {
    requestId: row.requestId,
    airportId: row.airportId,
    airportTimezone: row.airportTimezone,
    fboId: row.fboId,
    aircraft: aircraftSnapshot,
    passengerCount: row.passengerCount,
    crewCount: row.crewCount,
    evaluationNow,
    providersOnOtherLines: providersOnOtherLines.map((item) => item.providerCompanyId),
    excludedProviderIds: options.excludedProviderIds ?? [],
  };

  const line: ServiceLineSnapshot = {
    id: row.lineId,
    serviceCategoryId: row.serviceCategoryId,
    serviceCode: row.serviceCode,
    assignmentStrategy: row.assignmentStrategy,
    quantity: row.quantity,
    requirements: row.requirements,
    serviceWindow,
  };

  const candidates = await loadCandidates(
    {
      serviceCategoryId: row.serviceCategoryId,
      airportId: row.airportId,
      serviceCode: row.serviceCode,
      window: serviceWindow,
    },
    executor,
  );

  return { context, line, candidates };
}

/**
 * Loads every provider with coverage for this service at this airport — including ones
 * that will be rejected.
 *
 * Filtering out unapproved or inactive providers here would be a mistake: operations must
 * be able to see that Atlas was considered and rejected on its suspension, which is what
 * makes the decision trace worth having (CLAUDE.md §12). The engine does the rejecting.
 */
async function loadCandidates(
  scope: {
    readonly serviceCategoryId: string;
    readonly airportId: string;
    readonly serviceCode: string;
    readonly window: Interval | null;
  },
  executor: Executor,
): Promise<ProviderCandidate[]> {
  const coverageRows = await executor
    .select({
      coverageId: providerCoverage.id,
      providerCompanyId: providerCompanies.id,
      displayName: providerCompanies.displayName,
      status: providerCompanies.status,
      providerActive: providerCompanies.active,
      rank: providerCompanies.rank,

      serviceCategoryId: providerCoverage.serviceCategoryId,
      airportId: providerCoverage.airportId,
      fboId: providerCoverage.fboId,
      totalCapacity: providerCoverage.totalCapacity,
      leadTimeMinutes: providerCoverage.leadTimeMinutes,
      maxNoticeDays: providerCoverage.maxNoticeDays,
      coverageActive: providerCoverage.active,
      is247: providerCoverage.is247,

      timezone: airports.timezoneIana,

      hours: sql<string>`(
        select coalesce(
          string_agg(h.weekday || ':' || h.open_minute || ':' || h.close_minute, ',' order by h.weekday, h.open_minute),
          ''
        )
        from provider_coverage_hours h
        where h.coverage_id = ${qualified(providerCoverage.id)}
      )`,
    })
    .from(providerCoverage)
    .innerJoin(providerCompanies, eq(providerCompanies.id, providerCoverage.providerCompanyId))
    .innerJoin(airports, eq(airports.id, providerCoverage.airportId))
    .where(
      and(
        eq(providerCoverage.serviceCategoryId, scope.serviceCategoryId),
        eq(providerCoverage.airportId, scope.airportId),
      ),
    )
    .orderBy(providerCompanies.rank, providerCompanies.displayName, providerCompanies.id);

  if (coverageRows.length === 0) return [];

  const providerIds = coverageRows.map((row) => row.providerCompanyId);

  const [committedByCoverage, blackoutsByProvider, resourcesByProvider] = await Promise.all([
    loadCommittedUnits(scope.serviceCategoryId, scope.airportId, scope.window, executor),
    loadBlackouts(providerIds, executor),
    loadResources(scope.serviceCode, providerIds, scope.airportId, scope.window, executor),
  ]);

  return coverageRows.map((row) => {
    const schedule: OpeningSchedule = {
      timezone: row.timezone,
      is247: row.is247,
      windows: parseHours(row.hours),
    };

    return {
      providerCompanyId: row.providerCompanyId,
      displayName: row.displayName,
      status: row.status,
      active: row.providerActive,
      rank: row.rank,
      coverage: {
        id: row.coverageId,
        serviceCategoryId: row.serviceCategoryId,
        airportId: row.airportId,
        fboId: row.fboId,
        totalCapacity: row.totalCapacity,
        leadTimeMinutes: row.leadTimeMinutes,
        maxNoticeDays: row.maxNoticeDays,
        active: row.coverageActive,
        schedule,
        committedUnitsInWindow: committedByCoverage.get(row.providerCompanyId) ?? 0,
      },
      blackouts: blackoutsByProvider.get(row.providerCompanyId) ?? [],
      resources: resourcesByProvider.get(row.providerCompanyId) ?? emptyProviderResources,
    };
  });
}

/**
 * Units each provider already has committed for this service at this airport, overlapping
 * the window.
 *
 * Derived from real assignments, never from a stored counter — a counter and reality drift
 * apart the first time a transaction rolls back.
 */
async function loadCommittedUnits(
  serviceCategoryId: string,
  airportId: string,
  window: Interval | null,
  executor: Executor,
): Promise<Map<string, number>> {
  if (window === null) return new Map();

  const rows = await executor.execute<{ provider_company_id: string; committed: string }>(sql`
    select a.provider_company_id, coalesce(sum(l.quantity), 0)::text as committed
    from assignments a
    join request_service_lines l on l.id = a.request_service_line_id
    join requests r on r.id = l.request_id
    where a.status <> 'cancelled'
      and l.service_category_id = ${serviceCategoryId}::uuid
      and r.airport_id = ${airportId}::uuid
      and tstzrange(a.start_utc, a.end_utc, '[)') && tstzrange(${window.start.toISOString()}::timestamptz, ${window.end.toISOString()}::timestamptz, '[)')
    group by a.provider_company_id
  `);

  return new Map(rows.rows.map((row) => [row.provider_company_id, Number(row.committed)]));
}

async function loadBlackouts(
  providerIds: readonly string[],
  executor: Executor,
): Promise<Map<string, { interval: Interval; reason: string }[]>> {
  if (providerIds.length === 0) return new Map();

  const rows = await executor
    .select({
      providerCompanyId: providerBlackouts.providerCompanyId,
      startsAt: providerBlackouts.startsAt,
      endsAt: providerBlackouts.endsAt,
      reason: providerBlackouts.reason,
    })
    .from(providerBlackouts)
    .where(sql`${providerBlackouts.providerCompanyId} = any(${toUuidArray(providerIds)})`);

  const grouped = new Map<string, { interval: Interval; reason: string }[]>();
  for (const row of rows) {
    const list = grouped.get(row.providerCompanyId) ?? [];
    list.push({ interval: makeInterval(row.startsAt, row.endsAt), reason: row.reason });
    grouped.set(row.providerCompanyId, list);
  }
  return grouped;
}

/**
 * Loads only the resource kinds this service actually needs.
 *
 * A fuel request does not load vehicles, drivers, hotels and hangars it will never look
 * at. This keeps the snapshot small and the intent obvious at the call site.
 */
async function loadResources(
  serviceCode: string,
  providerIds: readonly string[],
  airportId: string,
  window: Interval | null,
  executor: Executor,
): Promise<Map<string, ProviderResources>> {
  const byProvider = new Map<string, ProviderResources>();
  for (const id of providerIds) byProvider.set(id, emptyProviderResources);

  if (providerIds.length === 0) return byProvider;

  const idArray = toUuidArray(providerIds);
  const commitments = await loadResourceCommitments(idArray, window, executor);

  const merge = (providerId: string, patch: Partial<ProviderResources>): void => {
    byProvider.set(providerId, { ...(byProvider.get(providerId) ?? emptyProviderResources), ...patch });
  };

  if (serviceCode === 'ground_transport') {
    const vehicleRows = await executor
      .select()
      .from(vehicles)
      .where(sql`${vehicles.providerCompanyId} = any(${idArray}) and ${vehicles.active}`)
      .orderBy(vehicles.plateReference, vehicles.id);

    const driverRows = await executor
      .select({
        id: drivers.id,
        providerCompanyId: drivers.providerCompanyId,
        fullName: drivers.fullName,
        languages: drivers.languages,
        timezoneIana: drivers.timezoneIana,
        status: drivers.status,
        active: drivers.active,
        shifts: sql<string>`(
          select coalesce(string_agg(s.weekday || ':' || s.open_minute || ':' || s.close_minute, ',' order by s.weekday, s.open_minute), '')
          from driver_shifts s where s.driver_id = ${qualified(drivers.id)}
        )`,
      })
      .from(drivers)
      .where(sql`${drivers.providerCompanyId} = any(${idArray}) and ${drivers.active}`)
      .orderBy(drivers.fullName, drivers.id);

    for (const providerId of providerIds) {
      merge(providerId, {
        vehicles: vehicleRows
          .filter((row) => row.providerCompanyId === providerId)
          .map((row) => ({
            id: row.id,
            providerCompanyId: row.providerCompanyId,
            active: row.active,
            commitments: commitments.get(row.id) ?? [],
            vehicleClass: row.vehicleClass,
            passengerCapacity: row.passengerCapacity,
            luggageCapacity: row.luggageCapacity,
            features: row.features,
            status: row.status,
            label: `${row.make} ${row.model} (${row.plateReference})`,
          })),
        drivers: driverRows
          .filter((row) => row.providerCompanyId === providerId)
          .map((row) => ({
            id: row.id,
            providerCompanyId: row.providerCompanyId,
            active: row.active,
            commitments: commitments.get(row.id) ?? [],
            schedule: {
              timezone: row.timezoneIana,
              is247: false,
              windows: parseHours(row.shifts),
            },
            languages: row.languages,
            status: row.status,
            label: row.fullName,
          })),
      });
    }
    return byProvider;
  }

  if (serviceCode === 'close_protection') {
    const officerRows = await executor
      .select({
        id: securityOfficers.id,
        providerCompanyId: securityOfficers.providerCompanyId,
        fullName: securityOfficers.fullName,
        armedCertified: securityOfficers.armedCertified,
        languages: securityOfficers.languages,
        timezoneIana: securityOfficers.timezoneIana,
        status: securityOfficers.status,
        active: securityOfficers.active,
        shifts: sql<string>`(
          select coalesce(string_agg(s.weekday || ':' || s.open_minute || ':' || s.close_minute, ',' order by s.weekday, s.open_minute), '')
          from officer_shifts s where s.officer_id = ${qualified(securityOfficers.id)}
        )`,
      })
      .from(securityOfficers)
      .where(sql`${securityOfficers.providerCompanyId} = any(${idArray}) and ${securityOfficers.active}`)
      .orderBy(securityOfficers.fullName, securityOfficers.id);

    for (const providerId of providerIds) {
      merge(providerId, {
        officers: officerRows
          .filter((row) => row.providerCompanyId === providerId)
          .map((row) => ({
            id: row.id,
            providerCompanyId: row.providerCompanyId,
            active: row.active,
            commitments: commitments.get(row.id) ?? [],
            schedule: { timezone: row.timezoneIana, is247: false, windows: parseHours(row.shifts) },
            armedCertified: row.armedCertified,
            languages: row.languages,
            status: row.status,
            label: row.fullName,
          })),
      });
    }
    return byProvider;
  }

  if (serviceCode === 'hotel') {
    const roomRows = await executor
      .select({
        id: hotelRoomTypes.id,
        providerCompanyId: hotelProperties.providerCompanyId,
        hotelPropertyId: hotelProperties.id,
        name: hotelRoomTypes.name,
        maxOccupancy: hotelRoomTypes.maxOccupancy,
        totalRooms: hotelRoomTypes.totalRooms,
        active: hotelRoomTypes.active,
      })
      .from(hotelRoomTypes)
      .innerJoin(hotelProperties, eq(hotelProperties.id, hotelRoomTypes.hotelPropertyId))
      .where(
        sql`${hotelProperties.providerCompanyId} = any(${idArray})
            and ${hotelProperties.airportId} = ${airportId}::uuid
            and ${hotelRoomTypes.active} and ${hotelProperties.active}`,
      )
      .orderBy(hotelProperties.name, hotelRoomTypes.name, hotelRoomTypes.id);

    for (const providerId of providerIds) {
      merge(providerId, {
        hotelRoomTypes: roomRows
          .filter((row) => row.providerCompanyId === providerId)
          .map((row) => ({
            id: row.id,
            providerCompanyId: row.providerCompanyId,
            active: row.active,
            commitments: commitments.get(row.id) ?? [],
            hotelPropertyId: row.hotelPropertyId,
            maxOccupancy: row.maxOccupancy,
            totalRooms: row.totalRooms,
            label: row.name,
          })),
      });
    }
    return byProvider;
  }

  if (serviceCode === 'catering') {
    const rows = await executor
      .select()
      .from(cateringCapabilities)
      .where(
        sql`${cateringCapabilities.providerCompanyId} = any(${idArray})
            and ${cateringCapabilities.airportId} = ${airportId}::uuid
            and ${cateringCapabilities.active}`,
      )
      .orderBy(cateringCapabilities.kitchenName, cateringCapabilities.id);

    for (const providerId of providerIds) {
      merge(providerId, {
        catering: rows
          .filter((row) => row.providerCompanyId === providerId)
          .map((row) => ({
            id: row.id,
            providerCompanyId: row.providerCompanyId,
            active: row.active,
            commitments: commitments.get(row.id) ?? [],
            leadTimeMinutes: row.leadTimeMinutes,
            maxOrdersPerDay: row.maxOrdersPerDay,
            dietaryTags: row.dietaryTags,
            timezone: row.timezoneIana,
            label: row.kitchenName,
          })),
      });
    }
    return byProvider;
  }

  if (serviceCode === 'fuel') {
    const rows = await executor
      .select()
      .from(fuelCapabilities)
      .where(
        sql`${fuelCapabilities.providerCompanyId} = any(${idArray})
            and ${fuelCapabilities.airportId} = ${airportId}::uuid
            and ${fuelCapabilities.active}`,
      )
      .orderBy(fuelCapabilities.truckReference, fuelCapabilities.id);

    for (const providerId of providerIds) {
      merge(providerId, {
        fuel: rows
          .filter((row) => row.providerCompanyId === providerId)
          .map((row) => ({
            id: row.id,
            providerCompanyId: row.providerCompanyId,
            active: row.active,
            commitments: commitments.get(row.id) ?? [],
            fuelType: row.fuelType,
            maxUpliftGallons: row.maxUpliftGallons,
            concurrentUplifts: row.concurrentUplifts,
            supportsPrist: row.supportsPrist,
            label: row.truckReference,
          })),
      });
    }
    return byProvider;
  }

  if (serviceCode === 'hangar') {
    const rows = await executor
      .select()
      .from(hangarResources)
      .where(
        sql`${hangarResources.providerCompanyId} = any(${idArray})
            and ${hangarResources.airportId} = ${airportId}::uuid
            and ${hangarResources.active}`,
      )
      .orderBy(hangarResources.name, hangarResources.id);

    for (const providerId of providerIds) {
      merge(providerId, {
        hangars: rows
          .filter((row) => row.providerCompanyId === providerId)
          .map((row) => ({
            id: row.id,
            providerCompanyId: row.providerCompanyId,
            active: row.active,
            commitments: commitments.get(row.id) ?? [],
            doorWidthFt: Number(row.doorWidthFt),
            doorHeightFt: Number(row.doorHeightFt),
            floorLengthFt: Number(row.floorLengthFt),
            floorWidthFt: Number(row.floorWidthFt),
            maxAircraftWeightLbs: row.maxAircraftWeightLbs,
            heated: row.heated,
            label: row.name,
          })),
      });
    }
    return byProvider;
  }

  // An admin-created category: the generic strategy needs no concrete resources.
  return byProvider;
}

/**
 * Live commitments per resource id, overlapping the window.
 *
 * Released rows are excluded, matching the `where (… and released = false)` predicate on
 * the exclusion constraints — so the engine sees exactly what the database will enforce.
 */
async function loadResourceCommitments(
  providerIdArray: ReturnType<typeof toUuidArray>,
  window: Interval | null,
  executor: Executor,
): Promise<Map<string, ResourceCommitment[]>> {
  if (window === null) return new Map();

  const rows = await executor
    .select({
      vehicleId: assignmentResources.vehicleId,
      driverId: assignmentResources.driverId,
      officerId: assignmentResources.officerId,
      hotelRoomTypeId: assignmentResources.hotelRoomTypeId,
      cateringCapabilityId: assignmentResources.cateringCapabilityId,
      fuelCapabilityId: assignmentResources.fuelCapabilityId,
      hangarResourceId: assignmentResources.hangarResourceId,
      quantity: assignmentResources.quantity,
      startUtc: assignmentResources.startUtc,
      endUtc: assignmentResources.endUtc,
    })
    .from(assignmentResources)
    .innerJoin(assignments, eq(assignments.id, assignmentResources.assignmentId))
    .where(
      sql`${assignmentResources.released} = false
          and ${assignments.status} <> 'cancelled'
          and ${assignments.providerCompanyId} = any(${providerIdArray})
          and tstzrange(${assignmentResources.startUtc}, ${assignmentResources.endUtc}, '[)')
              && tstzrange(${window.start.toISOString()}::timestamptz, ${window.end.toISOString()}::timestamptz, '[)')`,
    );

  const grouped = new Map<string, ResourceCommitment[]>();
  for (const row of rows) {
    const resourceId =
      row.vehicleId ??
      row.driverId ??
      row.officerId ??
      row.hotelRoomTypeId ??
      row.cateringCapabilityId ??
      row.fuelCapabilityId ??
      row.hangarResourceId;

    if (resourceId === null) continue;

    const list = grouped.get(resourceId) ?? [];
    list.push({
      interval: makeInterval(row.startUtc, row.endUtc),
      quantity: row.quantity,
    });
    grouped.set(resourceId, list);
  }
  return grouped;
}

async function loadAircraft(
  aircraftId: string | null,
  executor: Executor,
): Promise<AircraftSnapshot | null> {
  if (aircraftId === null) return null;

  const [row] = await executor.select().from(aircraft).where(eq(aircraft.id, aircraftId)).limit(1);
  if (row === undefined) return null;

  return {
    id: row.id,
    tailNumber: row.tailNumber,
    // Numerics arrive as strings; null stays null so the hangar rule can fail loudly.
    wingspanFt: row.wingspanFt === null ? null : Number(row.wingspanFt),
    lengthFt: row.lengthFt === null ? null : Number(row.lengthFt),
    tailHeightFt: row.tailHeightFt === null ? null : Number(row.tailHeightFt),
    mtowLbs: row.mtowLbs,
  };
}

/** `1:360:1320,2:360:1320` → recurring windows. */
function parseHours(encoded: string): { weekday: number; openMinute: number; closeMinute: number }[] {
  if (encoded === '') return [];
  return encoded
    .split(',')
    .map((part) => {
      const [weekday, open, close] = part.split(':');
      return {
        weekday: Number(weekday),
        openMinute: Number(open),
        closeMinute: Number(close),
      };
    })
    .filter(
      (window) =>
        Number.isInteger(window.weekday) &&
        Number.isInteger(window.openMinute) &&
        Number.isInteger(window.closeMinute),
    );
}

/** A parameterised `uuid[]`, so ids are never interpolated into SQL text. */
function toUuidArray(ids: readonly string[]) {
  return sql`${sql.param([...ids])}::uuid[]`;
}
