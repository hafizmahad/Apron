import type { ServiceConfigSchema } from '@/db/schema';
import type { AssignmentStrategy } from '@/db/schema';

/**
 * The six launch services, as SEED ROWS rather than schema (ADR-008).
 *
 * Nothing in the codebase switches on these codes as an exhaustive set: an admin can add
 * a seventh category from the console with no migration, and it is matched by the
 * `generic` strategy until a specific rule set is registered for it.
 *
 * `configSchema` declares the per-service requirement fields. `src/domain/services/
 * requirements.ts` compiles each to a Zod schema and validates the request line's
 * `requirementsJson` against it at runtime — so "3 armed officers, German-speaking" is
 * structured, checkable data rather than prose the matcher has to guess at.
 */

export interface SeedServiceCategory {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly unitLabel: string;
  readonly assignmentStrategy: AssignmentStrategy;
  readonly sortOrder: number;
  readonly configSchema: ServiceConfigSchema;
}

export const seedServiceCategories: readonly SeedServiceCategory[] = [
  {
    code: 'ground_transport',
    name: 'Ground transport',
    description:
      'Chauffeured vehicles meeting an arrival or positioning for a departure, with a named driver assigned before the aircraft lands.',
    unitLabel: 'vehicle',
    assignmentStrategy: 'vehicle_with_driver',
    sortOrder: 10,
    configSchema: {
      fields: [
        {
          key: 'vehicleClass',
          label: 'Vehicle class',
          type: 'enum',
          required: true,
          options: ['sedan', 'suv', 'van', 'sprinter', 'limousine', 'minibus', 'coach', 'armored_suv'],
          help: 'Determines seat and luggage capacity checks against the passenger count.',
        },
        {
          key: 'passengers',
          label: 'Passengers to carry',
          type: 'integer',
          required: true,
          min: 1,
          max: 400,
        },
        { key: 'luggagePieces', label: 'Luggage pieces', type: 'integer', required: false, min: 0, max: 200 },
        { key: 'dropoffAddress', label: 'Drop-off address', type: 'text', required: false },
        {
          key: 'meetAndGreet',
          label: 'Meet and greet inside the FBO',
          type: 'boolean',
          required: false,
        },
        { key: 'childSeats', label: 'Child seats', type: 'integer', required: false, min: 0, max: 8 },
      ],
    },
  },
  {
    code: 'close_protection',
    name: 'Close protection',
    description:
      'Licensed protective officers accompanying principals from the aircraft through to the final destination.',
    unitLabel: 'officer',
    assignmentStrategy: 'officer',
    sortOrder: 20,
    configSchema: {
      fields: [
        { key: 'officers', label: 'Officers required', type: 'integer', required: true, min: 1, max: 40 },
        {
          key: 'armed',
          label: 'Armed detail',
          type: 'boolean',
          required: true,
          help: 'Matched against officer certification; never inferred from the request text.',
        },
        {
          key: 'coverageHours',
          label: 'Hours of cover',
          type: 'number',
          required: false,
          min: 1,
          max: 168,
          unit: 'hours',
        },
        { key: 'languages', label: 'Required languages', type: 'string', required: false },
        { key: 'principalBriefing', label: 'Briefing notes', type: 'text', required: false },
      ],
    },
  },
  {
    code: 'hotel',
    name: 'Hotel',
    description:
      'Rooms held with a partner property near the field, released automatically if not guaranteed by the hold deadline.',
    unitLabel: 'room night',
    assignmentStrategy: 'hotel_rooms',
    sortOrder: 30,
    configSchema: {
      fields: [
        {
          key: 'rooms',
          label: 'Rooms',
          type: 'integer',
          required: true,
          min: 1,
          max: 200,
          help: 'Rooms, not guests. Nine guests may be nine rooms or five.',
        },
        { key: 'nights', label: 'Nights', type: 'integer', required: true, min: 1, max: 60 },
        { key: 'guests', label: 'Guests', type: 'integer', required: false, min: 1, max: 400 },
        {
          key: 'roomType',
          label: 'Room type',
          type: 'enum',
          required: false,
          options: ['standard', 'deluxe', 'junior_suite', 'suite'],
        },
        { key: 'checkInLocal', label: 'Check-in (local)', type: 'string', required: false },
        { key: 'notes', label: 'Preferences', type: 'text', required: false },
      ],
    },
  },
  {
    code: 'catering',
    name: 'Catering',
    description:
      'Onboard catering prepared to the operator’s lead time and delivered to the handling agent before departure.',
    unitLabel: 'order',
    assignmentStrategy: 'catering_order',
    sortOrder: 40,
    configSchema: {
      fields: [
        { key: 'covers', label: 'Covers', type: 'integer', required: true, min: 1, max: 400 },
        {
          key: 'mealService',
          label: 'Service',
          type: 'enum',
          required: false,
          options: ['breakfast', 'lunch', 'dinner', 'snacks', 'canapes', 'full_day'],
        },
        { key: 'dietary', label: 'Dietary requirements', type: 'string', required: false },
        { key: 'deliveryLocal', label: 'Delivery time (local)', type: 'string', required: false },
        { key: 'notes', label: 'Menu notes', type: 'text', required: false },
      ],
    },
  },
  {
    code: 'fuel',
    name: 'Fuel',
    description: 'Uplift arranged with a into-plane provider at the handling FBO.',
    unitLabel: 'uplift',
    assignmentStrategy: 'fuel_uplift',
    sortOrder: 50,
    configSchema: {
      fields: [
        {
          key: 'fuelType',
          label: 'Fuel type',
          type: 'enum',
          required: true,
          options: ['jet_a', 'jet_a_plus', 'saf_blend', 'avgas_100ll'],
        },
        {
          key: 'gallons',
          label: 'Uplift',
          type: 'integer',
          required: false,
          min: 1,
          max: 60000,
          unit: 'US gallons',
          help: 'Optional: "fuel on arrival" with no figure is a valid request.',
        },
        { key: 'prist', label: 'Prist additive', type: 'boolean', required: false },
        { key: 'notes', label: 'Notes', type: 'text', required: false },
      ],
    },
  },
  {
    code: 'hangar',
    name: 'Hangar',
    description:
      'Covered parking sized against the airframe’s published wingspan, length and tail height.',
    unitLabel: 'slot',
    assignmentStrategy: 'hangar_slot',
    sortOrder: 60,
    configSchema: {
      fields: [
        {
          key: 'nights',
          label: 'Nights',
          type: 'integer',
          required: false,
          min: 1,
          max: 60,
          help: 'Optional: an overnight between an arrival and a next-day departure is inferred from the flight window.',
        },
        { key: 'heated', label: 'Heated hangar required', type: 'boolean', required: false },
        { key: 'notes', label: 'Notes', type: 'text', required: false },
      ],
    },
  },
];

/** Defaults the platform boots with. Editable from Admin without a deployment. */
export const seedPlatformSettings: readonly {
  readonly key: string;
  readonly value: unknown;
  readonly description: string;
}[] = [
  {
    key: 'sla.acknowledgement_minutes.default',
    value: 45,
    description: 'Minutes a provider has to acknowledge an offer before it expires and the line re-matches.',
  },
  {
    key: 'sla.acknowledgement_minutes.urgent',
    value: 20,
    description: 'Acknowledgement window for requests marked urgent.',
  },
  {
    key: 'matching.max_rematch_attempts',
    value: 4,
    description: 'How many providers a line will be offered to before it is marked failed for operations to resolve.',
  },
  {
    key: 'matching.same_provider_bonus',
    value: 15,
    description: 'Ranking bonus for a provider already selected on another line of the same request (fewer hand-offs).',
  },
  {
    key: 'requests.default_ground_transport_minutes',
    value: 180,
    description: 'Service window length for a ground transport line when the request gives no explicit end time.',
  },
  {
    key: 'requests.guest_link_ttl_hours',
    value: 72,
    description: 'How long a guest request link remains valid.',
  },
];

export const seedFeatureFlags: readonly {
  readonly key: string;
  readonly enabled: boolean;
  readonly description: string;
}[] = [
  {
    key: 'ai.intake_enabled',
    enabled: true,
    description: 'Use the model to parse natural-language intake. With this off, the structured form is the only path.',
  },
  {
    key: 'ai.matching_enabled',
    enabled: true,
    description: 'Consult the model to choose among already-eligible providers. With this off, the deterministic top rank is used.',
  },
  {
    key: 'ai.research_assistant_enabled',
    enabled: true,
    description: 'Read-only operations research assistant on the request detail page.',
  },
  {
    key: 'notifications.sms_enabled',
    enabled: false,
    description: 'Urgent overnight acknowledgement chasing by SMS. Requires an SMS transport to be configured.',
  },
  {
    key: 'client.guest_requests_enabled',
    enabled: true,
    description: 'Allow request creation by secure guest link without a client account.',
  },
];
