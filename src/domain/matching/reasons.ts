/**
 * Structured rejection reasons (CLAUDE.md §9).
 *
 * Every candidate the engine rejects carries one or more of these codes. They are the
 * vocabulary the Operations decision trace renders, the research assistant cites when
 * asked "why was provider B rejected?", and the eval suite asserts on — so they are a
 * stable contract, not log prose. Adding a code is additive; changing the meaning of an
 * existing one is not.
 */

export const rejectionReasonCodes = Object.freeze([
  // --- provider governance ---
  'provider_not_approved',
  'provider_inactive',
  'provider_excluded_by_previous_decline',
  'provider_excluded_manually',

  // --- coverage ---
  'service_not_offered',
  'airport_not_covered',
  'fbo_not_covered',
  'coverage_inactive',

  // --- timing ---
  'outside_desk_hours',
  'lead_time_insufficient',
  'booked_too_far_ahead',
  'blackout_window',
  'service_window_unknown',

  // --- capacity ---
  'provider_capacity_exhausted',

  // --- concrete resources ---
  'no_resource_of_required_type',
  'resource_capacity_insufficient',
  'resource_schedule_conflict',
  'resource_outside_working_hours',
  'resource_capability_missing',

  // --- service-specific ---
  'vehicle_class_unavailable',
  'vehicle_seats_insufficient',
  'vehicle_luggage_insufficient',
  'no_driver_available',
  'officer_armed_certification_missing',
  'officer_count_insufficient',
  'hotel_rooms_insufficient',
  'hotel_occupancy_insufficient',
  'catering_capacity_exhausted',
  'catering_dietary_unsupported',
  'fuel_type_unavailable',
  'fuel_uplift_exceeds_capacity',
  'hangar_aircraft_too_wide',
  'hangar_aircraft_too_long',
  'hangar_aircraft_too_tall',
  'hangar_aircraft_too_heavy',
  'hangar_aircraft_dimensions_unknown',
  'hangar_heated_unavailable',

  // --- inputs ---
  'aircraft_unknown',
  'requirements_invalid',
] as const);

export type RejectionReasonCode = (typeof rejectionReasonCodes)[number];

/**
 * Human-readable text for each code, in operations' voice. Rendered directly in the
 * decision trace, so it explains the *decision*, not the field that failed.
 */
const REASON_TEXT: Record<RejectionReasonCode, string> = {
  provider_not_approved: 'Provider is not approved on the platform',
  provider_inactive: 'Provider account is inactive',
  provider_excluded_by_previous_decline: 'Provider already declined this service line',
  provider_excluded_manually: 'Provider was excluded by operations for this attempt',

  service_not_offered: 'Provider does not offer this service',
  airport_not_covered: 'Provider does not cover this airport',
  fbo_not_covered: 'Provider does not cover the requested FBO',
  coverage_inactive: 'Provider’s coverage for this service and location is switched off',

  outside_desk_hours: 'Service window falls outside the provider’s staffed hours',
  lead_time_insufficient: 'Not enough notice for this provider’s lead time',
  booked_too_far_ahead: 'Further ahead than this provider accepts bookings',
  blackout_window: 'Provider has a blackout covering this window',
  service_window_unknown: 'Service window has not been determined yet',

  provider_capacity_exhausted: 'Provider’s capacity at this location is already committed',

  no_resource_of_required_type: 'Provider has no resource of the required type here',
  resource_capacity_insufficient: 'Provider has fewer suitable resources than requested',
  resource_schedule_conflict: 'Every suitable resource is already committed in this window',
  resource_outside_working_hours: 'No suitable resource is on shift for this window',
  resource_capability_missing: 'No resource has the required capability',

  vehicle_class_unavailable: 'No vehicle of the requested class is available',
  vehicle_seats_insufficient: 'Available vehicles cannot seat the passenger count',
  vehicle_luggage_insufficient: 'Available vehicles cannot carry the luggage',
  no_driver_available: 'No driver is on shift and free for this window',
  officer_armed_certification_missing: 'No armed-certified officer is available',
  officer_count_insufficient: 'Fewer officers are available than requested',
  hotel_rooms_insufficient: 'Not enough rooms are free for these dates',
  hotel_occupancy_insufficient: 'Room types cannot accommodate the party size',
  catering_capacity_exhausted: 'Kitchen has reached its order limit for the day',
  catering_dietary_unsupported: 'Kitchen does not support the required dietary requirement',
  fuel_type_unavailable: 'Requested fuel type is not available here',
  fuel_uplift_exceeds_capacity: 'Requested uplift exceeds the truck’s capacity',
  hangar_aircraft_too_wide: 'Aircraft wingspan exceeds the hangar door width',
  hangar_aircraft_too_long: 'Aircraft length exceeds the hangar floor',
  hangar_aircraft_too_tall: 'Aircraft tail height exceeds the hangar door height',
  hangar_aircraft_too_heavy: 'Aircraft weight exceeds the hangar limit',
  hangar_aircraft_dimensions_unknown: 'Aircraft dimensions are unknown, so fit cannot be confirmed',
  hangar_heated_unavailable: 'No heated hangar is available here',

  aircraft_unknown: 'Request has no identified aircraft',
  requirements_invalid: 'Service requirements are incomplete or invalid',
};

export function describeReason(code: RejectionReasonCode): string {
  return REASON_TEXT[code];
}

/**
 * Whether a reason could change on its own as time passes or capacity frees up.
 *
 * Operations uses this to decide what to offer: a transient rejection is worth retrying
 * or nudging the flight time for; a structural one means this provider is simply not a
 * candidate for this request, ever.
 */
export function isTransient(code: RejectionReasonCode): boolean {
  switch (code) {
    case 'provider_capacity_exhausted':
    case 'resource_schedule_conflict':
    case 'resource_capacity_insufficient':
    case 'catering_capacity_exhausted':
    case 'hotel_rooms_insufficient':
    case 'lead_time_insufficient':
    case 'outside_desk_hours':
    case 'resource_outside_working_hours':
    case 'blackout_window':
    case 'booked_too_far_ahead':
    case 'no_driver_available':
    case 'officer_count_insufficient':
      return true;
    default:
      return false;
  }
}
