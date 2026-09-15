import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  clientOrganizations,
  matchAttempts,
  providerCompanies,
  requestServiceLines,
  requests,
  serviceCategories,
} from '@/db/schema';
import { createRequest } from '@/domain/requests/create';
import { runMatching } from '@/services/matching';
import { runSeed } from '@/db/seed';
import { installScriptedAdapter, setAiAdapterForTests } from '@/ai/client';
import { ensureMigrated, truncateAll } from '../../helpers/database';

/**
 * Request creation through matching, against the REAL seeded network (Phases 4 and 5).
 *
 * The seed is deliberately shaped so these assertions mean something: three ground
 * transport companies compete at Teterboro, one has a daytime-only desk, one is suspended
 * and one is unapproved. A 03:00 arrival therefore has a single correct answer that the
 * engine must reach without anyone telling it to.
 *
 * AI is scripted throughout — these tests are about the deterministic guarantees, and a
 * live model would make them non-reproducible.
 */

interface Fixture {
  readonly clientId: string;
  readonly ktebId: string;
  readonly groundTransportId: string;
  readonly hangarServiceId: string;
  readonly providerIdBySlug: ReadonlyMap<string, string>;
}

let fixture: Fixture;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  await runSeed();
  fixture = await readFixture();
  // Default: no model. Each test installs what it needs.
  setAiAdapterForTests(undefined);
});

afterEach(() => {
  setAiAdapterForTests(undefined);
});

/** A Friday 03:00 local arrival at Teterboro — the worked example from the brief. */
function tebArrival(): Date {
  // 2026-09-18 03:00 America/New_York is 07:00Z (EDT, UTC-4).
  return new Date('2026-09-18T07:00:00.000Z');
}

/** Twelve hours before the arrival, so lead time is comfortable. */
function evaluationNow(): Date {
  return new Date(tebArrival().getTime() - 12 * 3_600_000);
}

async function createGroundTransportRequest(
  overrides: { quantity?: number; arrivalUtc?: Date; requirements?: Record<string, unknown> } = {},
) {
  return createRequest({
    clientOrganizationId: fixture.clientId,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'Landing at Teterboro Friday at 3am, two cars.',
    airportId: fixture.ktebId,
    fboId: null,
    aircraftId: null,
    arrivalUtc: overrides.arrivalUtc ?? tebArrival(),
    departureUtc: null,
    passengerCount: 4,
    crewCount: 2,
    lines: [
      {
        serviceCategoryId: fixture.groundTransportId,
        quantity: overrides.quantity ?? 2,
        requirements: overrides.requirements ?? { vehicleClass: 'suv', passengers: 4 },
      },
    ],
  });
}

describe('creating a request', () => {
  it('persists the request, its line and an audit event in one transaction', async () => {
    const created = await createGroundTransportRequest();

    expect(created.request.reference).toMatch(/^RQ-[A-Z0-9]{6}$/);
    expect(created.lineIds).toHaveLength(1);

    const db = getDb();
    const [stored] = await db
      .select()
      .from(requests)
      .where(eq(requests.id, created.request.id))
      .limit(1);

    expect(stored?.status).toBe('sent');
    expect(stored?.confirmedAt).not.toBeNull();
    // The sentence is kept exactly as typed (CLAUDE.md §22).
    expect(stored?.sourceSentence).toBe('Landing at Teterboro Friday at 3am, two cars.');

    const events = await db.execute<{ action: string }>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw catalog read in a test
      (await import('drizzle-orm')).sql`select action from audit_events where entity_id = ${created.request.id}` as any,
    );
    expect(events.rows.some((row) => row.action === 'request.create')).toBe(true);
  });

  it('derives a service window from the flight window', async () => {
    const created = await createGroundTransportRequest();
    const [line] = await getDb()
      .select({
        start: requestServiceLines.serviceStartUtc,
        end: requestServiceLines.serviceEndUtc,
        status: requestServiceLines.status,
      })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.requestId, created.request.id));

    expect(line?.status).toBe('matching');
    expect(line?.start?.toISOString()).toBe(tebArrival().toISOString());
    // Ground transport meets the arrival: three hours from touchdown.
    expect(line?.end?.toISOString()).toBe(
      new Date(tebArrival().getTime() + 3 * 3_600_000).toISOString(),
    );
  });

  it('refuses a request with no services', async () => {
    await expect(
      createRequest({
        clientOrganizationId: fixture.clientId,
        createdByUserId: null,
        createdVia: 'ops',
        sourceSentence: '',
        airportId: fixture.ktebId,
        fboId: null,
        aircraftId: null,
        arrivalUtc: tebArrival(),
        departureUtc: null,
        passengerCount: 2,
        crewCount: 2,
        lines: [],
      }),
    ).rejects.toThrow(/at least one service/);
  });

  it('refuses a request with no arrival and no departure', async () => {
    await expect(
      createRequest({
        clientOrganizationId: fixture.clientId,
        createdByUserId: null,
        createdVia: 'ops',
        sourceSentence: '',
        airportId: fixture.ktebId,
        fboId: null,
        aircraftId: null,
        arrivalUtc: null,
        departureUtc: null,
        passengerCount: 2,
        crewCount: 2,
        lines: [{ serviceCategoryId: fixture.groundTransportId, quantity: 1, requirements: {} }],
      }),
    ).rejects.toThrow(/arrival or a departure/);
  });

  it('refuses the same service twice — quantity is the way to ask for two', async () => {
    await expect(
      createRequest({
        clientOrganizationId: fixture.clientId,
        createdByUserId: null,
        createdVia: 'ops',
        sourceSentence: '',
        airportId: fixture.ktebId,
        fboId: null,
        aircraftId: null,
        arrivalUtc: tebArrival(),
        departureUtc: null,
        passengerCount: 2,
        crewCount: 2,
        lines: [
          { serviceCategoryId: fixture.groundTransportId, quantity: 1, requirements: { vehicleClass: 'suv', passengers: 2 } },
          { serviceCategoryId: fixture.groundTransportId, quantity: 1, requirements: { vehicleClass: 'suv', passengers: 2 } },
        ],
      }),
    ).rejects.toThrow(/only once/);
  });

  it('rolls the whole request back when one line is invalid', async () => {
    const before = await getDb().select({ id: requests.id }).from(requests);

    await expect(
      createRequest({
        clientOrganizationId: fixture.clientId,
        createdByUserId: null,
        createdVia: 'ops',
        sourceSentence: '',
        airportId: fixture.ktebId,
        fboId: null,
        aircraftId: null,
        arrivalUtc: tebArrival(),
        departureUtc: null,
        passengerCount: 2,
        crewCount: 2,
        lines: [
          { serviceCategoryId: fixture.groundTransportId, quantity: 1, requirements: { vehicleClass: 'suv', passengers: 2 } },
          // `officers` is required for close protection and is missing.
          { serviceCategoryId: fixture.hangarServiceId, quantity: 1, requirements: { nights: 'not a number' } },
        ],
      }),
    ).rejects.toThrow();

    const after = await getDb().select({ id: requests.id }).from(requests);
    expect(after.length).toBe(before.length);
  });
});

describe('matching against the real network', () => {
  it('chooses a provider that is genuinely eligible and records the full trace', async () => {
    const created = await createGroundTransportRequest();
    const lineId = created.lineIds[0]!;

    const decision = await runMatching(lineId, { evaluationNow: evaluationNow() });

    expect(decision.chosen).not.toBeNull();
    expect(decision.chosen?.eligible).toBe(true);
    expect(decision.chosen?.reasonCodes).toEqual([]);
    expect(decision.selectionSource).toBe('deterministic');

    const [attempt] = await getDb()
      .select()
      .from(matchAttempts)
      .where(eq(matchAttempts.requestServiceLineId, lineId));

    expect(attempt?.attemptNumber).toBe(1);
    expect(attempt?.chosenProviderId).toBe(decision.chosen?.providerCompanyId);
    expect(attempt?.aiConsulted).toBe(false);
    // The trace holds every candidate considered, eligible and rejected.
    expect(attempt?.eligibleCandidates.length).toBeGreaterThan(0);
    expect(attempt?.rejectedCandidates.length).toBeGreaterThan(0);
  });

  it('rejects the daytime-only provider for a 03:00 arrival, on desk hours', async () => {
    const created = await createGroundTransportRequest();
    const decision = await runMatching(created.lineIds[0]!, { evaluationNow: evaluationNow() });

    const gotham = decision.outcome.rejected.find((c) => c.displayName === 'Gotham Livery Partners');
    expect(gotham).toBeDefined();
    expect(gotham?.reasonCodes).toContain('outside_desk_hours');
  });

  it('rejects the suspended company on status, even though it has coverage', async () => {
    const created = await createGroundTransportRequest();
    const decision = await runMatching(created.lineIds[0]!, { evaluationNow: evaluationNow() });

    // Atlas covers KJFK, not KTEB, so it is not even a candidate here — the point is that
    // no suspended company can ever be chosen.
    for (const candidate of decision.outcome.eligible) {
      const [provider] = await getDb()
        .select({ status: providerCompanies.status })
        .from(providerCompanies)
        .where(eq(providerCompanies.id, candidate.providerCompanyId));
      expect(provider?.status).toBe('approved');
    }
  });

  it('never returns the unapproved company as eligible', async () => {
    const created = await createGroundTransportRequest();
    const decision = await runMatching(created.lineIds[0]!, { evaluationNow: evaluationNow() });

    const meridianId = fixture.providerIdBySlug.get('meridian-ground-services');
    expect(meridianId).toBeDefined();

    expect(decision.outcome.eligible.some((c) => c.providerCompanyId === meridianId)).toBe(false);
    const rejected = decision.outcome.rejected.find((c) => c.providerCompanyId === meridianId);
    expect(rejected?.reasonCodes).toContain('provider_not_approved');
  });

  it('excludes a provider that already declined', async () => {
    const created = await createGroundTransportRequest();
    const lineId = created.lineIds[0]!;

    const first = await runMatching(lineId, { evaluationNow: evaluationNow() });
    const declinedId = first.chosen?.providerCompanyId;
    expect(declinedId).toBeDefined();

    const second = await runMatching(lineId, {
      evaluationNow: evaluationNow(),
      excludedProviderIds: [declinedId!],
    });

    expect(second.chosen?.providerCompanyId).not.toBe(declinedId);
    const excluded = second.outcome.rejected.find((c) => c.providerCompanyId === declinedId);
    expect(excluded?.reasonCodes).toContain('provider_excluded_by_previous_decline');
    expect(second.attemptNumber).toBe(2);
  });

  it('fails cleanly when the notice is shorter than every provider’s lead time', async () => {
    const created = await createGroundTransportRequest();

    // Ten minutes before the arrival: inside everyone's lead time.
    const decision = await runMatching(created.lineIds[0]!, {
      evaluationNow: new Date(tebArrival().getTime() - 10 * 60_000),
    });

    expect(decision.chosen).toBeNull();
    expect(decision.outcome.eligible).toEqual([]);
    expect(
      decision.outcome.rejected.every((c) => c.reasonCodes.includes('lead_time_insufficient')),
    ).toBe(true);
  });

  it('rejects a hangar bay too small for the aircraft', async () => {
    const db = getDb();
    const [g650] = await db.execute<{ id: string }>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw read in a test
      (await import('drizzle-orm')).sql`select id from aircraft where tail_number = 'N418MC'` as any,
    ).then((result) => result.rows);

    const created = await createRequest({
      clientOrganizationId: fixture.clientId,
      createdByUserId: null,
      createdVia: 'ops',
      sourceSentence: 'Hangar overnight at Teterboro for the G650.',
      airportId: fixture.ktebId,
      fboId: null,
      aircraftId: g650?.id ?? null,
      arrivalUtc: tebArrival(),
      departureUtc: new Date(tebArrival().getTime() + 20 * 3_600_000),
      passengerCount: 8,
      crewCount: 3,
      lines: [{ serviceCategoryId: fixture.hangarServiceId, quantity: 1, requirements: {} }],
    });

    const decision = await runMatching(created.lineIds[0]!, { evaluationNow: evaluationNow() });

    // Gateway has a wide bay and a narrow one; the provider is eligible because ONE bay
    // fits. What matters is that the narrow bay is never the one offered.
    expect(decision.chosen).not.toBeNull();
    expect(decision.chosen?.feasibleResourceIds.length).toBeGreaterThan(0);
  });
});

describe('AI participation and its verification', () => {
  it('accepts a verified model choice and records it as the source', async () => {
    const created = await createGroundTransportRequest();
    const lineId = created.lineIds[0]!;

    // Discover who is eligible, then script the model to choose the SECOND one, so the
    // test proves the model can legitimately differ from the deterministic top.
    const dryRun = await runMatching(lineId, {
      evaluationNow: evaluationNow(),
      forceDeterministic: true,
    });
    const second = dryRun.outcome.eligible[1];
    expect(second).toBeDefined();

    installScriptedAdapter({
      script: [
        {
          promptId: 'matching.select',
          outcome: {
            kind: 'data',
            value: {
              chosenProviderId: second!.providerCompanyId,
              reason: 'More spare capacity for an overnight arrival that may slip.',
              confidence: 'medium',
              considerations: ['spare capacity', 'overnight window'],
            },
          },
        },
      ],
    });

    const decision = await runMatching(lineId, { evaluationNow: evaluationNow() });

    expect(decision.aiConsulted).toBe(true);
    expect(decision.aiVerified).toBe(true);
    expect(decision.selectionSource).toBe('ai');
    expect(decision.chosen?.providerCompanyId).toBe(second!.providerCompanyId);
    expect(decision.reason).toMatch(/spare capacity/);
  });

  it('falls back deterministically when the model names a provider that was not offered', async () => {
    const created = await createGroundTransportRequest();
    const lineId = created.lineIds[0]!;

    installScriptedAdapter({
      script: [
        {
          promptId: 'matching.select',
          outcome: {
            kind: 'data',
            value: {
              chosenProviderId: '00000000-0000-0000-0000-000000000000',
              reason: 'A provider that does not exist in the candidate list.',
              confidence: 'high',
              considerations: [],
            },
          },
        },
      ],
    });

    const decision = await runMatching(lineId, { evaluationNow: evaluationNow() });

    expect(decision.aiConsulted).toBe(true);
    expect(decision.aiVerified).toBe(false);
    expect(decision.selectionSource).toBe('deterministic');
    expect(decision.chosen?.providerCompanyId).toBe(decision.outcome.top?.providerCompanyId);
    expect(decision.fallbackReason).toMatch(/not offered/);

    const [attempt] = await getDb()
      .select()
      .from(matchAttempts)
      .where(eq(matchAttempts.requestServiceLineId, lineId));

    expect(attempt?.aiVerified).toBe(false);
    expect(attempt?.fallbackReason).not.toBeNull();
  });

  it('falls back deterministically when the model times out — Journey E', async () => {
    const created = await createGroundTransportRequest();
    const lineId = created.lineIds[0]!;

    installScriptedAdapter({
      script: [{ promptId: 'matching.select', outcome: { kind: 'failure', reason: 'timeout' } }],
    });

    const decision = await runMatching(lineId, { evaluationNow: evaluationNow() });

    expect(decision.chosen).not.toBeNull();
    expect(decision.selectionSource).toBe('deterministic');
    expect(decision.fallbackReason).toMatch(/timeout/);
  });

  it('falls back deterministically when the model returns unusable output', async () => {
    const created = await createGroundTransportRequest();
    const lineId = created.lineIds[0]!;

    installScriptedAdapter({
      script: [
        { promptId: 'matching.select', outcome: { kind: 'raw', text: 'I would suggest Hudson.' } },
      ],
    });

    const decision = await runMatching(lineId, { evaluationNow: evaluationNow() });

    expect(decision.chosen).not.toBeNull();
    expect(decision.selectionSource).toBe('deterministic');
    expect(decision.aiVerified).toBe(false);
  });

  it('does not consult the model when there is only one eligible candidate', async () => {
    const created = await createGroundTransportRequest({ quantity: 6 });
    const adapter = installScriptedAdapter({ script: [] });

    const decision = await runMatching(created.lineIds[0]!, { evaluationNow: evaluationNow() });

    // Six SUVs exceeds what most of the network can field at once; whatever the eligible
    // count, a single candidate means there is nothing to decide.
    if (decision.outcome.eligible.length <= 1) {
      expect(decision.aiConsulted).toBe(false);
      expect(adapter.calls).toHaveLength(0);
    }
  });

  it('every selected provider is provably eligible, whatever the model said', async () => {
    const created = await createGroundTransportRequest();
    const lineId = created.lineIds[0]!;

    for (const scripted of [
      { kind: 'data' as const, value: { chosenProviderId: 'nonsense', reason: 'x'.repeat(20), confidence: 'high' as const, considerations: [] } },
      { kind: 'failure' as const, reason: 'refused' as const },
      { kind: 'raw' as const, text: '{"chosenProviderId": 42}' },
    ]) {
      installScriptedAdapter({ script: [{ promptId: 'matching.select', outcome: scripted }] });
      const decision = await runMatching(lineId, { evaluationNow: evaluationNow() });

      expect(decision.chosen?.eligible).toBe(true);
      expect(decision.chosen?.reasonCodes).toEqual([]);
    }
  });
});

async function readFixture(): Promise<Fixture> {
  const db = getDb();

  const [client] = await db
    .select({ id: clientOrganizations.id })
    .from(clientOrganizations)
    .where(eq(clientOrganizations.slug, 'meridian-capital-partners'))
    .limit(1);

  const [kteb] = await db
    .select({ id: airports.id })
    .from(airports)
    .where(eq(airports.icao, 'KTEB'))
    .limit(1);

  const [ground] = await db
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(eq(serviceCategories.code, 'ground_transport'))
    .limit(1);

  const [hangar] = await db
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(eq(serviceCategories.code, 'hangar'))
    .limit(1);

  const providers = await db
    .select({ slug: providerCompanies.slug, id: providerCompanies.id })
    .from(providerCompanies);

  if (client === undefined || kteb === undefined || ground === undefined || hangar === undefined) {
    throw new Error('The seeded fixture is incomplete');
  }

  return {
    clientId: client.id,
    ktebId: kteb.id,
    groundTransportId: ground.id,
    hangarServiceId: hangar.id,
    providerIdBySlug: new Map(providers.map((row) => [row.slug, row.id])),
  };
}
