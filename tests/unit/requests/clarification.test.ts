import { describe, expect, it } from 'vitest';
import type { ServiceConfigSchema } from '@/db/schema';
import {
  CLARIFICATION_ATTEMPT_CEILING,
  planClarifications,
  type ClarificationSnapshot,
  type ServiceClarificationSnapshot,
} from '@/domain/requests/clarification';
import { missingRequiredFields, validateRequirements } from '@/domain/services/requirements';

/**
 * The clarification engine (CLAUDE.md §8).
 *
 * Every case below drives the engine with a CONFIGURATION rather than a hard-coded service,
 * because that is the property under test: nothing in the engine knows what ground transport
 * is. A service invented in this file gets the same treatment as a seeded one, which is what
 * makes "an admin adds a category and it is asked about correctly" a fact rather than a hope.
 */

const EMPTY: ClarificationSnapshot = {
  airportResolved: true,
  airportToken: 'Teterboro',
  airportOptions: [],
  fboOptions: [],
  fboAmbiguous: false,
  fboToken: null,
  arrivalLocal: '2026-09-18T03:00',
  departureLocal: null,
  arrivalProblem: null,
  departureProblem: null,
  services: [],
  catalogueOptions: [
    { value: 'cat-ground', label: 'Ground transport' },
    { value: 'cat-hotel', label: 'Hotel' },
  ],
  ambiguities: [],
  attempts: {},
  skipped: [],
};

function service(
  overrides: Partial<ServiceClarificationSnapshot> & { readonly config: ServiceConfigSchema },
): ServiceClarificationSnapshot {
  return {
    index: 0,
    token: 'cars',
    categoryName: 'Ground transport',
    categoryCode: 'ground_transport',
    categoryOptions: [],
    quantity: 2,
    unitLabel: 'vehicle',
    requirements: {},
    invalidFields: [],
    ...overrides,
  };
}

/** Two required fields and one optional, which is the shape most catalogue rows take. */
const GROUND: ServiceConfigSchema = {
  fields: [
    {
      key: 'vehicleClass',
      label: 'Vehicle class',
      type: 'enum',
      required: true,
      options: ['sedan', 'suv', 'van'],
    },
    { key: 'passengers', label: 'Passengers to carry', type: 'integer', required: true, min: 1, max: 400 },
    { key: 'luggagePieces', label: 'Luggage pieces', type: 'integer', required: false },
  ],
};

describe('trip-level required information', () => {
  it('asks which airport when none was resolved', () => {
    const plan = planClarifications({ ...EMPTY, airportResolved: false, airportToken: null });

    const item = plan.blocking.find((entry) => entry.id === 'trip.airport');
    expect(item?.state).toBe('blocking_missing');
    expect(item?.question).toBe('Which airport is the aircraft arriving at?');
    expect(plan.complete).toBe(false);
  });

  it('asks for a time when neither an arrival nor a departure was given', () => {
    const plan = planClarifications({ ...EMPTY, arrivalLocal: null, departureLocal: null });

    const item = plan.blocking.find((entry) => entry.id === 'trip.arrival');
    expect(item?.control.kind).toBe('datetime');
    expect(plan.complete).toBe(false);
  });

  it('does not ask for a departure merely because it is absent', () => {
    // Every category derives its window from whichever instant it has, so an arrival is
    // enough. Asking for a departure here would be asking for something nothing needs.
    const plan = planClarifications({
      ...EMPTY,
      arrivalLocal: '2026-09-18T03:00',
      departureLocal: null,
      services: [service({ config: GROUND, requirements: { vehicleClass: 'suv', passengers: 4 } })],
    });

    expect(plan.items.map((item) => item.id)).not.toContain('trip.departure');
    expect(plan.complete).toBe(true);
  });

  it('asks which services when the sentence named none', () => {
    const plan = planClarifications({ ...EMPTY, services: [] });

    const item = plan.blocking.find((entry) => entry.id === 'trip.services');
    expect(item?.control).toMatchObject({ kind: 'enum' });
    expect(item?.control.kind === 'enum' && item.control.options).toHaveLength(2);
  });
});

describe('service-specific required information', () => {
  it('asks for every required field the catalogue declares and none of the optional ones', () => {
    const plan = planClarifications({ ...EMPTY, services: [service({ config: GROUND })] });

    expect(plan.blocking.map((item) => item.field)).toEqual(['vehicleClass', 'passengers']);
    expect(plan.optional.map((item) => item.field)).toEqual(['luggagePieces']);
    expect(plan.complete).toBe(false);
  });

  it('renders each field with the control its declared type calls for', () => {
    const plan = planClarifications({ ...EMPTY, services: [service({ config: GROUND })] });

    const byField = new Map(plan.items.map((item) => [item.field, item.control]));
    expect(byField.get('vehicleClass')).toMatchObject({ kind: 'enum' });
    expect(byField.get('passengers')).toMatchObject({ kind: 'integer', min: 1, max: 400 });
  });

  it('never shows the declared key, only its label', () => {
    const plan = planClarifications({ ...EMPTY, services: [service({ config: GROUND })] });

    // Identifier-shaped, not merely "contains the key": `passengers` is also an ordinary
    // English word, and a question is allowed to use it. What must never appear is the key
    // AS a key — `vehicleClass`, `room_type` — which is what these two patterns catch.
    for (const item of plan.items) {
      expect(item.question, `key leaked into: ${item.question}`).not.toMatch(
        /[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[a-z][a-z0-9]*_[a-z0-9]+/,
      );
      expect(item.label).not.toContain('_');
    }
  });

  it('stops asking once the value is supplied', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [service({ config: GROUND, requirements: { vehicleClass: 'suv', passengers: 4 } })],
    });

    expect(plan.blocking).toEqual([]);
    expect(plan.complete).toBe(true);
  });

  it('optional fields never block confirmation', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [service({ config: GROUND, requirements: { vehicleClass: 'suv', passengers: 4 } })],
    });

    expect(plan.optional.map((item) => item.field)).toEqual(['luggagePieces']);
    expect(plan.complete).toBe(true);
  });
});

describe('ambiguity', () => {
  it('asks which airport was meant, from database candidates only', () => {
    const plan = planClarifications({
      ...EMPTY,
      airportResolved: false,
      airportToken: 'Miami',
      airportOptions: [
        { value: 'id-kmia', label: 'Miami International (KMIA)' },
        { value: 'id-kopf', label: 'Miami-Opa Locka Executive (KOPF)' },
      ],
    });

    const item = plan.blocking.find((entry) => entry.id === 'trip.airport');
    expect(item?.state).toBe('blocking_ambiguous');
    expect(item?.control.kind).toBe('entity');
    // The options ARE rows. Nothing here may be invented, so every option carries an id.
    expect(item?.control.kind === 'entity' && item.control.options.map((o) => o.value)).toEqual([
      'id-kmia',
      'id-kopf',
    ]);
  });

  it('asks which service was meant when a token matched more than one', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [
        service({
          config: GROUND,
          categoryCode: null,
          categoryName: null,
          token: 'transfer',
          categoryOptions: [
            { value: 'cat-ground', label: 'Ground transport' },
            { value: 'cat-hotel', label: 'Hotel' },
          ],
        }),
      ],
    });

    const item = plan.blocking.find((entry) => entry.field === 'category');
    expect(item?.state).toBe('blocking_ambiguous');
    expect(item?.question).toContain('transfer');
  });

  it("attaches the model's own explanation to the field the ambiguity is about", () => {
    // The model noticed "hotel for nine" is unclear. It does not get to decide the value —
    // it only says why the question is being asked, next to the question.
    const hotel: ServiceConfigSchema = {
      fields: [
        { key: 'rooms', label: 'Rooms', type: 'integer', required: true },
        { key: 'nights', label: 'Nights', type: 'integer', required: true },
      ],
    };

    const plan = planClarifications({
      ...EMPTY,
      services: [
        service({
          config: hotel,
          categoryCode: 'hotel',
          categoryName: 'Hotel',
          token: 'hotel',
          requirements: { guests: 9 },
        }),
      ],
      ambiguities: [
        { field: 'hotel', issue: "unclear if 'nine' means nine guests or nine rooms", options: [] },
      ],
    });

    const rooms = plan.blocking.find((item) => item.field === 'rooms');
    expect(rooms?.help).toBe("unclear if 'nine' means nine guests or nine rooms");
  });

  it('reports a DST edge as answerable rather than as a dead end', () => {
    const plan = planClarifications({
      ...EMPTY,
      arrivalProblem: {
        kind: 'nonexistent',
        options: [{ value: '2026-03-08T03:00', label: '2026-03-08 03:00' }],
      },
    });

    const item = plan.blocking.find((entry) => entry.id === 'trip.arrival');
    expect(item?.state).toBe('blocking_ambiguous');
    expect(item?.control.kind).toBe('datetime');
    expect(item?.help).toContain('2026-03-08 03:00');
  });
});

describe('several services, each with its own gaps', () => {
  const HOTEL: ServiceConfigSchema = {
    fields: [
      { key: 'rooms', label: 'Rooms', type: 'integer', required: true },
      { key: 'roomType', label: 'Room type', type: 'enum', required: false, options: ['standard', 'suite'] },
    ],
  };

  it('asks each service for its own requirements, attributed to it', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [
        service({ index: 0, config: GROUND }),
        service({
          index: 1,
          config: HOTEL,
          categoryCode: 'hotel',
          categoryName: 'Hotel',
          token: 'hotel',
        }),
      ],
    });

    expect(plan.blocking.map((item) => item.id)).toEqual([
      'service.0.vehicleClass',
      'service.0.passengers',
      'service.1.rooms',
    ]);
    expect(plan.blocking.map((item) => item.serviceName)).toEqual([
      'Ground transport',
      'Ground transport',
      'Hotel',
    ]);
  });

  it('a service that is already complete is not asked about at all', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [
        service({ index: 0, config: GROUND, requirements: { vehicleClass: 'suv', passengers: 4 } }),
        service({ index: 1, config: HOTEL, categoryCode: 'hotel', categoryName: 'Hotel' }),
      ],
    });

    expect(plan.blocking.map((item) => item.id)).toEqual(['service.1.rooms']);
  });
});

describe('conditional requirements', () => {
  /** A category an admin could add tomorrow, with a field that only sometimes applies. */
  const CLEANING: ServiceConfigSchema = {
    fields: [
      {
        key: 'cleaningLevel',
        label: 'Cleaning level',
        type: 'enum',
        required: true,
        options: ['exterior', 'interior', 'deep'],
      },
      {
        key: 'deepCleanAreas',
        label: 'Areas for the deep clean',
        type: 'string',
        required: true,
        dependsOn: { field: 'cleaningLevel', equals: 'deep' },
      },
      { key: 'readyBy', label: 'Ready by', type: 'string', required: true },
    ],
  };

  const cleaning = (requirements: Record<string, unknown>): ServiceClarificationSnapshot =>
    service({
      config: CLEANING,
      categoryCode: 'aircraft_cleaning',
      categoryName: 'Aircraft cleaning',
      token: 'cleaning',
      requirements,
    });

  it('does not ask a conditional field before its condition is met', () => {
    const plan = planClarifications({ ...EMPTY, services: [cleaning({})] });

    expect(plan.blocking.map((item) => item.field)).toEqual(['cleaningLevel', 'readyBy']);
    expect(plan.blocking.map((item) => item.field)).not.toContain('deepCleanAreas');
  });

  it('asks it as soon as the answer makes it relevant', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [cleaning({ cleaningLevel: 'deep', readyBy: '14:00' })],
    });

    expect(plan.blocking.map((item) => item.field)).toEqual(['deepCleanAreas']);
    expect(plan.complete).toBe(false);
  });

  it('leaves it alone when a different answer makes it irrelevant', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [cleaning({ cleaningLevel: 'exterior', readyBy: '14:00' })],
    });

    expect(plan.blocking).toEqual([]);
    expect(plan.complete).toBe(true);
  });

  it('validation agrees with the engine about what is required', () => {
    // If these two ever disagree, the engine declines to ask for a field that creation then
    // refuses for being absent — an unanswerable request.
    const exterior = { cleaningLevel: 'exterior', readyBy: '14:00' };
    expect(missingRequiredFields(CLEANING, exterior)).toEqual([]);
    expect(validateRequirements('aircraft_cleaning', CLEANING, exterior).ok).toBe(true);

    const deep = { cleaningLevel: 'deep', readyBy: '14:00' };
    expect(missingRequiredFields(CLEANING, deep).map((field) => field.key)).toEqual([
      'deepCleanAreas',
    ]);
    expect(validateRequirements('aircraft_cleaning', CLEANING, deep).ok).toBe(false);
  });
});

describe('a service configured entirely at runtime', () => {
  it('is asked about by the same engine, with no component written for it', () => {
    const config: ServiceConfigSchema = {
      fields: [
        { key: 'aircraft', label: 'Aircraft', type: 'string', required: true },
        {
          key: 'cleaningLevel',
          label: 'Cleaning level',
          type: 'enum',
          required: true,
          options: ['exterior', 'interior', 'deep'],
        },
        { key: 'readyBy', label: 'Ready-by time', type: 'string', required: true },
        { key: 'notes', label: 'Notes', type: 'text', required: false },
      ],
    };

    const plan = planClarifications({
      ...EMPTY,
      services: [
        service({
          config,
          categoryCode: 'aircraft_cleaning',
          categoryName: 'Aircraft cleaning',
          token: 'cleaning',
        }),
      ],
    });

    expect(plan.blocking.map((item) => item.question)).toEqual([
      'Aircraft?',
      'Which cleaning level?',
      'Ready-by time?',
    ]);
    expect(plan.optional.map((item) => item.question)).toEqual(['Notes?']);
    expect(plan.complete).toBe(false);
  });
});

describe('not asking the same thing forever', () => {
  it('offers a plain correction control once a question has been asked too often', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [service({ config: GROUND })],
      attempts: { 'service.0.vehicleClass': CLARIFICATION_ATTEMPT_CEILING },
    });

    const item = plan.blocking.find((entry) => entry.field === 'vehicleClass');
    expect(item?.exhausted).toBe(true);
    // Still blocking: giving up on asking is not the same as inventing the answer.
    expect(item?.state).toBe('blocking_missing');
    expect(plan.complete).toBe(false);
  });

  it('a question asked twice is not yet a loop', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [service({ config: GROUND })],
      attempts: { 'service.0.vehicleClass': 2 },
    });

    expect(plan.blocking.find((entry) => entry.field === 'vehicleClass')?.exhausted).toBe(false);
  });
});

describe('no preference', () => {
  it('stops asking an optional question the user waved away', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [service({ config: GROUND, requirements: { vehicleClass: 'suv', passengers: 4 } })],
      skipped: ['service.0.luggagePieces'],
    });

    expect(plan.items).toEqual([]);
    expect(plan.complete).toBe(true);
  });

  it('refuses to let a required question be skipped', () => {
    // The value arrives from a browser, so "I skipped it" is a claim, not a fact.
    const plan = planClarifications({
      ...EMPTY,
      services: [service({ config: GROUND })],
      skipped: ['service.0.vehicleClass', 'service.0.passengers'],
    });

    expect(plan.blocking.map((item) => item.field)).toEqual(['vehicleClass', 'passengers']);
    expect(plan.complete).toBe(false);
  });
});

describe('a value that is present but unusable', () => {
  it('is asked for again rather than treated as settled', () => {
    // The model returned a vehicle class the catalogue does not declare. The field is not
    // empty, so a naive "is it present?" check would pass it straight through to creation,
    // which would then refuse the whole request.
    const plan = planClarifications({
      ...EMPTY,
      services: [
        service({
          config: GROUND,
          requirements: { vehicleClass: 'hovercraft', passengers: 4 },
          invalidFields: ['vehicleClass'],
        }),
      ],
    });

    const item = plan.blocking.find((entry) => entry.field === 'vehicleClass');
    expect(item?.state).toBe('blocking_missing');
    expect(item?.help).toContain('hovercraft');
    expect(plan.complete).toBe(false);
  });

  it('does not leak the validator wording into the question', () => {
    const plan = planClarifications({
      ...EMPTY,
      services: [
        service({
          config: GROUND,
          requirements: { vehicleClass: 'hovercraft' },
          invalidFields: ['vehicleClass'],
        }),
      ],
    });

    for (const item of plan.items) {
      expect(item.question).not.toContain('Invalid enum');
      expect(item.help ?? '').not.toContain('Expected');
    }
  });
});

describe('loosely-cased answers the catalogue can still read', () => {
  const config: ServiceConfigSchema = {
    fields: [
      {
        key: 'vehicleClass',
        label: 'Vehicle class',
        type: 'enum',
        required: true,
        options: ['sedan', 'suv', 'armored_suv'],
      },
    ],
  };

  it('accepts a declared option whatever its casing or spacing', () => {
    // "SUV" is what a model writes and "Armored SUV" is what a person types. Each names
    // exactly one declared option, so neither is a guess.
    for (const [given, expected] of [
      ['SUV', 'suv'],
      ['suv', 'suv'],
      ['Armored SUV', 'armored_suv'],
      ['armored-suv', 'armored_suv'],
    ] as const) {
      const result = validateRequirements('ground_transport', config, { vehicleClass: given });
      expect(result.ok, `"${given}" was rejected`).toBe(true);
      expect(result.ok && result.value['vehicleClass']).toBe(expected);
    }
  });

  it('still refuses a value that names no declared option', () => {
    const result = validateRequirements('ground_transport', config, { vehicleClass: 'hovercraft' });
    expect(result.ok).toBe(false);
  });
});
