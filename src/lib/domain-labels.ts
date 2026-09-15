/**
 * Human-readable names for internal domain identifiers (CLAUDE.md §21).
 *
 * Presentation only, exactly like `settings-labels`. **The value is the identity** — it is
 * what the database stores, what the matching engine switches on and what the audit trail
 * records — and nothing here changes any of that. This only decides what a person reads.
 *
 * The rule the product follows: a raw identifier is never the primary text of a row. Where
 * it genuinely helps an administrator connect a screen to an audit event or a log line, it
 * is kept as small secondary metadata beneath the readable name.
 *
 * Every lookup falls back to a humanised form of the value rather than to nothing, so a new
 * enum member can never render as blank — and the tests compare these maps against the real
 * enums, so the fallback stays a safety net rather than the normal path.
 */

/** `vehicle_with_driver` → `Vehicle with driver`. */
function humanise(value: string): string {
  const words = value.replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// assignment strategies — which concrete-resource rules a service is matched by
// ---------------------------------------------------------------------------

export const ASSIGNMENT_STRATEGY_LABELS: Readonly<Record<string, string>> = {
  generic: 'No specific resources',
  vehicle_with_driver: 'Vehicle with driver',
  officer: 'Protective officer',
  hotel_rooms: 'Hotel rooms',
  catering_order: 'Catering order',
  fuel_uplift: 'Fuel uplift',
  hangar_slot: 'Hangar slot',
};

export function assignmentStrategyLabel(value: string): string {
  return ASSIGNMENT_STRATEGY_LABELS[value] ?? humanise(value);
}

/** What the strategy actually means for matching, in a sentence. */
export const ASSIGNMENT_STRATEGY_HINTS: Readonly<Record<string, string>> = {
  generic: 'Matched on coverage, desk hours, lead time and capacity alone.',
  vehicle_with_driver: 'Needs a vehicle of the right class and an available driver.',
  officer: 'Needs an officer on shift for the whole service window.',
  hotel_rooms: 'Needs room inventory available for the nights requested.',
  catering_order: 'Needs kitchen coverage and enough lead time to prepare.',
  fuel_uplift: 'Needs the fuel type available within service hours.',
  hangar_slot: 'Needs a hangar the aircraft physically fits in.',
};

export function assignmentStrategyHint(value: string): string {
  return (
    ASSIGNMENT_STRATEGY_HINTS[value] ??
    'Matched on coverage, desk hours, lead time and capacity.'
  );
}

// ---------------------------------------------------------------------------
// audit actions — `provider_company.approve` → `Provider approved`
// ---------------------------------------------------------------------------

export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  'provider_company.approve': 'Provider approved',
  'provider_company.suspend': 'Provider suspended',
  'provider_company.reject': 'Provider registration rejected',
  'provider_company.set_rank': 'Provider rank changed',

  'catalogue.create_service': 'Service category created',
  'catalogue.set_service_active': 'Service category enabled or disabled',

  'registry.create_airport': 'Airport added',
  'registry.create_fbo': 'Handler added',

  'user.create': 'Account created',
  'user.set_status': 'Account status changed',

  'settings.update': 'Setting changed',
  'feature_flag.update': 'Feature flag changed',

  'request.create': 'Request created',
  'request.cancel': 'Request cancelled',
  'request.override_provider': 'Provider overridden by operations',
  'request.release_contacts': 'Passenger contacts released early',
  'request_line.retry': 'Service put back into matching',

  // These eight are what the code ACTUALLY emits. Labels written against a guessed key
  // (`offer.acknowledged`, `auth.sign_in`) never matched a row and are kept below only so a
  // future rename still reads correctly — they are harmless, but they are not what fires.
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'offer.acknowledge': 'Provider accepted',
  'offer.decline': 'Provider declined',
  'offer.expire': 'Offer expired unanswered',
  'request_line.match_failed': 'No provider could be found',
  'request_line.override_provider': 'Provider overridden by operations',
  'request_line.rematch_ceiling': 'Re-match limit reached',
  'request_line.force_status': 'Service status forced by operations',
  'assignment.force_release': 'Resources released by operations',
  'user.suspend': 'Account suspended',

  'offer.sent': 'Offer sent to provider',
  'offer.acknowledged': 'Provider accepted',
  'offer.declined': 'Provider declined',
  'offer.expired': 'Offer expired unanswered',
  'offer.withdrawn': 'Offer withdrawn',

  'assignment.create': 'Resources committed',
  'assignment.release': 'Resources released',

  'document.generate': 'Document generated',
  'document.download': 'Document opened',

  'message.post': 'Message posted',

  'provider.add_vehicle': 'Vehicle added',
  'provider.add_driver': 'Driver added',
  'provider.add_officer': 'Officer added',
  'provider.retire_resource': 'Resource taken out of service',
  'provider.restore_resource': 'Resource returned to service',
  'provider.update_coverage': 'Coverage changed',

  'auth.sign_in': 'Signed in',
  'auth.sign_in_failed': 'Sign-in failed',
  'auth.password_change': 'Password changed',
  'auth.forced_sign_out': 'Signed out everywhere',
};

export function auditActionLabel(value: string): string {
  return AUDIT_ACTION_LABELS[value] ?? humanise(value);
}

// ---------------------------------------------------------------------------
// AI stages and failure categories
// ---------------------------------------------------------------------------

export const AI_STAGE_LABELS: Readonly<Record<string, string>> = {
  intake: 'Reading a request',
  matching: 'Choosing a provider',
  research: 'Answering a question',
  summary: 'Writing a summary',
};

export function aiStageLabel(value: string): string {
  return AI_STAGE_LABELS[value] ?? humanise(value);
}

export const AI_ERROR_LABELS: Readonly<Record<string, string>> = {
  schema_invalid: 'Response did not match the schema',
  verification_failed: 'Choice failed verification',
  timeout: 'Provider did not respond in time',
  refused: 'Model declined to answer',
  unavailable: 'Provider unavailable',
  error: 'Unexpected provider error',
  rate_limited: 'Rate limited by the provider',
  disabled: 'AI is switched off',
};

export function aiErrorLabel(value: string | null): string {
  if (value === null || value === '') return 'No failure recorded';
  return AI_ERROR_LABELS[value] ?? humanise(value);
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

export const USER_ROLE_LABELS: Readonly<Record<string, string>> = {
  platform_admin: 'Platform administrator',
  operations_manager: 'Operations manager',
  operations_agent: 'Operations agent',
  provider_admin: 'Provider administrator',
  provider_dispatcher: 'Dispatcher',
  provider_staff: 'Staff',
  client: 'Client',
};

export function userRoleLabel(value: string): string {
  return USER_ROLE_LABELS[value] ?? humanise(value);
}

// ---------------------------------------------------------------------------
// request and service-line lifecycle
// ---------------------------------------------------------------------------

export const REQUEST_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: 'Draft',
  awaiting_confirmation: 'Awaiting confirmation',
  sent: 'Sent',
  sourcing: 'Finding providers',
  partial: 'Partly covered',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Needs attention',
};

export function requestStatusLabel(value: string): string {
  return REQUEST_STATUS_LABELS[value] ?? humanise(value);
}

/**
 * Service-line status, for an operational reader.
 *
 * Deliberately different wording from the client's view of the same states: a controller
 * needs to know a line is *offered but unanswered*, where a client only needs "being
 * arranged". The client wording lives on the client page and stays there.
 */
export const LINE_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: 'Draft',
  matching: 'Matching',
  offered: 'Offered',
  waiting: 'Awaiting response',
  acknowledged: 'Accepted',
  declined: 'Declined',
  rematching: 'Re-matching',
  assigned: 'Assigned',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Not covered',
};

export function lineStatusLabel(value: string): string {
  return LINE_STATUS_LABELS[value] ?? humanise(value);
}

export const OFFER_STATUS_LABELS: Readonly<Record<string, string>> = {
  sent: 'Awaiting response',
  acknowledged: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
};

export function offerStatusLabel(value: string): string {
  return OFFER_STATUS_LABELS[value] ?? humanise(value);
}

export const PRIORITY_LABELS: Readonly<Record<string, string>> = {
  low: 'Low priority',
  normal: 'Normal',
  high: 'High priority',
  urgent: 'Urgent',
};

export function priorityLabel(value: string): string {
  return PRIORITY_LABELS[value] ?? humanise(value);
}

/** Who made the choice — not the internal source identifier. */
export const SELECTION_SOURCE_LABELS: Readonly<Record<string, string>> = {
  ai: 'Model, verified',
  deterministic: 'Ranking',
  manual: 'Chosen by operations',
};

export function selectionSourceLabel(value: string | null): string {
  if (value === null) return 'Not yet selected';
  return SELECTION_SOURCE_LABELS[value] ?? humanise(value);
}

// ---------------------------------------------------------------------------
// people and companies
// ---------------------------------------------------------------------------

export const PROVIDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  suspended: 'Suspended',
  rejected: 'Rejected',
};

export function providerStatusLabel(value: string): string {
  return PROVIDER_STATUS_LABELS[value] ?? humanise(value);
}

export const USER_STATUS_LABELS: Readonly<Record<string, string>> = {
  active: 'Active',
  suspended: 'Suspended',
  invited: 'Invited',
};

export function userStatusLabel(value: string): string {
  return USER_STATUS_LABELS[value] ?? humanise(value);
}

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------

export const RESOURCE_KIND_LABELS: Readonly<Record<string, string>> = {
  vehicle: 'Vehicle',
  driver: 'Driver',
  officer: 'Officer',
  hotel_room: 'Hotel room',
  catering: 'Catering',
  fuel: 'Fuel',
  hangar: 'Hangar',
};

export function resourceKindLabel(value: string): string {
  return RESOURCE_KIND_LABELS[value] ?? humanise(value);
}

/** Vehicle classes keep their industry casing — "SUV", not "Suv". */
export const VEHICLE_CLASS_LABELS: Readonly<Record<string, string>> = {
  sedan: 'Sedan',
  suv: 'SUV',
  van: 'Van',
  sprinter: 'Sprinter',
  limousine: 'Limousine',
  minibus: 'Minibus',
  coach: 'Coach',
  armored_suv: 'Armoured SUV',
};

export function vehicleClassLabel(value: string): string {
  return VEHICLE_CLASS_LABELS[value] ?? humanise(value);
}

export const RESOURCE_STATUS_LABELS: Readonly<Record<string, string>> = {
  available: 'Available',
  maintenance: 'In maintenance',
  retired: 'Retired',
  off_duty: 'Off duty',
  inactive: 'Inactive',
};

export function resourceStatusLabel(value: string): string {
  return RESOURCE_STATUS_LABELS[value] ?? humanise(value);
}

/** Fuel grades as the industry writes them. */
export const FUEL_TYPE_LABELS: Readonly<Record<string, string>> = {
  jet_a: 'Jet A',
  jet_a_plus: 'Jet A+',
  saf_blend: 'SAF blend',
  avgas_100ll: 'Avgas 100LL',
};

export function fuelTypeLabel(value: string): string {
  return FUEL_TYPE_LABELS[value] ?? humanise(value);
}

// ---------------------------------------------------------------------------
// AI observability
// ---------------------------------------------------------------------------

export const AI_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  success: 'Succeeded',
  schema_invalid: 'Invalid response',
  verification_failed: 'Failed verification',
  timeout: 'Timed out',
  refused: 'Declined to answer',
  unavailable: 'Unavailable',
  error: 'Error',
};

export function aiOutcomeLabel(value: string): string {
  return AI_OUTCOME_LABELS[value] ?? humanise(value);
}

// ---------------------------------------------------------------------------
// Values that live in data rather than in an enum
// ---------------------------------------------------------------------------

/**
 * The three maps below name values the SCHEMA does not constrain: room types and fuel
 * grades declared in a service category's config, and free-form capability tags a provider
 * puts on a vehicle. A provider can invent a tag this build has never seen, so these fall
 * back to `humanise` rather than throwing — an unknown tag reads as "Rear climate", not as
 * an identifier and not as nothing.
 */
export const ROOM_TYPE_LABELS: Readonly<Record<string, string>> = {
  standard: 'Standard room',
  deluxe: 'Deluxe room',
  junior_suite: 'Junior suite',
  suite: 'Suite',
};

export const VEHICLE_FEATURE_LABELS: Readonly<Record<string, string>> = {
  wifi: 'Wi-Fi',
  water: 'Bottled water',
  partition: 'Privacy partition',
  child_seat: 'Child seat',
  run_flat: 'Run-flat tyres',
  rear_climate: 'Rear climate control',
  armored_b6: 'B6 armour',
  conference_seating: 'Conference seating',
};

export function featureLabel(value: string): string {
  return VEHICLE_FEATURE_LABELS[value] ?? humanise(value);
}

/**
 * One value out of a service category's declared `options` list. The declaring admin chooses
 * the option keys, so this tries every registry that could name one before humanising.
 */
export function configValueLabel(value: string): string {
  return (
    FUEL_TYPE_LABELS[value] ??
    ROOM_TYPE_LABELS[value] ??
    VEHICLE_CLASS_LABELS[value] ??
    VEHICLE_FEATURE_LABELS[value] ??
    humanise(value)
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** What an audit row acted ON. The table name is not a thing to show a governance reader. */
export const ENTITY_TYPE_LABELS: Readonly<Record<string, string>> = {
  request: 'Request',
  request_service_line: 'Service line',
  provider_offer: 'Provider offer',
  assignment: 'Assignment',
  provider_company: 'Provider company',
  provider_coverage: 'Provider coverage',
  service_category: 'Service',
  vehicle: 'Vehicle',
  driver: 'Driver',
  security_officer: 'Close protection officer',
  user: 'User',
  airport: 'Airport',
  fbo: 'FBO',
  document: 'Document',
  message_thread: 'Conversation',
  platform_setting: 'Platform setting',
  feature_flag: 'Feature flag',
};

export function entityTypeLabel(value: string): string {
  return ENTITY_TYPE_LABELS[value] ?? humanise(value);
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * The permission matrix in Admin is a governance surface: an administrator reads it to
 * answer "can a provider dispatcher see another company's prices?". That question is asked
 * in English, so the matrix answers in English.
 *
 * The exact key is NOT dropped — it stays on each entry as its tooltip, because the key is
 * what `can()` is called with and what a support thread cites. Only the reading changes.
 */
export const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'request.create': 'Create requests',
  'request.view.any': 'View every request',
  'request.view.own_client': 'View their own requests',
  'request.view.offered_to_own_provider': 'View requests offered to their company',
  'request.update': 'Edit requests',
  'request.cancel': 'Cancel requests',
  'request.override_provider': 'Override the chosen provider',
  'request.force_status': 'Force a request status',
  'request.view_passenger_contacts': 'View passenger contact details',
  'request.release_contacts_to_provider': 'Release contacts to a provider',
  'request.view_decision_trace': 'View the decision trace',
  'request.use_research_assistant': 'Use the research assistant',

  'offer.acknowledge': 'Accept an offer',
  'offer.decline': 'Decline an offer',
  'assignment.create': 'Assign resources',
  'assignment.release': 'Release an assignment',
  'assignment.view.any': 'View every assignment',
  'assignment.view.own_provider': 'View their company’s assignments',

  'provider.view.own': 'View their own company',
  'provider.manage.own_profile': 'Edit their company profile',
  'provider.manage.own_coverage': 'Edit their company’s coverage',
  'provider.manage.own_resources': 'Manage their company’s fleet and staff',
  'provider.manage.own_users': 'Manage their company’s users',

  'provider.view.any': 'View every provider',
  'provider.approve': 'Approve a provider',
  'provider.suspend': 'Suspend a provider',
  'provider.set_rank': 'Set provider rank',
  'catalogue.manage': 'Manage the service catalogue',
  'registry.manage': 'Manage airports and FBOs',
  'user.manage': 'Manage platform users',
  'settings.manage': 'Change platform settings',
  'feature_flag.manage': 'Turn features on and off',
  'audit.view': 'Read the audit trail',
  'ai.view_observability': 'View AI reliability',

  'message.send.internal': 'Post internal messages',
  'message.send.provider_thread': 'Message providers',
  'message.view.any': 'Read every conversation',
};

export function permissionLabel(value: string): string {
  return PERMISSION_LABELS[value] ?? humanise(value.replace(/\./g, ' '));
}
