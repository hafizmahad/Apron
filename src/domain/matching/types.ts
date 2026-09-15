import type { Interval } from '@/lib/time';
import type {
  AssignmentStrategy,
  FuelType,
  ProviderCompanyStatus,
  VehicleClass,
} from '@/db/schema/enums';
import type { RejectionReasonCode } from './reasons';

/**
 * The immutable snapshot vocabulary of the eligibility engine (ADR-009).
 *
 * Everything the engine needs is in these types. There is no database handle, no clock,
 * no randomness and no I/O anywhere in `src/domain/matching/` — callers load data, build a
 * snapshot, evaluate, then persist. That is what lets the production path and the eval
 * suite call literally the same functions (CLAUDE.md §26).
 *
 * `evaluationNow` is passed in for the same reason: the engine must never read the clock
 * itself, or the same inputs would produce different answers on different days and no
 * decision could be reproduced from its trace.
 */

/** A weekday-based recurring window in a named zone. Minutes past 1440 cross midnight. */
export interface RecurringWindow {
  /** ISO 8601: 1 = Monday … 7 = Sunday, in `timezone`. */
  readonly weekday: number;
  readonly openMinute: number;
  readonly closeMinute: number;
}

export interface OpeningSchedule {
  readonly timezone: string;
  /** Empty with `is247: false` means "never open" — not "always open". */
  readonly windows: readonly RecurringWindow[];
  readonly is247: boolean;
}

/** A window during which a provider or resource is unavailable regardless of schedule. */
export interface BlackoutWindow {
  readonly interval: Interval;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// concrete resources
// ---------------------------------------------------------------------------

/** Commitments already held against a resource. Half-open, in UTC. */
export interface ResourceCommitment {
  readonly interval: Interval;
  /** Rooms, gallons or covers for pooled resources; 1 for singular ones. */
  readonly quantity: number;
}

interface ResourceBase {
  readonly id: string;
  readonly providerCompanyId: string;
  readonly active: boolean;
  readonly commitments: readonly ResourceCommitment[];
}

export interface VehicleSnapshot extends ResourceBase {
  readonly vehicleClass: VehicleClass;
  readonly passengerCapacity: number;
  readonly luggageCapacity: number;
  readonly features: readonly string[];
  readonly status: 'available' | 'maintenance' | 'retired';
  readonly label: string;
}

export interface DriverSnapshot extends ResourceBase {
  readonly schedule: OpeningSchedule;
  readonly languages: readonly string[];
  readonly status: 'available' | 'off_duty' | 'inactive';
  readonly label: string;
}

export interface OfficerSnapshot extends ResourceBase {
  readonly schedule: OpeningSchedule;
  readonly armedCertified: boolean;
  readonly languages: readonly string[];
  readonly status: 'available' | 'off_duty' | 'inactive';
  readonly label: string;
}

export interface HotelRoomTypeSnapshot extends ResourceBase {
  readonly hotelPropertyId: string;
  readonly maxOccupancy: number;
  readonly totalRooms: number;
  readonly label: string;
}

export interface CateringSnapshot extends ResourceBase {
  readonly leadTimeMinutes: number;
  readonly maxOrdersPerDay: number;
  readonly dietaryTags: readonly string[];
  readonly timezone: string;
  readonly label: string;
}

export interface FuelSnapshot extends ResourceBase {
  readonly fuelType: FuelType;
  readonly maxUpliftGallons: number;
  readonly concurrentUplifts: number;
  readonly supportsPrist: boolean;
  readonly label: string;
}

export interface HangarSnapshot extends ResourceBase {
  readonly doorWidthFt: number;
  readonly doorHeightFt: number;
  readonly floorLengthFt: number;
  readonly floorWidthFt: number;
  readonly maxAircraftWeightLbs: number | null;
  readonly heated: boolean;
  readonly label: string;
}

/**
 * The resources one provider has at the location under evaluation. Each list holds only
 * the kinds that provider actually operates; an empty list is a real answer, not missing
 * data, and produces `no_resource_of_required_type`.
 */
export interface ProviderResources {
  readonly vehicles: readonly VehicleSnapshot[];
  readonly drivers: readonly DriverSnapshot[];
  readonly officers: readonly OfficerSnapshot[];
  readonly hotelRoomTypes: readonly HotelRoomTypeSnapshot[];
  readonly catering: readonly CateringSnapshot[];
  readonly fuel: readonly FuelSnapshot[];
  readonly hangars: readonly HangarSnapshot[];
}

export const emptyProviderResources: ProviderResources = Object.freeze({
  vehicles: [],
  drivers: [],
  officers: [],
  hotelRoomTypes: [],
  catering: [],
  fuel: [],
  hangars: [],
});

// ---------------------------------------------------------------------------
// candidates
// ---------------------------------------------------------------------------

export interface CoverageSnapshot {
  readonly id: string;
  readonly serviceCategoryId: string;
  readonly airportId: string;
  /** Null for airport-wide coverage. Never means "everywhere" (CLAUDE.md §6). */
  readonly fboId: string | null;
  readonly totalCapacity: number;
  readonly leadTimeMinutes: number;
  readonly maxNoticeDays: number | null;
  readonly active: boolean;
  readonly schedule: OpeningSchedule;
  /**
   * Committed units overlapping the requested window, from existing assignments.
   * Compared against `totalCapacity`; never a stored counter that could drift.
   */
  readonly committedUnitsInWindow: number;
}

export interface ProviderCandidate {
  readonly providerCompanyId: string;
  readonly displayName: string;
  readonly status: ProviderCompanyStatus;
  readonly active: boolean;
  /** 1..1000, lower is better. A tie-break, never a gate. */
  readonly rank: number;
  readonly coverage: CoverageSnapshot;
  readonly blackouts: readonly BlackoutWindow[];
  readonly resources: ProviderResources;
}

// ---------------------------------------------------------------------------
// the request under evaluation
// ---------------------------------------------------------------------------

export interface AircraftSnapshot {
  readonly id: string;
  readonly tailNumber: string;
  /** Null is meaningful: an unknown dimension makes a hangar check FAIL, never pass. */
  readonly wingspanFt: number | null;
  readonly lengthFt: number | null;
  readonly tailHeightFt: number | null;
  readonly mtowLbs: number | null;
}

export interface ServiceLineSnapshot {
  readonly id: string;
  readonly serviceCategoryId: string;
  readonly serviceCode: string;
  readonly assignmentStrategy: AssignmentStrategy;
  readonly quantity: number;
  /** Validated against the category's config schema before it reaches the engine. */
  readonly requirements: Readonly<Record<string, unknown>>;
  /** Null when intake has not resolved a window yet — a real, reportable state. */
  readonly serviceWindow: Interval | null;
}

export interface MatchingContext {
  readonly requestId: string;
  readonly airportId: string;
  readonly airportTimezone: string;
  readonly fboId: string | null;
  readonly aircraft: AircraftSnapshot | null;
  readonly passengerCount: number;
  readonly crewCount: number;
  /** The instant the engine treats as "now". Supplied, never read from the clock. */
  readonly evaluationNow: Date;
  /** Providers already chosen on other lines of this request — the consolidation bonus. */
  readonly providersOnOtherLines: readonly string[];
  /** Providers held out of this attempt: previous declines, manual exclusions. */
  readonly excludedProviderIds: readonly string[];
}

export interface EligibilityInput {
  readonly context: MatchingContext;
  readonly line: ServiceLineSnapshot;
  readonly candidates: readonly ProviderCandidate[];
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

export interface EligibilityResult {
  readonly providerCompanyId: string;
  readonly displayName: string;
  readonly eligible: boolean;
  readonly reasonCodes: readonly RejectionReasonCode[];
  /** Units still free at this provider for this window. 0 when ineligible on capacity. */
  readonly spareCapacity: number;
  /** Minutes between `evaluationNow + leadTime` and the window start. Null if unknown. */
  readonly leadTimeMarginMinutes: number | null;
  /** Concrete resources that could satisfy the line, for the provider portal to preselect. */
  readonly feasibleResourceIds: readonly string[];
}

export interface RankedCandidate extends EligibilityResult {
  readonly eligible: true;
  readonly rank: number;
  /** How many other lines of this request already went to this provider. */
  readonly sameProviderOnOtherLines: number;
  /** The computed score. Higher sorts first. Deterministic, integer arithmetic only. */
  readonly score: number;
}

export interface MatchingOutcome {
  readonly engineVersion: string;
  readonly eligible: readonly RankedCandidate[];
  readonly rejected: readonly EligibilityResult[];
  /** The deterministic first choice, or null when nothing is eligible. */
  readonly top: RankedCandidate | null;
}
