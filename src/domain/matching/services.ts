import type { Interval } from '@/lib/time';
import type { AssignmentStrategy } from '@/db/schema/enums';
import type { RejectionReasonCode } from './reasons';
import {
  committedQuantityIn,
  isFreeThroughout,
  isScheduleOpenThroughout,
} from './eligibility';
import type {
  MatchingContext,
  ProviderCandidate,
  ServiceLineSnapshot,
} from './types';

/**
 * Per-service concrete-resource rules, registered by `assignment_strategy` (ADR-008).
 *
 * Two properties matter here:
 *
 *  1. **A new category works with no code change.** An admin who adds "de-icing" gets the
 *     `generic` strategy, which is matched on coverage, desk hours, lead time and capacity
 *     alone — already checked by `eligibility.ts`. It is eligible, not broken.
 *
 *  2. **Services are not forced into one shape.** Ground transport needs a vehicle AND a
 *     driver whose shifts overlap the window; a hangar needs door dimensions against the
 *     airframe; catering needs a daily order count. Each rule asks only what its own
 *     service actually requires.
 *
 * Every function here is pure and takes its "now" from the context.
 */

export interface ServiceRuleInput {
  readonly context: MatchingContext;
  readonly line: ServiceLineSnapshot;
  readonly candidate: ProviderCandidate;
  /** Non-null: `eligibility.ts` returns early when the window is unknown. */
  readonly window: Interval;
}

export interface ServiceRuleOutcome {
  readonly reasonCodes: readonly RejectionReasonCode[];
  /** Resources that could satisfy this line, for the provider portal to preselect. */
  readonly feasibleResourceIds: readonly string[];
}

const SATISFIED: ServiceRuleOutcome = Object.freeze({ reasonCodes: [], feasibleResourceIds: [] });

type ServiceRule = (input: ServiceRuleInput) => ServiceRuleOutcome;

/**
 * An admin-created category has no specific rule and must not be blocked by that.
 * Coverage, hours, lead time and capacity have already been checked.
 */
const genericRule: ServiceRule = () => SATISFIED;

// ---------------------------------------------------------------------------
// ground transport — vehicle AND driver
// ---------------------------------------------------------------------------

const vehicleWithDriverRule: ServiceRule = ({ line, candidate, window }) => {
  const reasons: RejectionReasonCode[] = [];
  const requested = line.quantity;

  const requestedClass = readString(line.requirements, 'vehicleClass');
  const passengers = readInteger(line.requirements, 'passengers');
  const luggage = readInteger(line.requirements, 'luggagePieces');
  const requiredFeatures = readStringArray(line.requirements, 'features');

  const usable = candidate.resources.vehicles.filter(
    (vehicle) => vehicle.active && vehicle.status === 'available',
  );

  if (usable.length === 0) {
    return { reasonCodes: ['no_resource_of_required_type'], feasibleResourceIds: [] };
  }

  const ofClass =
    requestedClass === null ? usable : usable.filter((v) => v.vehicleClass === requestedClass);
  if (ofClass.length === 0) {
    reasons.push('vehicle_class_unavailable');
  }

  // Seats are checked per vehicle against the per-vehicle share of the party. Two cars for
  // six passengers means each must seat three, not six.
  const perVehiclePassengers = passengers === null ? null : Math.ceil(passengers / requested);
  const seatFit =
    perVehiclePassengers === null
      ? ofClass
      : ofClass.filter((v) => v.passengerCapacity >= perVehiclePassengers);
  if (ofClass.length > 0 && seatFit.length === 0) {
    reasons.push('vehicle_seats_insufficient');
  }

  const perVehicleLuggage = luggage === null ? null : Math.ceil(luggage / requested);
  const luggageFit =
    perVehicleLuggage === null
      ? seatFit
      : seatFit.filter((v) => v.luggageCapacity >= perVehicleLuggage);
  if (seatFit.length > 0 && luggageFit.length === 0) {
    reasons.push('vehicle_luggage_insufficient');
  }

  const featureFit =
    requiredFeatures.length === 0
      ? luggageFit
      : luggageFit.filter((v) => requiredFeatures.every((feature) => v.features.includes(feature)));
  if (luggageFit.length > 0 && featureFit.length === 0) {
    reasons.push('resource_capability_missing');
  }

  const freeVehicles = featureFit.filter((v) => isFreeThroughout(v.commitments, window));
  if (featureFit.length > 0 && freeVehicles.length === 0) {
    reasons.push('resource_schedule_conflict');
  } else if (freeVehicles.length > 0 && freeVehicles.length < requested) {
    reasons.push('resource_capacity_insufficient');
  }

  // A vehicle without a driver is not a service. Drivers must be on shift for the whole
  // window and free of other commitments.
  const availableDrivers = candidate.resources.drivers.filter(
    (driver) =>
      driver.active &&
      driver.status === 'available' &&
      isScheduleOpenThroughout(driver.schedule, window) &&
      isFreeThroughout(driver.commitments, window),
  );

  if (candidate.resources.drivers.length === 0) {
    reasons.push('no_driver_available');
  } else if (availableDrivers.length === 0) {
    const anyOnShift = candidate.resources.drivers.some(
      (driver) => driver.active && isScheduleOpenThroughout(driver.schedule, window),
    );
    reasons.push(anyOnShift ? 'resource_schedule_conflict' : 'resource_outside_working_hours');
    reasons.push('no_driver_available');
  } else if (availableDrivers.length < requested) {
    reasons.push('no_driver_available');
  }

  const feasible = [
    ...freeVehicles.slice(0, requested).map((v) => v.id),
    ...availableDrivers.slice(0, requested).map((d) => d.id),
  ];

  return {
    reasonCodes: reasons,
    feasibleResourceIds: reasons.length === 0 ? feasible : [],
  };
};

// ---------------------------------------------------------------------------
// close protection — officers, with armed certification honoured exactly
// ---------------------------------------------------------------------------

const officerRule: ServiceRule = ({ line, candidate, window }) => {
  const reasons: RejectionReasonCode[] = [];
  const requested = readInteger(line.requirements, 'officers') ?? line.quantity;
  const armedRequired = readBoolean(line.requirements, 'armed') ?? false;
  const languages = readStringArray(line.requirements, 'languages');

  const roster = candidate.resources.officers.filter(
    (officer) => officer.active && officer.status === 'available',
  );

  if (roster.length === 0) {
    return { reasonCodes: ['no_resource_of_required_type'], feasibleResourceIds: [] };
  }

  // Armed status is matched against the certification on record and is never inferred
  // from the request text (CLAUDE.md §2).
  const certified = armedRequired ? roster.filter((officer) => officer.armedCertified) : roster;
  if (certified.length === 0) {
    reasons.push('officer_armed_certification_missing');
  }

  const languageFit =
    languages.length === 0
      ? certified
      : certified.filter((officer) =>
          languages.every((language) => officer.languages.includes(language)),
        );
  if (certified.length > 0 && languageFit.length === 0) {
    reasons.push('resource_capability_missing');
  }

  const onShift = languageFit.filter((officer) =>
    isScheduleOpenThroughout(officer.schedule, window),
  );
  if (languageFit.length > 0 && onShift.length === 0) {
    reasons.push('resource_outside_working_hours');
  }

  const free = onShift.filter((officer) => isFreeThroughout(officer.commitments, window));
  if (onShift.length > 0 && free.length === 0) {
    reasons.push('resource_schedule_conflict');
  }

  if (free.length > 0 && free.length < requested) {
    reasons.push('officer_count_insufficient');
  }

  return {
    reasonCodes: reasons,
    feasibleResourceIds: reasons.length === 0 ? free.slice(0, requested).map((o) => o.id) : [],
  };
};

// ---------------------------------------------------------------------------
// hotel — pooled rooms, availability derived from commitments
// ---------------------------------------------------------------------------

const hotelRoomsRule: ServiceRule = ({ line, candidate, window }) => {
  const reasons: RejectionReasonCode[] = [];
  const rooms = readInteger(line.requirements, 'rooms') ?? line.quantity;
  const guests = readInteger(line.requirements, 'guests');

  const roomTypes = candidate.resources.hotelRoomTypes.filter((type) => type.active);
  if (roomTypes.length === 0) {
    return { reasonCodes: ['no_resource_of_required_type'], feasibleResourceIds: [] };
  }

  // Occupancy is checked against the largest room type: the party has to fit *somewhere*.
  if (guests !== null && rooms > 0) {
    const perRoom = Math.ceil(guests / rooms);
    const fits = roomTypes.some((type) => type.maxOccupancy >= perRoom);
    if (!fits) {
      reasons.push('hotel_occupancy_insufficient');
    }
  }

  const feasible: string[] = [];
  let bestAvailable = 0;
  for (const type of roomTypes) {
    const available = type.totalRooms - committedQuantityIn(type.commitments, window);
    if (available > bestAvailable) bestAvailable = available;
    if (available >= rooms) feasible.push(type.id);
  }

  if (feasible.length === 0) {
    reasons.push('hotel_rooms_insufficient');
  }

  return { reasonCodes: reasons, feasibleResourceIds: reasons.length === 0 ? feasible : [] };
};

// ---------------------------------------------------------------------------
// catering — daily order ceiling and dietary capability
// ---------------------------------------------------------------------------

const cateringOrderRule: ServiceRule = ({ context, line, candidate, window }) => {
  const reasons: RejectionReasonCode[] = [];
  const dietary = readStringArray(line.requirements, 'dietary');

  const kitchens = candidate.resources.catering.filter((kitchen) => kitchen.active);
  if (kitchens.length === 0) {
    return { reasonCodes: ['no_resource_of_required_type'], feasibleResourceIds: [] };
  }

  const dietaryCapable =
    dietary.length === 0
      ? kitchens
      : kitchens.filter((kitchen) => dietary.every((tag) => kitchen.dietaryTags.includes(tag)));
  if (dietaryCapable.length === 0) {
    reasons.push('catering_dietary_unsupported');
  }

  // The kitchen's own lead time is stricter than the coverage row's in the seeded
  // network, and it is the one that actually binds.
  const noticeMinutes = Math.floor(
    (window.start.getTime() - context.evaluationNow.getTime()) / 60_000,
  );
  const inLeadTime = dietaryCapable.filter((kitchen) => noticeMinutes >= kitchen.leadTimeMinutes);
  if (dietaryCapable.length > 0 && inLeadTime.length === 0) {
    reasons.push('lead_time_insufficient');
  }

  const withRoom = inLeadTime.filter((kitchen) => {
    const ordersThatDay = kitchen.commitments.filter((commitment) =>
      sharesLocalDay(commitment.interval.start, window.start, kitchen.timezone),
    ).length;
    return ordersThatDay + line.quantity <= kitchen.maxOrdersPerDay;
  });
  if (inLeadTime.length > 0 && withRoom.length === 0) {
    reasons.push('catering_capacity_exhausted');
  }

  return {
    reasonCodes: reasons,
    feasibleResourceIds: reasons.length === 0 ? withRoom.map((kitchen) => kitchen.id) : [],
  };
};

// ---------------------------------------------------------------------------
// fuel — type, uplift ceiling and concurrent truck availability
// ---------------------------------------------------------------------------

const fuelUpliftRule: ServiceRule = ({ line, candidate, window }) => {
  const reasons: RejectionReasonCode[] = [];
  const requestedType = readString(line.requirements, 'fuelType');
  const gallons = readInteger(line.requirements, 'gallons');
  const pristRequired = readBoolean(line.requirements, 'prist') ?? false;

  const trucks = candidate.resources.fuel.filter((truck) => truck.active);
  if (trucks.length === 0) {
    return { reasonCodes: ['no_resource_of_required_type'], feasibleResourceIds: [] };
  }

  const ofType =
    requestedType === null ? trucks : trucks.filter((truck) => truck.fuelType === requestedType);
  if (ofType.length === 0) {
    reasons.push('fuel_type_unavailable');
  }

  // A missing gallon figure is legitimate — "fuel on arrival" with no number is a real
  // request — so the ceiling is only checked when a figure was actually given.
  const withCapacity =
    gallons === null ? ofType : ofType.filter((truck) => truck.maxUpliftGallons >= gallons);
  if (ofType.length > 0 && withCapacity.length === 0) {
    reasons.push('fuel_uplift_exceeds_capacity');
  }

  const pristCapable = pristRequired
    ? withCapacity.filter((truck) => truck.supportsPrist)
    : withCapacity;
  if (withCapacity.length > 0 && pristCapable.length === 0) {
    reasons.push('resource_capability_missing');
  }

  const free = pristCapable.filter((truck) => {
    const concurrent = truck.commitments.filter((commitment) =>
      overlapsWindow(commitment.interval, window),
    ).length;
    return concurrent < truck.concurrentUplifts;
  });
  if (pristCapable.length > 0 && free.length === 0) {
    reasons.push('resource_schedule_conflict');
  }

  return {
    reasonCodes: reasons,
    feasibleResourceIds: reasons.length === 0 ? free.map((truck) => truck.id) : [],
  };
};

// ---------------------------------------------------------------------------
// hangar — the airframe must physically fit
// ---------------------------------------------------------------------------

const hangarSlotRule: ServiceRule = ({ context, line, candidate, window }) => {
  const reasons: RejectionReasonCode[] = [];
  const heatedRequired = readBoolean(line.requirements, 'heated') ?? false;

  const bays = candidate.resources.hangars.filter((bay) => bay.active);
  if (bays.length === 0) {
    return { reasonCodes: ['no_resource_of_required_type'], feasibleResourceIds: [] };
  }

  const aircraft = context.aircraft;
  if (aircraft === null) {
    return { reasonCodes: ['aircraft_unknown'], feasibleResourceIds: [] };
  }

  // An unknown dimension must make the check FAIL, never pass on an assumed default.
  // Parking the wrong aircraft in a bay it does not fit is a real-world incident.
  if (
    aircraft.wingspanFt === null ||
    aircraft.lengthFt === null ||
    aircraft.tailHeightFt === null
  ) {
    return { reasonCodes: ['hangar_aircraft_dimensions_unknown'], feasibleResourceIds: [] };
  }

  const wideEnough = bays.filter((bay) => bay.doorWidthFt >= aircraft.wingspanFt!);
  if (wideEnough.length === 0) reasons.push('hangar_aircraft_too_wide');

  const tallEnough = wideEnough.filter((bay) => bay.doorHeightFt >= aircraft.tailHeightFt!);
  if (wideEnough.length > 0 && tallEnough.length === 0) reasons.push('hangar_aircraft_too_tall');

  const longEnough = tallEnough.filter((bay) => bay.floorLengthFt >= aircraft.lengthFt!);
  if (tallEnough.length > 0 && longEnough.length === 0) reasons.push('hangar_aircraft_too_long');

  const strongEnough = longEnough.filter(
    (bay) =>
      bay.maxAircraftWeightLbs === null ||
      aircraft.mtowLbs === null ||
      bay.maxAircraftWeightLbs >= aircraft.mtowLbs,
  );
  if (longEnough.length > 0 && strongEnough.length === 0) {
    reasons.push('hangar_aircraft_too_heavy');
  }

  const heatedFit = heatedRequired ? strongEnough.filter((bay) => bay.heated) : strongEnough;
  if (strongEnough.length > 0 && heatedFit.length === 0) {
    reasons.push('hangar_heated_unavailable');
  }

  const free = heatedFit.filter((bay) => isFreeThroughout(bay.commitments, window));
  if (heatedFit.length > 0 && free.length === 0) {
    reasons.push('resource_schedule_conflict');
  } else if (free.length > 0 && free.length < line.quantity) {
    reasons.push('resource_capacity_insufficient');
  }

  return {
    reasonCodes: reasons,
    feasibleResourceIds:
      reasons.length === 0 ? free.slice(0, line.quantity).map((bay) => bay.id) : [],
  };
};

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

const RULES: Record<AssignmentStrategy, ServiceRule> = {
  generic: genericRule,
  vehicle_with_driver: vehicleWithDriverRule,
  officer: officerRule,
  hotel_rooms: hotelRoomsRule,
  catering_order: cateringOrderRule,
  fuel_uplift: fuelUpliftRule,
  hangar_slot: hangarSlotRule,
};

export function checkServiceRules(input: ServiceRuleInput): ServiceRuleOutcome {
  const rule = RULES[input.line.assignmentStrategy] ?? genericRule;
  return rule(input);
}

/** Exposed so the Admin console can show which strategies have concrete rules. */
export function strategiesWithConcreteRules(): AssignmentStrategy[] {
  return (Object.keys(RULES) as AssignmentStrategy[]).filter((key) => key !== 'generic');
}

// ---------------------------------------------------------------------------
// requirement readers
//
// Requirements arrive as validated JSON, but the engine still reads defensively: an
// absent field is `null` and the rule decides what that means. A malformed value is
// treated as absent rather than coerced, because guessing here would silently change
// what the client asked for.
// ---------------------------------------------------------------------------

function readString(requirements: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = requirements[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readInteger(requirements: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = requirements[key];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  return null;
}

function readBoolean(requirements: Readonly<Record<string, unknown>>, key: string): boolean | null {
  const value = requirements[key];
  return typeof value === 'boolean' ? value : null;
}

function readStringArray(
  requirements: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = requirements[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) {
    // Intake may present "German, French" as prose; split on separators rather than
    // treating the whole phrase as one impossible-to-match tag.
    return value
      .split(/[,;/]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

/** Local-day comparison in the resource's own zone, for daily order ceilings. */
function sharesLocalDay(a: Date, b: Date, timezone: string): boolean {
  const format = (value: Date): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(value);
  return format(a) === format(b);
}

function overlapsWindow(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}
