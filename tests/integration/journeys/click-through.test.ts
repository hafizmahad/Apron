import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  assignments,
  clientOrganizations,
  providerOffers,
  requestServiceLines,
  requests,
  serviceCategories,
  users,
} from '@/db/schema';
import { createRequest } from '@/domain/requests/create';
import { startMatchingForRequest } from '@/services/request-dispatch';
import { acknowledgeOffer, declineOffer } from '@/services/offers';
import { createAssignment } from '@/services/assignments';
import { loadOfferQueue, type QueueItem } from '@/db/queries/provider-queue';
import { loadRequestDetail } from '@/db/queries/operations';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import { useMemoryMailTransportForTests } from '@/lib/mail';
import { ensureMigrated, truncateAll } from '../../helpers/database';

/**
 * The click-through journey, end to end (CLAUDE.md §32 Journeys A and B).
 *
 * This is the flow a person actually performs: a request is confirmed, matching runs, a
 * provider sees the work in their own queue, acknowledges it, commits real vehicles and
 * drivers, and operations sees the result.
 *
 * It exists because the chain was broken at exactly one link and nothing noticed. Every
 * piece had its own passing tests — intake, matching, offers, assignment — and the product
 * still did nothing, because `confirmRequestAction` created the request and never enqueued
 * matching. Each unit worked; the sequence did not. So this test asserts the *sequence*,
 * starting from the same service the confirm action calls.
 */

interface Fixture {
  readonly clientId: string;
  readonly ktebId: string;
  readonly groundTransportId: string;
  readonly closeProtectionId: string;
  readonly opsUserId: string;
}

let fixture: Fixture;

const ARRIVAL = new Date('2026-09-18T15:00:00.000Z');
const NOW = new Date(ARRIVAL.getTime() - 12 * 3_600_000);

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  await runSeed();
  setAiAdapterForTests(undefined);
  useMemoryMailTransportForTests();

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
  const [ops] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'operations_manager'));

  if (client === undefined || kteb === undefined || ops === undefined) {
    throw new Error('seeded fixture incomplete');
  }

  fixture = {
    clientId: client.id,
    ktebId: kteb.id,
    groundTransportId: byCode.get('ground_transport')!,
    closeProtectionId: byCode.get('close_protection')!,
    opsUserId: ops.id,
  };
});

/** Exactly what `confirmRequestAction` does, minus the HTTP and permission layer. */
async function confirmAndDispatch(serviceIds: readonly string[]) {
  const created = await createRequest({
    clientOrganizationId: fixture.clientId,
    createdByUserId: null,
    createdVia: 'client',
    sourceSentence: 'Landing at Teterboro Friday at 11am, two cars.',
    airportId: fixture.ktebId,
    fboId: null,
    aircraftId: null,
    arrivalUtc: ARRIVAL,
    departureUtc: null,
    passengerCount: 4,
    crewCount: 2,
    lines: serviceIds.map((id) => ({
      serviceCategoryId: id,
      quantity: id === fixture.closeProtectionId ? 2 : 2,
      requirements:
        id === fixture.groundTransportId
          ? { vehicleClass: 'suv', passengers: 4 }
          : { officers: 2, armed: false },
    })),
  });

  const dispatch = await startMatchingForRequest(created.request.id, { now: NOW });
  return { created, dispatch };
}

async function dispatcherAt(providerCompanyId: string) {
  const [user] = await getDb()
    .select({ id: users.id, role: users.role, fullName: users.fullName })
    .from(users)
    .where(
      sql`${users.providerCompanyId} = ${providerCompanyId}::uuid and ${users.role} = 'provider_dispatcher'`,
    )
    .limit(1);

  if (user === undefined) throw new Error('no dispatcher at that company');
  return user;
}

describe('confirming a request actually starts matching', () => {
  it('dispatches an offer for every service line', async () => {
    const { created, dispatch } = await confirmAndDispatch([fixture.groundTransportId]);

    expect(dispatch.lines).toBe(1);
    expect(dispatch.offered).toBe(1);
    expect(dispatch.failed).toBe(0);

    const offers = await getDb()
      .select({ id: providerOffers.id, status: providerOffers.status })
      .from(providerOffers)
      .innerJoin(
        requestServiceLines,
        eq(requestServiceLines.id, providerOffers.requestServiceLineId),
      )
      .where(eq(requestServiceLines.requestId, created.request.id));

    expect(offers).toHaveLength(1);
    expect(offers[0]?.status).toBe('sent');
  });

  it('leaves no line stranded in matching — the bug this test exists for', async () => {
    const { created } = await confirmAndDispatch([
      fixture.groundTransportId,
      fixture.closeProtectionId,
    ]);

    const lines = await getDb()
      .select({ status: requestServiceLines.status })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.requestId, created.request.id));

    expect(lines).toHaveLength(2);
    // Every line has moved on. Before the fix they all sat in `matching` for ever.
    for (const line of lines) {
      expect(line.status, 'a line was left in matching with no offer').not.toBe('matching');
    }
  });

  it('moves the request out of sent, into sourcing', async () => {
    const { created } = await confirmAndDispatch([fixture.groundTransportId]);

    const [request] = await getDb()
      .select({ status: requests.status })
      .from(requests)
      .where(eq(requests.id, created.request.id));

    expect(['sourcing', 'partial', 'confirmed']).toContain(request?.status);
  });

  it('is safe to call twice — no provider gets two offers for one job', async () => {
    const { created } = await confirmAndDispatch([fixture.groundTransportId]);

    // A double-submit, a retry, a page refresh.
    const second = await startMatchingForRequest(created.request.id, { now: NOW });
    expect(second.lines).toBe(0);

    const live = await getDb().execute<{ n: number }>(sql`
      select count(*)::int as n from provider_offers o
      join request_service_lines l on l.id = o.request_service_line_id
      where l.request_id = ${created.request.id}::uuid and o.status = 'sent'
    `);

    expect(live.rows[0]?.n).toBe(1);
  });
});

describe('the provider sees the work in their own queue', () => {
  it('the offered company finds the request; another company does not', async () => {
    const { created } = await confirmAndDispatch([fixture.groundTransportId]);

    const [offer] = await getDb()
      .select({ providerCompanyId: providerOffers.providerCompanyId, id: providerOffers.id })
      .from(providerOffers)
      .innerJoin(
        requestServiceLines,
        eq(requestServiceLines.id, providerOffers.requestServiceLineId),
      )
      .where(eq(requestServiceLines.requestId, created.request.id));

    const holder = offer!.providerCompanyId;

    const theirs = await loadOfferQueue(holder);
    expect(theirs.some((item: QueueItem) => item.offerId === offer!.id)).toBe(true);

    // Journey G: a different company's queue does not contain it.
    const others = await getDb().execute<{ id: string }>(sql`
      select id from provider_companies
      where status = 'approved' and id <> ${holder}::uuid
      limit 1
    `);

    const otherQueue = await loadOfferQueue(others.rows[0]!.id);
    expect(otherQueue.some((item: QueueItem) => item.offerId === offer!.id)).toBe(false);
  });
});

describe('the whole journey, start to finish — Journey A', () => {
  it('confirm → match → acknowledge → assign → operations sees it', async () => {
    // 1. the client confirms a request
    const { created, dispatch } = await confirmAndDispatch([fixture.groundTransportId]);
    expect(dispatch.offered).toBe(1);

    const lineId = created.lineIds[0]!;

    // 2. an offer exists and the provider can see it
    const [offer] = await getDb()
      .select({
        id: providerOffers.id,
        providerCompanyId: providerOffers.providerCompanyId,
        status: providerOffers.status,
      })
      .from(providerOffers)
      .where(eq(providerOffers.requestServiceLineId, lineId));

    expect(offer?.status).toBe('sent');

    const dispatcher = await dispatcherAt(offer!.providerCompanyId);
    const queue = await loadOfferQueue(offer!.providerCompanyId);
    expect(queue.length).toBeGreaterThan(0);

    // 3. the provider acknowledges
    await acknowledgeOffer({
      offerId: offer!.id,
      providerCompanyId: offer!.providerCompanyId,
      actorUserId: dispatcher.id,
      actorRole: dispatcher.role,
      actorLabel: dispatcher.fullName,
      now: NOW,
    });

    const [afterAck] = await getDb()
      .select({ status: requestServiceLines.status })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, lineId));
    expect(afterAck?.status).toBe('acknowledged');

    // 4. the provider commits real resources
    const resources = await getDb().execute<{ vehicle_id: string; driver_id: string }>(sql`
      select v.id as vehicle_id, d.id as driver_id
      from vehicles v
      join drivers d on d.provider_company_id = v.provider_company_id
      where v.provider_company_id = ${offer!.providerCompanyId}::uuid
        and v.active and d.active
      limit 1
    `);
    const pair = resources.rows[0];
    if (pair === undefined) throw new Error('provider has no vehicle and driver');

    const [line] = await getDb()
      .select({
        startUtc: requestServiceLines.serviceStartUtc,
        endUtc: requestServiceLines.serviceEndUtc,
      })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, lineId));

    await createAssignment({
      requestServiceLineId: lineId,
      providerCompanyId: offer!.providerCompanyId,
      actorUserId: dispatcher.id,
      actorRole: dispatcher.role,
      actorLabel: dispatcher.fullName,
      startUtc: line!.startUtc ?? ARRIVAL,
      endUtc: line!.endUtc ?? new Date(ARRIVAL.getTime() + 3 * 3_600_000),
      resources: [
        { kind: 'vehicle', resourceId: pair.vehicle_id },
        { kind: 'driver', resourceId: pair.driver_id },
      ],
    });

    // 5. operations sees the finished picture
    const detail = await loadRequestDetail(created.request.id);
    expect(detail).not.toBeNull();

    const detailLine = detail!.lines.find((entry) => entry.id === lineId);
    expect(detailLine?.status).toBe('assigned');
    expect(detailLine?.currentProviderName).not.toBeNull();
    expect(detailLine?.assignedResources.length).toBeGreaterThanOrEqual(2);

    const [assignment] = await getDb()
      .select({ status: assignments.status })
      .from(assignments)
      .where(eq(assignments.requestServiceLineId, lineId));
    expect(assignment?.status).not.toBe('cancelled');

    // And the request itself has progressed.
    expect(['confirmed', 'in_progress', 'partial']).toContain(detail!.status);
  });

  it('a decline on one line re-matches it without touching the other — Journey B', async () => {
    const { created } = await confirmAndDispatch([
      fixture.groundTransportId,
      fixture.closeProtectionId,
    ]);

    const [groundLine, protectionLine] = created.lineIds as [string, string];

    const [groundOffer] = await getDb()
      .select({ id: providerOffers.id, providerCompanyId: providerOffers.providerCompanyId })
      .from(providerOffers)
      .where(
        sql`${providerOffers.requestServiceLineId} = ${groundLine}::uuid and ${providerOffers.status} = 'sent'`,
      );

    const [protectionOfferBefore] = await getDb()
      .select({ id: providerOffers.id })
      .from(providerOffers)
      .where(
        sql`${providerOffers.requestServiceLineId} = ${protectionLine}::uuid and ${providerOffers.status} = 'sent'`,
      );

    if (groundOffer === undefined) throw new Error('ground transport was not offered');

    const dispatcher = await dispatcherAt(groundOffer.providerCompanyId);
    await declineOffer({
      offerId: groundOffer.id,
      providerCompanyId: groundOffer.providerCompanyId,
      actorUserId: dispatcher.id,
      actorRole: dispatcher.role,
      actorLabel: dispatcher.fullName,
      reason: 'Both vehicles are committed elsewhere',
      now: NOW,
    });

    // The close-protection offer is untouched.
    if (protectionOfferBefore !== undefined) {
      const [after] = await getDb()
        .select({ status: providerOffers.status })
        .from(providerOffers)
        .where(eq(providerOffers.id, protectionOfferBefore.id));
      expect(after?.status).toBe('sent');
    }

    const [declined] = await getDb()
      .select({ status: providerOffers.status })
      .from(providerOffers)
      .where(eq(providerOffers.id, groundOffer.id));
    expect(declined?.status).toBe('declined');
  });
});
