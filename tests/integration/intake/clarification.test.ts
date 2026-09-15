import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { airports, clientOrganizations, fbos, serviceCategories, users } from '@/db/schema';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import { useMemoryMailTransportForTests } from '@/lib/mail';
import { clarificationPlanFor, isDraftDispatchable, resolveExtraction } from '@/domain/requests/intake';
import {
  applyAnswers,
  countAttempts,
  rebuildDraft,
  toDraftState,
  NO_PREFERENCE,
  type DraftState,
} from '@/domain/requests/draft-state';
import { listActiveServiceCategories } from '@/domain/services/resolve';
import { createRequest } from '@/domain/requests/create';
import { emptyExtraction } from '@/ai/intake/schema';
import { ensureMigrated, captureError, truncateAll } from '../../helpers/database';

/**
 * Clarification against the real catalogue and registry (CLAUDE.md §8).
 *
 * The unit tests prove the engine's rules. These prove the loop: that answers survive a
 * round trip through the database, that an entity choice is only ever a real row, and —
 * the point of the whole exercise — that a request cannot be created while the catalogue
 * says something required is still missing.
 *
 * The model is not involved. Every extraction below is supplied directly, so what is under
 * test is the deterministic half.
 */

let fixture: {
  clientOrganizationId: string;
  userId: string;
  categories: Awaited<ReturnType<typeof listActiveServiceCategories>>;
};

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  await runSeed();
  setAiAdapterForTests(undefined);
  useMemoryMailTransportForTests();

  const db = getDb();
  const [organisation] = await db.select().from(clientOrganizations).limit(1);
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.clientOrganizationId, organisation!.id))
    .limit(1);

  fixture = {
    clientOrganizationId: organisation!.id,
    userId: user!.id,
    categories: await listActiveServiceCategories(),
  };
});

/** A draft as intake would produce it: services identified, requirements not yet given. */
async function draftFor(
  services: readonly {
    token: string;
    code: string;
    quantity: number | null;
    requirements?: Record<string, string | number | boolean>;
  }[],
  overrides: { airportToken?: string | null; arrivalLocal?: string | null } = {},
): Promise<DraftState> {
  const draft = await resolveExtraction(
    'Landing at Teterboro Friday at 03:00.',
    {
      ...emptyExtraction,
      airportToken: overrides.airportToken === undefined ? 'Teterboro' : overrides.airportToken,
      arrivalLocal: overrides.arrivalLocal === undefined ? '2026-09-18T03:00' : overrides.arrivalLocal,
      services: services.map((service) => ({
        serviceCode: service.code as never,
        serviceNameToken: service.token,
        quantity: service.quantity,
        requirements: service.requirements ?? {},
      })),
      confidence: 'high',
    },
    'ai',
    null,
    fixture.categories,
  );

  return toDraftState(draft);
}

async function planFor(state: DraftState) {
  const draft = await rebuildDraft(state);
  return {
    draft,
    plan: clarificationPlanFor(draft, fixture.categories, state.attempts, state.skipped),
    dispatchable: isDraftDispatchable(draft, fixture.categories),
  };
}

describe('what the catalogue says is still needed', () => {
  it('asks for the required fields of every service in the request', async () => {
    const state = await draftFor([
      { token: 'cars', code: 'ground_transport', quantity: 2 },
      { token: 'hotel', code: 'hotel', quantity: null },
    ]);

    const { plan, dispatchable } = await planFor(state);

    expect(plan.blocking.map((item) => item.field)).toEqual([
      'vehicleClass',
      'passengers',
      'rooms',
      'nights',
    ]);
    expect(dispatchable).toBe(false);
  });

  it('asks nothing further once every required field is answered', async () => {
    const state = await draftFor([
      {
        token: 'cars',
        code: 'ground_transport',
        quantity: 2,
        requirements: { vehicleClass: 'suv', passengers: 4 },
      },
    ]);

    const { plan, dispatchable } = await planFor(state);

    expect(plan.blocking).toEqual([]);
    expect(plan.complete).toBe(true);
    expect(dispatchable).toBe(true);
  });

  it('optional fields are offered but never block', async () => {
    const state = await draftFor([
      {
        token: 'cars',
        code: 'ground_transport',
        quantity: 2,
        requirements: { vehicleClass: 'suv', passengers: 4 },
      },
    ]);

    const { plan } = await planFor(state);

    expect(plan.optional.length).toBeGreaterThan(0);
    expect(plan.complete).toBe(true);
  });
});

describe('a round of answers', () => {
  it('resolves what was asked and keeps what was already known', async () => {
    const state = await draftFor([
      { token: 'cars', code: 'ground_transport', quantity: 2 },
      { token: 'hotel', code: 'hotel', quantity: null, requirements: { guests: 9 } },
    ]);

    const first = await planFor(state);
    expect(first.plan.blocking).toHaveLength(4);

    const answered = applyAnswers(state, {
      'service.0.vehicleClass': 'suv',
      'service.0.passengers': '4',
    });

    const second = await planFor(answered);

    // The two ground transport questions are gone; the hotel's remain.
    expect(second.plan.blocking.map((item) => item.field)).toEqual(['rooms', 'nights']);

    // Nothing already known was lost — including the value intake extracted itself.
    const ground = second.draft.services[0];
    expect(ground?.requirements).toMatchObject({ vehicleClass: 'suv', passengers: 4 });
    expect(second.draft.services[1]?.requirements).toMatchObject({ guests: 9 });
    expect(second.draft.sourceSentence).toBe('Landing at Teterboro Friday at 03:00.');
  });

  it('survives several rounds, and opens confirmation only at the end', async () => {
    let state = await draftFor([
      { token: 'cars', code: 'ground_transport', quantity: 2 },
      { token: 'bodyguards', code: 'close_protection', quantity: 3 },
    ]);

    expect((await planFor(state)).dispatchable).toBe(false);

    state = applyAnswers(state, { 'service.0.vehicleClass': 'suv' });
    expect((await planFor(state)).dispatchable).toBe(false);

    state = applyAnswers(state, { 'service.0.passengers': '4' });
    expect((await planFor(state)).dispatchable).toBe(false);

    state = applyAnswers(state, { 'service.1.officers': '3', 'service.1.armed': 'true' });

    const final = await planFor(state);
    expect(final.plan.blocking).toEqual([]);
    expect(final.dispatchable).toBe(true);
    // Every round's answers are still present.
    expect(final.draft.services[0]?.requirements).toMatchObject({ vehicleClass: 'suv', passengers: 4 });
    expect(final.draft.services[1]?.requirements).toMatchObject({ officers: 3, armed: true });
  });

  it('one answer can settle every question that hung off it', async () => {
    // An unrecognised token asks only "which service is this?". Answering it identifies the
    // category AND brings that category's own requirements into the conversation.
    const state = await draftFor([{ token: 'a ride', code: 'ground_transport', quantity: 1 }]);
    const ground = fixture.categories.find((category) => category.code === 'ground_transport');

    const unknown: DraftState = {
      ...state,
      services: [{ token: 'a ride', categoryId: null, quantity: 1, requirements: {} }],
    };

    const before = await planFor(unknown);
    expect(before.plan.blocking.map((item) => item.field)).toEqual(['category']);

    const after = await planFor(applyAnswers(unknown, { 'service.0.category': ground!.id }));
    expect(after.plan.blocking.map((item) => item.field)).toEqual(['vehicleClass', 'passengers']);
  });

  it('remembers an optional question that was waved away', async () => {
    const state = await draftFor([
      {
        token: 'cars',
        code: 'ground_transport',
        quantity: 2,
        requirements: { vehicleClass: 'suv', passengers: 4 },
      },
    ]);

    const before = await planFor(state);
    const optional = before.plan.optional[0];
    expect(optional).toBeDefined();

    const after = await planFor(applyAnswers(state, { [optional!.id]: NO_PREFERENCE }));
    expect(after.plan.optional.map((item) => item.id)).not.toContain(optional!.id);
  });

  it('counts an attempt only when an answer failed to settle the question', () => {
    const attempts = countAttempts({}, ['service.0.vehicleClass', 'service.0.passengers'], [
      'service.0.vehicleClass',
    ]);

    expect(attempts).toEqual({ 'service.0.vehicleClass': 1 });
  });
});

describe('entities come from the database, never from the model', () => {
  it('offers the real airports behind an ambiguous name and resolves the chosen row', async () => {
    // The seed carries one Miami field, so "Miami" resolves cleanly. A second one is added
    // here to create the ambiguity deliberately, rather than relying on the seed happening
    // to contain a token that is ambiguous today and might not be tomorrow.
    await getDb()
      .insert(airports)
      .values([
        {
          icao: 'KMIA',
          iata: 'MIA',
          name: 'Miami International Airport',
          city: 'Miami',
          stateRegion: 'Florida',
          countryCode: 'US',
          latitude: '25.795900',
          longitude: '-80.287000',
          timezoneIana: 'America/New_York',
        },
        {
          icao: 'KTMB',
          iata: 'TMB',
          name: 'Miami Executive Airport',
          city: 'Miami',
          stateRegion: 'Florida',
          countryCode: 'US',
          latitude: '25.647900',
          longitude: '-80.432800',
          timezoneIana: 'America/New_York',
        },
      ]);

    const state = await draftFor([{ token: 'cars', code: 'ground_transport', quantity: 1 }], {
      airportToken: 'Miami',
    });

    const { plan } = await planFor(state);
    const question = plan.blocking.find((item) => item.id === 'trip.airport');

    expect(question?.control.kind).toBe('entity');
    const options = question?.control.kind === 'entity' ? question.control.options : [];
    expect(options.length).toBeGreaterThan(1);

    // Every option is a row that exists.
    const db = getDb();
    for (const option of options) {
      const [row] = await db.select().from(airports).where(eq(airports.id, option.value)).limit(1);
      expect(row, `${option.label} is not an airport in the registry`).toBeDefined();
      expect(row!.active).toBe(true);
      expect(option.label).toContain(row!.name);
    }

    const chosen = options[0];
    const resolved = await planFor(applyAnswers(state, { 'trip.airport': chosen!.value }));
    expect(resolved.draft.airport?.id).toBe(chosen!.value);
  });

  it('refuses an airport id that is not a row, and simply asks again', async () => {
    const state = await draftFor([
      {
        token: 'cars',
        code: 'ground_transport',
        quantity: 1,
        requirements: { vehicleClass: 'suv', passengers: 4 },
      },
    ]);

    const invented = await planFor(
      applyAnswers(state, { 'trip.airport': '00000000-0000-4000-8000-000000000000' }),
    );

    expect(invented.draft.airport).toBeNull();
    expect(invented.plan.blocking.map((item) => item.id)).toContain('trip.airport');
    expect(invented.dispatchable).toBe(false);
  });

  it('will not take a handler that belongs to a different airport', async () => {
    const db = getDb();
    const [teterboro] = await db.select().from(airports).where(eq(airports.icao, 'KTEB')).limit(1);
    const elsewhere = await db.select().from(fbos);
    const foreign = elsewhere.find((fbo) => fbo.airportId !== teterboro!.id);
    expect(foreign, 'the seed needs a handler at another field for this test').toBeDefined();

    const state = await draftFor([
      {
        token: 'cars',
        code: 'ground_transport',
        quantity: 1,
        requirements: { vehicleClass: 'suv', passengers: 4 },
      },
    ]);

    const result = await planFor(applyAnswers(state, { 'trip.fbo': foreign!.id }));
    expect(result.draft.fbo).toBeNull();
  });
});

describe('creation is blocked until the catalogue is satisfied', () => {
  it('refuses a request whose service line is missing a required field', async () => {
    const db = getDb();
    const [teterboro] = await db.select().from(airports).where(eq(airports.icao, 'KTEB')).limit(1);
    const [ground] = await db
      .select()
      .from(serviceCategories)
      .where(eq(serviceCategories.code, 'ground_transport'))
      .limit(1);

    const error = await captureError(() =>
      createRequest({
        clientOrganizationId: fixture.clientOrganizationId,
        createdByUserId: fixture.userId,
        createdVia: 'client',
        sourceSentence: 'Landing at Teterboro Friday at 03:00, two cars.',
        airportId: teterboro!.id,
        fboId: null,
        aircraftId: null,
        arrivalUtc: new Date('2026-09-18T07:00:00.000Z'),
        departureUtc: null,
        passengerCount: 4,
        crewCount: 2,
        lines: [{ serviceCategoryId: ground!.id, quantity: 2, requirements: {} }],
      }),
    );

    expect(error.message).toContain('Ground transport');
  });

  it('creates it once those fields are answered', async () => {
    const db = getDb();
    const [teterboro] = await db.select().from(airports).where(eq(airports.icao, 'KTEB')).limit(1);
    const [ground] = await db
      .select()
      .from(serviceCategories)
      .where(eq(serviceCategories.code, 'ground_transport'))
      .limit(1);

    const created = await createRequest({
      clientOrganizationId: fixture.clientOrganizationId,
      createdByUserId: fixture.userId,
      createdVia: 'client',
      sourceSentence: 'Landing at Teterboro Friday at 03:00, two cars.',
      airportId: teterboro!.id,
      fboId: null,
      aircraftId: null,
      arrivalUtc: new Date('2026-09-18T07:00:00.000Z'),
      departureUtc: null,
      passengerCount: 4,
      crewCount: 2,
      lines: [
        {
          serviceCategoryId: ground!.id,
          quantity: 2,
          requirements: { vehicleClass: 'suv', passengers: 4 },
        },
      ],
    });

    expect(created.request.reference).toMatch(/^RQ-/);
    expect(created.lineIds).toHaveLength(1);
    // The sentence is stored exactly as the client wrote it.
    expect(created.request.sourceSentence).toBe('Landing at Teterboro Friday at 03:00, two cars.');
  });
});

describe('a service configured after the build', () => {
  it('is clarified by the same engine, with no code written for it', async () => {
    const db = getDb();

    // Exactly what Admin's "add a service" does: a row, no migration, no component.
    await db.insert(serviceCategories).values({
      code: 'aircraft_cleaning',
      name: 'Aircraft cleaning',
      description: 'Interior and exterior cleaning between legs.',
      unitLabel: 'clean',
      assignmentStrategy: 'generic',
      sortOrder: 70,
      configSchemaJson: {
        fields: [
          { key: 'cleaningLevel', label: 'Cleaning level', type: 'enum', required: true, options: ['exterior', 'interior', 'deep'] },
          { key: 'readyBy', label: 'Ready-by time', type: 'string', required: true },
          { key: 'notes', label: 'Notes', type: 'text', required: false },
        ],
      },
    });

    const categories = await listActiveServiceCategories();
    fixture = { ...fixture, categories };

    const state = await draftFor([{ token: 'cleaning', code: 'aircraft_cleaning', quantity: 1 }]);
    const { plan, dispatchable } = await planFor(state);

    expect(plan.blocking.map((item) => item.question)).toEqual([
      'Which cleaning level?',
      'Ready-by time?',
    ]);
    expect(plan.optional.map((item) => item.question)).toEqual(['Notes?']);
    expect(dispatchable).toBe(false);

    const answered = await planFor(
      applyAnswers(state, {
        'service.0.cleaningLevel': 'deep',
        'service.0.readyBy': '14:00',
      }),
    );

    expect(answered.plan.blocking).toEqual([]);
    expect(answered.dispatchable).toBe(true);
  });
});
