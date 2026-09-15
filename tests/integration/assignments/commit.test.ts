import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  assignmentResources,
  assignments,
  clientOrganizations,
  drivers,
  providerCompanies,
  requestServiceLines,
  requests,
  serviceCategories,
  users,
  vehicles,
} from '@/db/schema';
import { createRequest } from '@/domain/requests/create';
import { acknowledgeOffer, dispatchNextOffer } from '@/services/offers';
import { createAssignment, releaseAssignment } from '@/services/assignments';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import { ensureMigrated, truncateAll } from '../../helpers/database';

/**
 * Committing concrete resources (CLAUDE.md §11, Journey A steps 9-10).
 *
 * The point of these tests is that the application does NOT enforce the no-double-booking
 * rule — the database does. Every assertion below goes through the real service, which
 * inserts and lets the exclusion constraint refuse. If someone later "optimises" by
 * pre-checking in application code and dropping the constraint, these still pass but the
 * concurrency test does not.
 */

interface Fixture {
  readonly clientId: string;
  readonly ktebId: string;
  readonly groundTransportId: string;
}

let fixture: Fixture;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  await runSeed();
  fixture = await readFixture();
  setAiAdapterForTests(undefined);
});

const ARRIVAL = new Date('2026-09-18T07:00:00.000Z');
const NOW = new Date(ARRIVAL.getTime() - 12 * 3_600_000);

/** Creates a request, dispatches an offer and acknowledges it. */
async function acknowledgedLine() {
  const created = await createRequest({
    clientOrganizationId: fixture.clientId,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'Two cars at Teterboro.',
    airportId: fixture.ktebId,
    fboId: null,
    aircraftId: null,
    arrivalUtc: ARRIVAL,
    departureUtc: null,
    passengerCount: 4,
    crewCount: 2,
    lines: [
      {
        serviceCategoryId: fixture.groundTransportId,
        quantity: 2,
        requirements: { vehicleClass: 'suv', passengers: 4 },
      },
    ],
  });

  const lineId = created.lineIds[0]!;
  const offer = (await dispatchNextOffer(lineId, { evaluationNow: NOW })).offer!;

  const [user] = await getDb()
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.providerCompanyId, offer.providerCompanyId))
    .limit(1);

  await acknowledgeOffer({
    offerId: offer.id,
    actorUserId: user!.id,
    actorRole: user!.role,
    actorLabel: user!.email,
    providerCompanyId: offer.providerCompanyId,
    now: NOW,
  });

  const fleet = await getDb()
    .select({ id: vehicles.id, plate: vehicles.plateReference })
    .from(vehicles)
    .where(and(eq(vehicles.providerCompanyId, offer.providerCompanyId), eq(vehicles.active, true)))
    .orderBy(vehicles.plateReference);

  const crew = await getDb()
    .select({ id: drivers.id, name: drivers.fullName })
    .from(drivers)
    .where(and(eq(drivers.providerCompanyId, offer.providerCompanyId), eq(drivers.active, true)))
    .orderBy(drivers.fullName);

  return {
    requestId: created.request.id,
    lineId,
    providerCompanyId: offer.providerCompanyId,
    actor: { id: user!.id, email: user!.email, role: user!.role },
    fleet,
    crew,
  };
}

describe('committing resources', () => {
  it('assigns two vehicles and two drivers and moves the line to assigned', async () => {
    const context = await acknowledgedLine();

    const result = await createAssignment({
      requestServiceLineId: context.lineId,
      providerCompanyId: context.providerCompanyId,
      actorUserId: context.actor.id,
      actorRole: context.actor.role,
      actorLabel: context.actor.email,
      startUtc: ARRIVAL,
      endUtc: new Date(ARRIVAL.getTime() + 3 * 3_600_000),
      resources: [
        { kind: 'vehicle', resourceId: context.fleet[0]!.id },
        { kind: 'vehicle', resourceId: context.fleet[1]!.id },
        { kind: 'driver', resourceId: context.crew[0]!.id },
        { kind: 'driver', resourceId: context.crew[1]!.id },
      ],
    });

    expect(result.committed).toBe(4);
    expect(result.assignment.status).toBe('confirmed');

    const [line] = await getDb()
      .select({ status: requestServiceLines.status })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, context.lineId));
    expect(line?.status).toBe('assigned');

    const [request] = await getDb()
      .select({ status: requests.status })
      .from(requests)
      .where(eq(requests.id, context.requestId));
    expect(request?.status).toBe('confirmed');
  });

  it('refuses to assign before the line is acknowledged', async () => {
    const created = await createRequest({
      clientOrganizationId: fixture.clientId,
      createdByUserId: null,
      createdVia: 'ops',
      sourceSentence: 'Two cars.',
      airportId: fixture.ktebId,
      fboId: null,
      aircraftId: null,
      arrivalUtc: ARRIVAL,
      departureUtc: null,
      passengerCount: 4,
      crewCount: 2,
      lines: [
        { serviceCategoryId: fixture.groundTransportId, quantity: 1, requirements: { vehicleClass: 'suv', passengers: 4 } },
      ],
    });

    const offer = (await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW })).offer!;
    const [vehicle] = await getDb()
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(eq(vehicles.providerCompanyId, offer.providerCompanyId))
      .limit(1);

    await expect(
      createAssignment({
        requestServiceLineId: created.lineIds[0]!,
        providerCompanyId: offer.providerCompanyId,
        actorUserId: '00000000-0000-0000-0000-000000000000',
        actorRole: 'provider_dispatcher',
        actorLabel: 'test',
        startUtc: ARRIVAL,
        endUtc: new Date(ARRIVAL.getTime() + 3_600_000),
        resources: [{ kind: 'vehicle', resourceId: vehicle!.id }],
      }),
    ).rejects.toThrow(/not been acknowledged/);
  });

  it('refuses a provider assigning against another company’s line — Journey G', async () => {
    const context = await acknowledgedLine();

    const [other] = await getDb()
      .select({ id: providerCompanies.id })
      .from(providerCompanies)
      .where(eq(providerCompanies.slug, 'palisade-chauffeur-group'));

    await expect(
      createAssignment({
        requestServiceLineId: context.lineId,
        providerCompanyId: other!.id,
        actorUserId: context.actor.id,
        actorRole: 'provider_dispatcher',
        actorLabel: 'intruder',
        startUtc: ARRIVAL,
        endUtc: new Date(ARRIVAL.getTime() + 3_600_000),
        resources: [{ kind: 'vehicle', resourceId: context.fleet[0]!.id }],
      }),
    ).rejects.toThrow(/another company/);
  });
});

describe('the database refuses a double-booking', () => {
  it('rejects a second commitment of the same vehicle in an overlapping window', async () => {
    const context = await acknowledgedLine();
    const vehicleId = context.fleet[0]!.id;

    await createAssignment({
      requestServiceLineId: context.lineId,
      providerCompanyId: context.providerCompanyId,
      actorUserId: context.actor.id,
      actorRole: context.actor.role,
      actorLabel: context.actor.email,
      startUtc: ARRIVAL,
      endUtc: new Date(ARRIVAL.getTime() + 3 * 3_600_000),
      resources: [{ kind: 'vehicle', resourceId: vehicleId }],
    });

    // A second request wanting the same car an hour into the first job.
    const second = await acknowledgedLineOnAnotherRequest(context.providerCompanyId);

    await expect(
      createAssignment({
        requestServiceLineId: second.lineId,
        providerCompanyId: context.providerCompanyId,
        actorUserId: context.actor.id,
        actorRole: context.actor.role,
        actorLabel: context.actor.email,
        startUtc: new Date(ARRIVAL.getTime() + 3_600_000),
        endUtc: new Date(ARRIVAL.getTime() + 4 * 3_600_000),
        resources: [{ kind: 'vehicle', resourceId: vehicleId }],
      }),
    ).rejects.toThrow(/already committed/);
  });

  it('names the conflicting window and request in the message', async () => {
    const context = await acknowledgedLine();
    const vehicleId = context.fleet[0]!.id;

    await createAssignment({
      requestServiceLineId: context.lineId,
      providerCompanyId: context.providerCompanyId,
      actorUserId: context.actor.id,
      actorRole: context.actor.role,
      actorLabel: context.actor.email,
      startUtc: ARRIVAL,
      endUtc: new Date(ARRIVAL.getTime() + 3 * 3_600_000),
      resources: [{ kind: 'vehicle', resourceId: vehicleId }],
    });

    const second = await acknowledgedLineOnAnotherRequest(context.providerCompanyId);

    try {
      await createAssignment({
        requestServiceLineId: second.lineId,
        providerCompanyId: context.providerCompanyId,
        actorUserId: context.actor.id,
        actorRole: context.actor.role,
        actorLabel: context.actor.email,
        startUtc: new Date(ARRIVAL.getTime() + 3_600_000),
        endUtc: new Date(ARRIVAL.getTime() + 4 * 3_600_000),
        resources: [{ kind: 'vehicle', resourceId: vehicleId }],
      });
      expect.unreachable('the constraint should have refused this');
    } catch (error) {
      const message = String(error);
      // A dispatcher needs to know WHEN and on WHAT, not a SQLSTATE.
      expect(message).toMatch(/07:00 to 10:00 UTC/);
      expect(message).toMatch(/RQ-/);
    }
  });

  it('allows a back-to-back handover at the exact boundary', async () => {
    const context = await acknowledgedLine();
    const vehicleId = context.fleet[0]!.id;

    await createAssignment({
      requestServiceLineId: context.lineId,
      providerCompanyId: context.providerCompanyId,
      actorUserId: context.actor.id,
      actorRole: context.actor.role,
      actorLabel: context.actor.email,
      startUtc: ARRIVAL,
      endUtc: new Date(ARRIVAL.getTime() + 3 * 3_600_000),
      resources: [{ kind: 'vehicle', resourceId: vehicleId }],
    });

    const second = await acknowledgedLineOnAnotherRequest(context.providerCompanyId);

    // Finishing at 10:00 and starting again at 10:00 is legitimate.
    await expect(
      createAssignment({
        requestServiceLineId: second.lineId,
        providerCompanyId: context.providerCompanyId,
        actorUserId: context.actor.id,
        actorRole: context.actor.role,
        actorLabel: context.actor.email,
        startUtc: new Date(ARRIVAL.getTime() + 3 * 3_600_000),
        endUtc: new Date(ARRIVAL.getTime() + 5 * 3_600_000),
        resources: [{ kind: 'vehicle', resourceId: vehicleId }],
      }),
    ).resolves.toBeDefined();
  });

  it('rejects an overlapping commitment of the same driver', async () => {
    const context = await acknowledgedLine();
    const driverId = context.crew[0]!.id;

    await createAssignment({
      requestServiceLineId: context.lineId,
      providerCompanyId: context.providerCompanyId,
      actorUserId: context.actor.id,
      actorRole: context.actor.role,
      actorLabel: context.actor.email,
      startUtc: ARRIVAL,
      endUtc: new Date(ARRIVAL.getTime() + 3 * 3_600_000),
      resources: [{ kind: 'driver', resourceId: driverId }],
    });

    const second = await acknowledgedLineOnAnotherRequest(context.providerCompanyId);

    await expect(
      createAssignment({
        requestServiceLineId: second.lineId,
        providerCompanyId: context.providerCompanyId,
        actorUserId: context.actor.id,
        actorRole: context.actor.role,
        actorLabel: context.actor.email,
        startUtc: new Date(ARRIVAL.getTime() + 3_600_000),
        endUtc: new Date(ARRIVAL.getTime() + 2 * 3_600_000),
        resources: [{ kind: 'driver', resourceId: driverId }],
      }),
    ).rejects.toThrow(/driver is already committed/);
  });

  it('leaves nothing behind when one resource in a batch conflicts', async () => {
    const context = await acknowledgedLine();

    await createAssignment({
      requestServiceLineId: context.lineId,
      providerCompanyId: context.providerCompanyId,
      actorUserId: context.actor.id,
      actorRole: context.actor.role,
      actorLabel: context.actor.email,
      startUtc: ARRIVAL,
      endUtc: new Date(ARRIVAL.getTime() + 3 * 3_600_000),
      resources: [{ kind: 'vehicle', resourceId: context.fleet[0]!.id }],
    });

    const second = await acknowledgedLineOnAnotherRequest(context.providerCompanyId);
    const before = await getDb().select({ id: assignments.id }).from(assignments);

    // The first vehicle is free, the second is the one already committed.
    await expect(
      createAssignment({
        requestServiceLineId: second.lineId,
        providerCompanyId: context.providerCompanyId,
        actorUserId: context.actor.id,
        actorRole: context.actor.role,
        actorLabel: context.actor.email,
        startUtc: new Date(ARRIVAL.getTime() + 3_600_000),
        endUtc: new Date(ARRIVAL.getTime() + 2 * 3_600_000),
        resources: [
          { kind: 'vehicle', resourceId: context.fleet[1]!.id },
          { kind: 'vehicle', resourceId: context.fleet[0]!.id },
        ],
      }),
    ).rejects.toThrow();

    // The whole assignment rolled back: no half-committed vehicle survives.
    const after = await getDb().select({ id: assignments.id }).from(assignments);
    expect(after.length).toBe(before.length);

    const stray = await getDb()
      .select({ id: assignmentResources.id })
      .from(assignmentResources)
      .where(eq(assignmentResources.vehicleId, context.fleet[1]!.id));
    expect(stray).toEqual([]);
  });
});

describe('releasing an assignment', () => {
  it('frees the resource and returns the line to acknowledged', async () => {
    const context = await acknowledgedLine();
    const vehicleId = context.fleet[0]!.id;

    const created = await createAssignment({
      requestServiceLineId: context.lineId,
      providerCompanyId: context.providerCompanyId,
      actorUserId: context.actor.id,
      actorRole: context.actor.role,
      actorLabel: context.actor.email,
      startUtc: ARRIVAL,
      endUtc: new Date(ARRIVAL.getTime() + 3 * 3_600_000),
      resources: [{ kind: 'vehicle', resourceId: vehicleId }],
    });

    await releaseAssignment({
      assignmentId: created.assignment.id,
      providerCompanyId: context.providerCompanyId,
      actorUserId: context.actor.id,
      actorRole: context.actor.role,
      actorLabel: context.actor.email,
      reason: 'Vehicle taken off the road for a warning light.',
    });

    const [line] = await getDb()
      .select({ status: requestServiceLines.status })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, context.lineId));
    // The provider is still committed — only the concrete resources were given back.
    expect(line?.status).toBe('acknowledged');

    // The row survives for the audit trail, marked released.
    const rows = await getDb()
      .select({ released: assignmentResources.released })
      .from(assignmentResources)
      .where(eq(assignmentResources.vehicleId, vehicleId));
    expect(rows[0]?.released).toBe(true);

    // And the vehicle is immediately free again.
    const second = await acknowledgedLineOnAnotherRequest(context.providerCompanyId);
    await expect(
      createAssignment({
        requestServiceLineId: second.lineId,
        providerCompanyId: context.providerCompanyId,
        actorUserId: context.actor.id,
        actorRole: context.actor.role,
        actorLabel: context.actor.email,
        startUtc: ARRIVAL,
        endUtc: new Date(ARRIVAL.getTime() + 2 * 3_600_000),
        resources: [{ kind: 'vehicle', resourceId: vehicleId }],
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a release with no reason', async () => {
    const context = await acknowledgedLine();
    const created = await createAssignment({
      requestServiceLineId: context.lineId,
      providerCompanyId: context.providerCompanyId,
      actorUserId: context.actor.id,
      actorRole: context.actor.role,
      actorLabel: context.actor.email,
      startUtc: ARRIVAL,
      endUtc: new Date(ARRIVAL.getTime() + 3_600_000),
      resources: [{ kind: 'vehicle', resourceId: context.fleet[0]!.id }],
    });

    await expect(
      releaseAssignment({
        assignmentId: created.assignment.id,
        providerCompanyId: context.providerCompanyId,
        actorUserId: context.actor.id,
        actorRole: context.actor.role,
        actorLabel: context.actor.email,
        reason: ' ',
      }),
    ).rejects.toThrow(/requires a reason/);
  });
});

/**
 * A second acknowledged line at the SAME provider.
 *
 * Built directly rather than through the waterfall on purpose: these tests are about the
 * exclusion constraint, and routing the setup through matching would make them fail for
 * an unrelated and legitimate reason — a later window can fall outside the night shift,
 * so no provider is eligible and there is no second line to conflict with.
 */
async function acknowledgedLineOnAnotherRequest(providerCompanyId: string) {
  const db = getDb();

  const created = await createRequest({
    clientOrganizationId: fixture.clientId,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'One more car later the same morning.',
    airportId: fixture.ktebId,
    fboId: null,
    aircraftId: null,
    arrivalUtc: new Date(ARRIVAL.getTime() + 3_600_000),
    departureUtc: null,
    passengerCount: 2,
    crewCount: 2,
    lines: [
      {
        serviceCategoryId: fixture.groundTransportId,
        quantity: 1,
        requirements: { vehicleClass: 'suv', passengers: 2 },
      },
    ],
  });

  const lineId = created.lineIds[0]!;
  const { sql } = await import('drizzle-orm');

  await db.execute(sql`
    insert into provider_offers
      (request_service_line_id, provider_company_id, attempt_number, rank_at_selection,
       eligibility_snapshot, expires_at, status, acknowledged_at)
    values (${lineId}::uuid, ${providerCompanyId}::uuid, 1, 100,
            '{"candidates":[],"engineVersion":"test"}'::jsonb,
            now() + interval '45 minutes', 'acknowledged', now())
  `);

  await db.execute(sql`
    update request_service_lines set status = 'acknowledged' where id = ${lineId}::uuid
  `);

  return { lineId };
}

async function readFixture(): Promise<Fixture> {
  const db = getDb();
  const [client] = await db
    .select({ id: clientOrganizations.id })
    .from(clientOrganizations)
    .where(eq(clientOrganizations.slug, 'meridian-capital-partners'));
  const [kteb] = await db.select({ id: airports.id }).from(airports).where(eq(airports.icao, 'KTEB'));
  const [ground] = await db
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(eq(serviceCategories.code, 'ground_transport'));

  if (client === undefined || kteb === undefined || ground === undefined) {
    throw new Error('seeded fixture incomplete');
  }
  return { clientId: client.id, ktebId: kteb.id, groundTransportId: ground.id };
}
