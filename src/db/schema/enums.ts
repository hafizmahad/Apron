/**
 * Every constrained string value in the schema, as a frozen tuple plus its union type.
 *
 * These are the single source of truth shared by the Drizzle column definitions, the Zod
 * validators and the state machines. `tests/integration/db/schema-parity.test.ts` reads
 * the live `CHECK` constraints out of `pg_constraint` and asserts that each list here
 * matches the database exactly — so a value added in SQL but not in TypeScript, or the
 * reverse, fails the build rather than surfacing as a runtime constraint violation.
 *
 * Postgres enums are deliberately not used: `ALTER TYPE ... ADD VALUE` cannot run inside
 * the transaction the migration runner wraps each file in (ADR-003).
 */

function values<const T extends readonly string[]>(list: T): T {
  return Object.freeze(list) as T;
}

// --- identity ---------------------------------------------------------------
export const userRoles = values([
  'platform_admin',
  'operations_manager',
  'operations_agent',
  'provider_admin',
  'provider_dispatcher',
  'provider_staff',
  'client',
]);
export type UserRole = (typeof userRoles)[number];

export const providerRoles = values(['provider_admin', 'provider_dispatcher', 'provider_staff']);
export type ProviderRole = (typeof providerRoles)[number];

export const operationsRoles = values(['operations_manager', 'operations_agent']);
export type OperationsRole = (typeof operationsRoles)[number];

export const userStatuses = values(['active', 'suspended', 'invited']);
export type UserStatus = (typeof userStatuses)[number];

export const providerCompanyStatuses = values(['pending', 'approved', 'suspended', 'rejected']);
export type ProviderCompanyStatus = (typeof providerCompanyStatuses)[number];

// --- catalogue --------------------------------------------------------------
/**
 * Selects which concrete-resource rules the eligibility engine applies to a category.
 * `generic` is the fallback for an admin-created category (ADR-008), so a brand-new
 * service is matched on coverage, desk hours, lead time and capacity alone.
 */
export const assignmentStrategies = values([
  'generic',
  'vehicle_with_driver',
  'officer',
  'hotel_rooms',
  'catering_order',
  'fuel_uplift',
  'hangar_slot',
]);
export type AssignmentStrategy = (typeof assignmentStrategies)[number];

/** The six seeded service codes. NOT a schema limit — admins may add more. */
export const seededServiceCodes = values([
  'ground_transport',
  'close_protection',
  'hotel',
  'catering',
  'fuel',
  'hangar',
]);
export type SeededServiceCode = (typeof seededServiceCodes)[number];

// --- requests ---------------------------------------------------------------
export const requestStatuses = values([
  'draft',
  'awaiting_confirmation',
  'sent',
  'sourcing',
  'partial',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'failed',
]);
export type RequestStatus = (typeof requestStatuses)[number];

export const requestLineStatuses = values([
  'draft',
  'matching',
  'offered',
  'waiting',
  'acknowledged',
  'declined',
  'rematching',
  'assigned',
  'in_progress',
  'completed',
  'cancelled',
  'failed',
]);
export type RequestLineStatus = (typeof requestLineStatuses)[number];

export const requestPriorities = values(['low', 'normal', 'high', 'urgent']);
export type RequestPriority = (typeof requestPriorities)[number];

export const requestChannels = values(['ops', 'client', 'guest']);
export type RequestChannel = (typeof requestChannels)[number];

export const personTypes = values(['passenger', 'crew']);
export type PersonType = (typeof personTypes)[number];

// --- matching and offers ----------------------------------------------------
export const offerStatuses = values(['sent', 'acknowledged', 'declined', 'expired', 'withdrawn']);
export type OfferStatus = (typeof offerStatuses)[number];

export const selectionSources = values(['ai', 'deterministic', 'manual']);
export type SelectionSource = (typeof selectionSources)[number];

export const confidenceLevels = values(['high', 'medium', 'low']);
export type ConfidenceLevel = (typeof confidenceLevels)[number];

// --- assignments ------------------------------------------------------------
export const assignmentStatuses = values([
  'planned',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
]);
export type AssignmentStatus = (typeof assignmentStatuses)[number];

/**
 * The kinds of concrete resource an assignment can commit.
 *
 * `vehicle`, `driver`, `officer` and `hangar` are singular physical things and are
 * protected by `EXCLUDE USING gist` constraints. `hotel_room`, `catering` and `fuel` are
 * pooled capacity: concurrent rows are legitimate up to the pool size, which is checked
 * under a row lock inside the assignment transaction.
 */
export const resourceKinds = values([
  'vehicle',
  'driver',
  'officer',
  'hotel_room',
  'catering',
  'fuel',
  'hangar',
]);
export type ResourceKind = (typeof resourceKinds)[number];

/** The subset protected by a database exclusion constraint. */
export const exclusiveResourceKinds = values(['vehicle', 'driver', 'officer', 'hangar']);
export type ExclusiveResourceKind = (typeof exclusiveResourceKinds)[number];

// --- resources --------------------------------------------------------------
export const vehicleClasses = values([
  'sedan',
  'suv',
  'van',
  'sprinter',
  'limousine',
  'minibus',
  'coach',
  'armored_suv',
]);
export type VehicleClass = (typeof vehicleClasses)[number];

export const vehicleStatuses = values(['available', 'maintenance', 'retired']);
export type VehicleStatus = (typeof vehicleStatuses)[number];

export const staffStatuses = values(['available', 'off_duty', 'inactive']);
export type StaffStatus = (typeof staffStatuses)[number];

export const fuelTypes = values(['jet_a', 'jet_a_plus', 'saf_blend', 'avgas_100ll']);
export type FuelType = (typeof fuelTypes)[number];

export const coverageScopes = values(['airport', 'fbo']);
export type CoverageScope = (typeof coverageScopes)[number];

export const aircraftCategories = values([
  'very_light',
  'light',
  'midsize',
  'super_midsize',
  'heavy',
  'ultra_long_range',
  'airliner',
]);
export type AircraftCategory = (typeof aircraftCategories)[number];

// --- messaging, documents, AI ----------------------------------------------
export const threadScopes = values(['internal', 'provider', 'client']);
export type ThreadScope = (typeof threadScopes)[number];

export const notificationSeverities = values(['info', 'success', 'warning', 'danger']);
export type NotificationSeverity = (typeof notificationSeverities)[number];

export const deliveryChannels = values(['email', 'sms']);
export type DeliveryChannel = (typeof deliveryChannels)[number];

export const deliveryStatuses = values(['pending', 'sent', 'failed', 'suppressed']);
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export const documentKinds = values([
  'itinerary',
  'service_confirmation',
  'handling_summary',
  'provider_work_order',
  'client_confirmation',
  'operational_packet',
  'upload',
]);
export type DocumentKind = (typeof documentKinds)[number];

export const documentContentTypes = values([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/json',
]);
export type DocumentContentType = (typeof documentContentTypes)[number];

export const storageDrivers = values(['filesystem', 's3']);
export type StorageDriver = (typeof storageDrivers)[number];

export const aiStages = values(['intake', 'matching', 'research', 'summary']);
export type AiStage = (typeof aiStages)[number];

export const aiOutcomes = values([
  'success',
  'schema_invalid',
  'verification_failed',
  'timeout',
  'refused',
  'unavailable',
  'error',
]);
export type AiOutcome = (typeof aiOutcomes)[number];

export const aiValidationStatuses = values(['valid', 'invalid', 'not_applicable']);
export type AiValidationStatus = (typeof aiValidationStatuses)[number];

export const aiVerificationStatuses = values(['verified', 'rejected', 'not_applicable']);
export type AiVerificationStatus = (typeof aiVerificationStatuses)[number];

// --- pricing ----------------------------------------------------------------
export const rateCardItemKinds = values([
  'unit_price',
  'minimum',
  'surcharge',
  'after_hours_fee',
  'platform_fee',
]);
export type RateCardItemKind = (typeof rateCardItemKinds)[number];

export const quoteStatuses = values(['draft', 'issued', 'accepted', 'voided']);
export type QuoteStatus = (typeof quoteStatuses)[number];
