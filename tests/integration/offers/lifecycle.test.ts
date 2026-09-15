import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  auditEvents,
  clientOrganizations,
  providerCompanies,
  providerOffers,
  requestServiceLines,
  requests,
  serviceCategories,
  users,
} from '@/db/schema';
import { createRequest } from '@/domain/requests/create';
import {
  acknowledgeOffer,
  declineOffer,
  dispatchNextOffer,
  expireOffer,
  findExpiredOffers,
  rematchLine,
} from '@/services/offers';
import { runExpirySweep } from '@/jobs/workers/register';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import { ensureMigrated, truncateAll } from '../../helpers/database';

/**
 * The offer waterfall against the real database (CLAUDE.md §11, Journeys A, B and C).
 *
 * These are the guarantees the product's credibility rests on: a line has one live offer,
 * a decline moves it on without touching other lines, an expiry re-matches automatically,
 * and running any of it twice changes nothing.
 */

interface Fixture {
  readonly clientId: string;
  readonly ktebId: string;
  readonly groundTransportId: string;
  readonly closeProtectionId: string;
  readonly fuelId: string;
  readonly userIdByEmail: ReadonlyMap<string, { id: string; providerCompanyId: string | null }>;
}

let fixture: Fixture;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  await runSeed();
  fixture = await readFixture();
  // Deterministic throughout: these tests are about the lifecycle, not the model.
  setAiAdapterForTests(undefined);
});

const ARRIVAL = new Date('2026-09-18T07:00:00.000Z');
const NOW = new Date(ARRIVAL.getTime() - 12 * 3_600_000);

async function makeRequest(serviceIds: readonly string[] = []) {
  const ids = serviceIds.length > 0 ? serviceIds : [fixture.groundTransportId];
  return createRequest({
    clientOrganizationId: fixture.clientId,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'Landing at Teterboro Friday at 3am, two cars and three bodyguards.',
    airportId: fixture.ktebId,
    fboId: null,
    aircraftId: null,
    arrivalUtc: ARRIVAL,
    departureUtc: null,
    passengerCount: 4,
    crewCount: 2,
    lines: ids.map((id) => ({
      serviceCategoryId: id,
      quantity: id === fixture.closeProtectionId ? 3 : 2,
      requirements:
        id === fixture.groundTransportId
          ? { vehicleClass: 'suv', passengers: 4 }
          : id === fixture.closeProtectionId
            ? { officers: 3, armed: true }
            : { fuelType: 'jet_a' },
    })),
  });
}

/** The dispatcher account belonging to the company holding an offer. */
async function dispatcherFor(providerCompanyId: string) {
  const [user] = await getDb()
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.providerCompanyId, providerCompanyId))
    .limit(1);

  if (user === undefined) throw new Error('no user for that provider company');
  return user;
}

describe('dispatching an offer', () => {
  it('creates exactly one live offer and sets the acknowledgement deadline', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    const result = await dispatchNextOffer(lineId, { evaluationNow: NOW });

    expect(result.kind).toBe('offered');
    expect(result.offer).not.toBeNull();
    expect(result.offer?.status).toBe('sent');

    const [line] = await getDb()
      .select({
        status: requestServiceLines.status,
        currentOfferId: requestServiceLines.currentOfferId,
        deadline: requestServiceLines.acknowledgementDeadlineUtc,
      })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, lineId));

    expect(line?.status).toBe('offered');
    expect(line?.currentOfferId).toBe(result.offer?.id);
    // The seeded default SLA is 45 minutes.
    expect(line?.deadline?.getTime()).toBe(NOW.getTime() + 45 * 60_000);
  });

  it('writes an audit event naming the provider and the deadline', async () => {
    const created = await makeRequest();
    const result = await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });

    const events = await getDb()
      .select({ action: auditEvents.action, after: auditEvents.afterState })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, result.offer!.id));

    expect(events.some((event) => event.action === 'offer.sent')).toBe(true);
  });

  it('moves the request from sent to sourcing', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });

    const [request] = await getDb()
      .select({ status: requests.status })
      .from(requests)
      .where(eq(requests.id, created.request.id));

    expect(request?.status).toBe('sourcing');
  });

  it('fails the line honestly when nothing is eligible', async () => {
    const created = await makeRequest();
    // Ten minutes' notice: inside every provider's lead time.
    const result = await dispatchNextOffer(created.lineIds[0]!, {
      evaluationNow: new Date(ARRIVAL.getTime() - 10 * 60_000),
    });

    expect(result.kind).toBe('failed');
    expect(result.offer).toBeNull();

    const [line] = await getDb()
      .select({ status: requestServiceLines.status, failureReason: requestServiceLines.failureReason })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, created.lineIds[0]!));

    expect(line?.status).toBe('failed');
    expect(line?.failureReason).toMatch(/lead time|rejected/i);
  });
});

describe('acknowledgement', () => {
  it('accepts the offer and moves the line to acknowledged', async () => {
    const created = await makeRequest();
    const result = await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });
    const offer = result.offer!;
    const user = await dispatcherFor(offer.providerCompanyId);

    const acknowledged = await acknowledgeOffer({
      offerId: offer.id,
      actorUserId: user.id,
      actorRole: user.role,
      actorLabel: user.email,
      providerCompanyId: offer.providerCompanyId,
      now: NOW,
    });

    expect(acknowledged.status).toBe('acknowledged');
    expect(acknowledged.acknowledgedAt).not.toBeNull();

    const [line] = await getDb()
      .select({ status: requestServiceLines.status, deadline: requestServiceLines.acknowledgementDeadlineUtc })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, created.lineIds[0]!));

    expect(line?.status).toBe('acknowledged');
    // The clock stops once they have answered.
    expect(line?.deadline).toBeNull();
  });

  it('is idempotent — acknowledging twice is not an error', async () => {
    const created = await makeRequest();
    const offer = (await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW })).offer!;
    const user = await dispatcherFor(offer.providerCompanyId);

    const input = {
      offerId: offer.id,
      actorUserId: user.id,
      actorRole: user.role,
      actorLabel: user.email,
      providerCompanyId: offer.providerCompanyId,
      now: NOW,
    };

    const first = await acknowledgeOffer(input);
    const second = await acknowledgeOffer(input);

    expect(first.status).toBe('acknowledged');
    expect(second.status).toBe('acknowledged');
    expect(second.acknowledgedAt?.getTime()).toBe(first.acknowledgedAt?.getTime());
  });

  it('refuses a provider from another company — Journey G', async () => {
    const created = await makeRequest();
    const offer = (await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW })).offer!;

    const [otherCompany] = await getDb()
      .select({ id: providerCompanies.id })
      .from(providerCompanies)
      .where(eq(providerCompanies.slug, 'palisade-chauffeur-group'));

    const intruder = await dispatcherFor(otherCompany!.id);

    await expect(
      acknowledgeOffer({
        offerId: offer.id,
        actorUserId: intruder.id,
        actorRole: intruder.role,
        actorLabel: intruder.email,
        providerCompanyId: otherCompany!.id,
        now: NOW,
      }),
    ).rejects.toThrow(/another company/);

    // And the offer is untouched.
    const [unchanged] = await getDb()
      .select({ status: providerOffers.status })
      .from(providerOffers)
      .where(eq(providerOffers.id, offer.id));
    expect(unchanged?.status).toBe('sent');
  });

  it('refuses an offer whose deadline has passed, with a message that is not a blame', async () => {
    const created = await makeRequest();
    const offer = (await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW })).offer!;
    const user = await dispatcherFor(offer.providerCompanyId);

    await expect(
      acknowledgeOffer({
        offerId: offer.id,
        actorUserId: user.id,
        actorRole: user.role,
        actorLabel: user.email,
        providerCompanyId: offer.providerCompanyId,
        now: new Date(offer.expiresAt.getTime() + 60_000),
      }),
    ).rejects.toThrow(/expired and the request has moved/);
  });
});

describe('decline and re-match', () => {
  it('records the reason and frees the line', async () => {
    const created = await makeRequest();
    const offer = (await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW })).offer!;
    const user = await dispatcherFor(offer.providerCompanyId);

    const declined = await declineOffer({
      offerId: offer.id,
      actorUserId: user.id,
      actorRole: user.role,
      actorLabel: user.email,
      providerCompanyId: offer.providerCompanyId,
      now: NOW,
      reason: 'Both night drivers are already committed.',
    });

    expect(declined.status).toBe('declined');
    expect(declined.declineReason).toMatch(/night drivers/);

    const [line] = await getDb()
      .select({ status: requestServiceLines.status, currentOfferId: requestServiceLines.currentOfferId })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, created.lineIds[0]!));

    expect(line?.status).toBe('declined');
    expect(line?.currentOfferId).toBeNull();
  });

  it('refuses a decline with no reason', async () => {
    const created = await makeRequest();
    const offer = (await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW })).offer!;
    const user = await dispatcherFor(offer.providerCompanyId);

    await expect(
      declineOffer({
        offerId: offer.id,
        actorUserId: user.id,
        actorRole: user.role,
        actorLabel: user.email,
        providerCompanyId: offer.providerCompanyId,
        now: NOW,
        reason: '  ',
      }),
    ).rejects.toThrow(/why you cannot cover/);
  });

  it('re-matches to a DIFFERENT provider after a decline', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    const first = (await dispatchNextOffer(lineId, { evaluationNow: NOW })).offer!;
    const user = await dispatcherFor(first.providerCompanyId);

    await declineOffer({
      offerId: first.id,
      actorUserId: user.id,
      actorRole: user.role,
      actorLabel: user.email,
      providerCompanyId: first.providerCompanyId,
      now: NOW,
      reason: 'No vehicles available for that window.',
    });

    const second = await rematchLine(lineId, { evaluationNow: NOW });
    expect('kind' in second && second.kind === 'offered').toBe(true);
    if (!('offer' in second) || second.offer === null) throw new Error('expected a new offer');

    expect(second.offer.providerCompanyId).not.toBe(first.providerCompanyId);
    expect(second.offer.attemptNumber).toBeGreaterThan(first.attemptNumber);

    // Exactly one live offer at any moment.
    const live = await getDb()
      .select({ id: providerOffers.id })
      .from(providerOffers)
      .where(eq(providerOffers.status, 'sent'));
    expect(live).toHaveLength(1);
  });

  it('a decline on one line does not disturb another — Journey B', async () => {
    // Paired with fuel rather than close protection: the seeded officer shifts genuinely
    // cannot cover an 03:00 eight-hour detail, which is asserted separately below.
    const created = await makeRequest([fixture.groundTransportId, fixture.fuelId]);
    const [carLine, guardLine] = created.lineIds;

    const carOffer = (await dispatchNextOffer(carLine!, { evaluationNow: NOW })).offer!;
    const guardOffer = (await dispatchNextOffer(guardLine!, { evaluationNow: NOW })).offer!;

    const user = await dispatcherFor(carOffer.providerCompanyId);
    await declineOffer({
      offerId: carOffer.id,
      actorUserId: user.id,
      actorRole: user.role,
      actorLabel: user.email,
      providerCompanyId: carOffer.providerCompanyId,
      now: NOW,
      reason: 'Fleet fully committed.',
    });

    const [guard] = await getDb()
      .select({ status: requestServiceLines.status, currentOfferId: requestServiceLines.currentOfferId })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, guardLine!));

    expect(guard?.status).toBe('offered');
    expect(guard?.currentOfferId).toBe(guardOffer.id);
  });
});

describe('SLA expiry — Journey C', () => {
  it('expires an offer past its deadline and increments the re-match counter', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;
    const offer = (await dispatchNextOffer(lineId, { evaluationNow: NOW })).offer!;

    const after = new Date(offer.expiresAt.getTime() + 1000);
    const result = await expireOffer(offer.id, after);

    expect(result.expired).toBe(true);

    const [line] = await getDb()
      .select({ status: requestServiceLines.status, rematchCount: requestServiceLines.rematchCount })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, lineId));

    expect(line?.status).toBe('rematching');
    expect(line?.rematchCount).toBe(1);
  });

  it('does nothing when the deadline has not passed', async () => {
    const created = await makeRequest();
    const offer = (await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW })).offer!;

    const result = await expireOffer(offer.id, NOW);
    expect(result.expired).toBe(false);
    expect(result.reason).toBe('not yet due');
  });

  it('is idempotent — expiring twice produces one expiry', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;
    const offer = (await dispatchNextOffer(lineId, { evaluationNow: NOW })).offer!;
    const after = new Date(offer.expiresAt.getTime() + 1000);

    const first = await expireOffer(offer.id, after);
    const second = await expireOffer(offer.id, after);

    expect(first.expired).toBe(true);
    expect(second.expired).toBe(false);
    expect(second.reason).toBe('already expired');

    // The counter moved exactly once — a redelivered job cannot inflate it.
    const [line] = await getDb()
      .select({ rematchCount: requestServiceLines.rematchCount })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, lineId));
    expect(line?.rematchCount).toBe(1);
  });

  it('does not expire an offer the provider answered first', async () => {
    const created = await makeRequest();
    const offer = (await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW })).offer!;
    const user = await dispatcherFor(offer.providerCompanyId);

    await acknowledgeOffer({
      offerId: offer.id,
      actorUserId: user.id,
      actorRole: user.role,
      actorLabel: user.email,
      providerCompanyId: offer.providerCompanyId,
      now: NOW,
    });

    const result = await expireOffer(offer.id, new Date(offer.expiresAt.getTime() + 1000));
    expect(result.expired).toBe(false);
    expect(result.reason).toBe('already acknowledged');

    const [line] = await getDb()
      .select({ status: requestServiceLines.status })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, created.lineIds[0]!));
    expect(line?.status).toBe('acknowledged');
  });

  it('the sweep finds and expires an offer no delayed job handled', async () => {
    const created = await makeRequest();
    const offer = (await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW })).offer!;

    const after = new Date(offer.expiresAt.getTime() + 1000);
    expect(await findExpiredOffers(after)).toHaveLength(1);

    const swept = await runExpirySweep(after);
    expect(swept).toBe(1);

    const [expired] = await getDb()
      .select({ status: providerOffers.status })
      .from(providerOffers)
      .where(eq(providerOffers.id, offer.id));
    expect(expired?.status).toBe('expired');
  });

  it('a re-match after expiry goes to a different provider', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;
    const first = (await dispatchNextOffer(lineId, { evaluationNow: NOW })).offer!;

    await expireOffer(first.id, new Date(first.expiresAt.getTime() + 1000));
    const second = await rematchLine(lineId, { evaluationNow: NOW });

    if (!('offer' in second) || second.offer === null) throw new Error('expected a new offer');
    expect(second.offer.providerCompanyId).not.toBe(first.providerCompanyId);
  });

  it('stops re-matching at the ceiling and fails the line for operations', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    // Drive the waterfall until it runs out of providers or hits the ceiling.
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 12) throw new Error('the waterfall did not terminate');

      const [line] = await getDb()
        .select({ status: requestServiceLines.status, rematchCount: requestServiceLines.rematchCount })
        .from(requestServiceLines)
        .where(eq(requestServiceLines.id, lineId));

      if (line?.status === 'failed') break;

      const [live] = await getDb()
        .select({ id: providerOffers.id, expiresAt: providerOffers.expiresAt })
        .from(providerOffers)
        .where(eq(providerOffers.status, 'sent'));

      if (live === undefined) {
        const outcome = await rematchLine(lineId, { evaluationNow: NOW });
        if ('kind' in outcome && outcome.kind === 'ceiling_reached') break;
        if ('kind' in outcome && outcome.kind === 'failed') break;
        continue;
      }

      await expireOffer(live.id, new Date(live.expiresAt.getTime() + 1000));
      const outcome = await rematchLine(lineId, { evaluationNow: NOW });
      if ('kind' in outcome && outcome.kind === 'ceiling_reached') break;
      if ('kind' in outcome && outcome.kind === 'failed') break;
    }

    const [line] = await getDb()
      .select({ status: requestServiceLines.status, failureReason: requestServiceLines.failureReason })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, lineId));

    expect(line?.status).toBe('failed');
    expect(line?.failureReason).not.toBeNull();
  });
});

describe('shift boundaries are respected, not rounded over', () => {
  it('fails an 03:00 eight-hour close-protection detail no single officer can cover', async () => {
    // Sentinel's KTEB officers work 18:00-06:00; the derived detail runs 03:00-11:00
    // local. No officer covers the whole window, so the honest answer is that nobody can
    // do it end to end — not a silent hand-off the client never agreed to.
    const created = await makeRequest([fixture.closeProtectionId]);
    const result = await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });

    expect(result.kind).toBe('failed');

    const rejected = result.decision.outcome.rejected.find(
      (candidate) => candidate.displayName === 'Sentinel Risk Group',
    );
    expect(rejected?.reasonCodes).toContain('resource_outside_working_hours');
  });

  it('matches the same detail when it falls inside the night shift', async () => {
    const created = await createRequest({
      clientOrganizationId: fixture.clientId,
      createdByUserId: null,
      createdVia: 'ops',
      sourceSentence: 'Three bodyguards at Teterboro, 20:00 to 23:00.',
      airportId: fixture.ktebId,
      fboId: null,
      aircraftId: null,
      // 2026-09-17 20:00 local is 2026-09-18T00:00Z; the detail ends within the shift.
      arrivalUtc: new Date('2026-09-18T00:00:00.000Z'),
      departureUtc: new Date('2026-09-18T03:00:00.000Z'),
      passengerCount: 4,
      crewCount: 2,
      lines: [
        {
          serviceCategoryId: fixture.closeProtectionId,
          quantity: 3,
          requirements: { officers: 3, armed: true },
        },
      ],
    });

    const result = await dispatchNextOffer(created.lineIds[0]!, {
      evaluationNow: new Date('2026-09-17T12:00:00.000Z'),
    });

    expect(result.kind).toBe('offered');
    expect(result.offer?.providerCompanyId).toBeDefined();
  });
});

describe('request status derivation', () => {
  it('becomes partial when one line is covered and another is not', async () => {
    const created = await makeRequest([fixture.groundTransportId, fixture.fuelId]);
    const [carLine, guardLine] = created.lineIds;

    const carOffer = (await dispatchNextOffer(carLine!, { evaluationNow: NOW })).offer!;
    await dispatchNextOffer(guardLine!, { evaluationNow: NOW });

    const user = await dispatcherFor(carOffer.providerCompanyId);
    await acknowledgeOffer({
      offerId: carOffer.id,
      actorUserId: user.id,
      actorRole: user.role,
      actorLabel: user.email,
      providerCompanyId: carOffer.providerCompanyId,
      now: NOW,
    });

    const [request] = await getDb()
      .select({ status: requests.status })
      .from(requests)
      .where(eq(requests.id, created.request.id));

    expect(request?.status).toBe('partial');
  });

  it('becomes confirmed once every line is acknowledged', async () => {
    const created = await makeRequest([fixture.groundTransportId, fixture.fuelId]);

    for (const lineId of created.lineIds) {
      const offer = (await dispatchNextOffer(lineId, { evaluationNow: NOW })).offer!;
      const user = await dispatcherFor(offer.providerCompanyId);
      await acknowledgeOffer({
        offerId: offer.id,
        actorUserId: user.id,
        actorRole: user.role,
        actorLabel: user.email,
        providerCompanyId: offer.providerCompanyId,
        now: NOW,
      });
    }

    const [request] = await getDb()
      .select({ status: requests.status })
      .from(requests)
      .where(eq(requests.id, created.request.id));

    expect(request?.status).toBe('confirmed');
  });
});

async function readFixture(): Promise<Fixture> {
  const db = getDb();

  const [client] = await db
    .select({ id: clientOrganizations.id })
    .from(clientOrganizations)
    .where(eq(clientOrganizations.slug, 'meridian-capital-partners'));

  const [kteb] = await db.select({ id: airports.id }).from(airports).where(eq(airports.icao, 'KTEB'));

  const services = await db
    .select({ code: serviceCategories.code, id: serviceCategories.id })
    .from(serviceCategories);
  const byCode = new Map(services.map((row) => [row.code, row.id]));

  const allUsers = await db
    .select({ email: users.email, id: users.id, providerCompanyId: users.providerCompanyId })
    .from(users);

  if (client === undefined || kteb === undefined) throw new Error('seeded fixture incomplete');

  return {
    clientId: client.id,
    ktebId: kteb.id,
    groundTransportId: byCode.get('ground_transport')!,
    closeProtectionId: byCode.get('close_protection')!,
    fuelId: byCode.get('fuel')!,
    userIdByEmail: new Map(
      allUsers.map((row) => [row.email, { id: row.id, providerCompanyId: row.providerCompanyId }]),
    ),
  };
}
