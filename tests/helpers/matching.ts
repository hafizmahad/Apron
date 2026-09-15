import { makeInterval, type Interval } from '@/lib/time';
import {
  emptyProviderResources,
  type CoverageSnapshot,
  type DriverSnapshot,
  type HangarSnapshot,
  type MatchingContext,
  type OfficerSnapshot,
  type OpeningSchedule,
  type ProviderCandidate,
  type ProviderResources,
  type ServiceLineSnapshot,
  type VehicleSnapshot,
} from '@/domain/matching';

/**
 * Snapshot builders for the matching tests.
 *
 * Every builder produces a fully valid, eligible-by-default snapshot, so each test changes
 * exactly the one thing it is about. A test that fails then names its own cause.
 *
 * All instants sit on Friday 18 September 2026 UTC — a date deliberately clear of US and
 * EU DST transitions, so a test that is not about DST cannot fail because of one.
 */

export const ALWAYS: OpeningSchedule = Object.freeze({
  timezone: 'America/New_York',
  windows: [],
  is247: true,
});

/** 06:00–22:00 local, every day. */
export const DAYTIME: OpeningSchedule = Object.freeze({
  timezone: 'America/New_York',
  windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    openMinute: 360,
    closeMinute: 1320,
  })),
  is247: false,
});

/** 18:00 through 06:00 the next morning — a window that crosses midnight. */
export const OVERNIGHT: OpeningSchedule = Object.freeze({
  timezone: 'America/New_York',
  windows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    openMinute: 1080,
    closeMinute: 1800,
  })),
  is247: false,
});

export const NEVER: OpeningSchedule = Object.freeze({
  timezone: 'America/New_York',
  windows: [],
  is247: false,
});

/** `utc('07:00')` is 2026-09-18T07:00Z. Hours past 24 roll into the next day. */
export function utc(hhmm: string): Date {
  const [rawHour, rawMinute] = hhmm.split(':');
  const hour = Number(rawHour);
  const minute = Number(rawMinute ?? '0');
  return new Date(Date.UTC(2026, 8, 18, 0, 0, 0, 0) + hour * 3_600_000 + minute * 60_000);
}

export function window(from: string, to: string): Interval {
  return makeInterval(utc(from), utc(to));
}

export const AIRPORT_ID = 'airport-kteb';
export const OTHER_AIRPORT_ID = 'airport-kewr';
export const FBO_ID = 'fbo-signature-teb';
export const OTHER_FBO_ID = 'fbo-atlantic-teb';
export const GROUND_TRANSPORT_ID = 'svc-ground-transport';
export const HANGAR_SERVICE_ID = 'svc-hangar';

export function makeContext(overrides: Partial<MatchingContext> = {}): MatchingContext {
  return {
    requestId: 'request-1',
    airportId: AIRPORT_ID,
    airportTimezone: 'America/New_York',
    fboId: null,
    aircraft: null,
    passengerCount: 4,
    crewCount: 2,
    // 12 hours before the default 07:00 window, so lead time is comfortable by default.
    evaluationNow: utc('-5:00'),
    providersOnOtherLines: [],
    excludedProviderIds: [],
    ...overrides,
  };
}

export function makeLine(overrides: Partial<ServiceLineSnapshot> = {}): ServiceLineSnapshot {
  return {
    id: 'line-1',
    serviceCategoryId: GROUND_TRANSPORT_ID,
    serviceCode: 'ground_transport',
    assignmentStrategy: 'vehicle_with_driver',
    quantity: 1,
    requirements: { vehicleClass: 'suv', passengers: 4 },
    serviceWindow: window('07:00', '10:00'),
    ...overrides,
  };
}

export function makeCoverage(overrides: Partial<CoverageSnapshot> = {}): CoverageSnapshot {
  return {
    id: 'coverage-1',
    serviceCategoryId: GROUND_TRANSPORT_ID,
    airportId: AIRPORT_ID,
    fboId: null,
    totalCapacity: 4,
    leadTimeMinutes: 90,
    maxNoticeDays: null,
    active: true,
    schedule: ALWAYS,
    committedUnitsInWindow: 0,
    ...overrides,
  };
}

export function makeVehicle(overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
  return {
    id: `vehicle-${Math.random().toString(36).slice(2, 8)}`,
    providerCompanyId: 'provider-1',
    active: true,
    commitments: [],
    vehicleClass: 'suv',
    passengerCapacity: 6,
    luggageCapacity: 6,
    features: [],
    status: 'available',
    label: 'Escalade ESV',
    ...overrides,
  };
}

export function makeDriver(overrides: Partial<DriverSnapshot> = {}): DriverSnapshot {
  return {
    id: `driver-${Math.random().toString(36).slice(2, 8)}`,
    providerCompanyId: 'provider-1',
    active: true,
    commitments: [],
    schedule: ALWAYS,
    languages: [],
    status: 'available',
    label: 'Driver',
    ...overrides,
  };
}

export function makeOfficer(overrides: Partial<OfficerSnapshot> = {}): OfficerSnapshot {
  return {
    id: `officer-${Math.random().toString(36).slice(2, 8)}`,
    providerCompanyId: 'provider-1',
    active: true,
    commitments: [],
    schedule: ALWAYS,
    armedCertified: false,
    languages: [],
    status: 'available',
    label: 'Officer',
    ...overrides,
  };
}

export function makeHangar(overrides: Partial<HangarSnapshot> = {}): HangarSnapshot {
  return {
    id: `hangar-${Math.random().toString(36).slice(2, 8)}`,
    providerCompanyId: 'provider-1',
    active: true,
    commitments: [],
    // Comfortably takes a G650ER by default.
    doorWidthFt: 135,
    doorHeightFt: 30,
    floorLengthFt: 140,
    floorWidthFt: 150,
    maxAircraftWeightLbs: 120_000,
    heated: true,
    label: 'Bay A',
    ...overrides,
  };
}

/** A provider that is eligible for the default ground-transport line. */
export function makeCandidate(overrides: Partial<ProviderCandidate> = {}): ProviderCandidate {
  const providerCompanyId = overrides.providerCompanyId ?? 'provider-1';
  const resources: ProviderResources = overrides.resources ?? {
    ...emptyProviderResources,
    vehicles: [makeVehicle({ providerCompanyId })],
    drivers: [makeDriver({ providerCompanyId })],
  };

  return {
    providerCompanyId,
    displayName: 'Hudson Executive Transport',
    status: 'approved',
    active: true,
    rank: 200,
    coverage: makeCoverage(),
    blackouts: [],
    ...overrides,
    resources,
  };
}

/** The G650ER from the seeded fleet — the airframe the narrow bay must reject. */
export const G650ER = Object.freeze({
  id: 'aircraft-g650',
  tailNumber: 'N418MC',
  wingspanFt: 99.58,
  lengthFt: 99.75,
  tailHeightFt: 25.67,
  mtowLbs: 103_600,
});

/** A light jet that fits almost anywhere. */
export const PC24 = Object.freeze({
  id: 'aircraft-pc24',
  tailNumber: 'N147RS',
  wingspanFt: 55.75,
  lengthFt: 55.17,
  tailHeightFt: 17.42,
  mtowLbs: 18_300,
});
