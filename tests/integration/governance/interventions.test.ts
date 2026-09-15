import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  assignments,
  auditEvents,
  clientOrganizations,
  providerCompanies,
  providerOffers,
  requestServiceLines,
  requests,
  serviceCategories,
  users,
} from '@/db/schema';
import {
  cancelRequest,
  contactsReleasedTo,
  overrideProvider,
  releaseContactsToProvider,
  retryFailedLine,
  type InterventionActor,
} from '@/services/interventions';
import { suspendProvider, type Actor } from '@/services/governance';
import { createRequest } from '@/domain/requests/create';
import { acknowledgeOffer, declineOffer, dispatchNextOffer } from '@/services/offers';
import { createAssignment } from '@/services/assignments';
import { loadOverrideCandidates } from '@/db/queries/operations';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import { ensureMigrated, captureError, truncateAll } from '../../helpers/database';

/**
 * Operations interventions against the real database (CLAUDE.md §12, §5, §30).
 *
 * An override is the point where a person overrules the engine, so it is exactly where a
 * system is most likely to quietly break its own rules. These tests hold the line:
 *
 *  - an override still goes through the real offer machinery — a real offer, a real
 *    deadline, and the provider may still decline;
 *  - coverage and approval are enforced even for an override, because "operations said so"
 *    is not a reason a suspended company can suddenly do the work;
 *  - a reason is mandatory on every one of them, and it reaches the audit trail;
 *  - cancelling frees the concrete resources rather than leaving them booked.
 */

let OPS: InterventionActor;
let ADMIN: Actor;

interface Fixture {
  readonly clientId: string;
  readonly ktebId: string;
  readonly groundTransportId: string;
  readonly closeProtectionId: string;
}

let fixture: Fixture;

const ARRIVAL = new Date('2026-09-18T07:00:00.000Z');
const NOW = new Date(ARRIVAL.getTime() - 12 * 3_600_000);

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  await runSeed();
  setAiAdapterForTests(undefined);

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

  const [opsUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'operations_manager'));
  const [adminUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'platform_admin'));

  if (client === undefined || kteb === undefined || opsUser === undefined || adminUser === undefined) {
    throw new Error('seeded fixture incomplete');
  }

  OPS = { userId: opsUser.id, role: 'operations_manager', label: 'test-ops' };
  ADMIN = { userId: adminUser.id, role: 'platform_admin', label: 'test-admin' };

  fixture = {
    clientId: client.id,
    ktebId: kteb.id,
    groundTransportId: byCode.get('ground_transport')!,
    closeProtectionId: byCode.get('close_protection')!,
  };
});

async function makeRequest(serviceIds?: readonly string[]) {
  const ids = serviceIds ?? [fixture.groundTransportId];
  return createRequest({
    clientOrganizationId: fixture.clientId,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'Landing at Teterboro Friday at 7am, two cars.',
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
          : { officers: 3, armed: true },
    })),
  });
}

async function liveOffer(lineId: string) {
  const [row] = await getDb()
    .select({
      id: providerOffers.id,
      providerCompanyId: providerOffers.providerCompanyId,
      status: providerOffers.status,
      expiresAt: providerOffers.expiresAt,
      attemptNumber: providerOffers.attemptNumber,
    })
    .from(providerOffers)
    .where(sql`${providerOffers.requestServiceLineId} = ${lineId}::uuid and ${providerOffers.status} = 'sent'`)
    .limit(1);
  return row ?? null;
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId));
  return rows.map((row) => row.action);
}

describe('the override candidate list', () => {
  it('offers only approved companies that actually cover the service at this airport', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    const candidates = await loadOverrideCandidates(created.request.id);
    const list = candidates.get(lineId) ?? [];

    expect(list.length).toBeGreaterThan(0);

    // Every one of them is provably approved and covering, checked independently.
    for (const candidate of list) {
      const check = await getDb().execute<{ ok: boolean }>(sql`
        select exists (
          select 1 from provider_coverage pc
          join provider_companies p on p.id = pc.provider_company_id
          join request_service_lines l on l.service_category_id = pc.service_category_id
          join requests r on r.id = l.request_id
          where l.id = ${lineId}::uuid
            and pc.provider_company_id = ${candidate.providerCompanyId}::uuid
            and pc.airport_id = r.airport_id
            and pc.active
            and p.status = 'approved'
        ) as ok
      `);
      expect(check.rows[0]?.ok).toBe(true);
    }
  });

  it('drops a company from the list as soon as it is suspended', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    const before = await loadOverrideCandidates(created.request.id);
    const target = (before.get(lineId) ?? [])[0];
    expect(target).toBeDefined();

    await suspendProvider(target!.providerCompanyId, 'Insurance lapsed.', ADMIN);

    const after = await loadOverrideCandidates(created.request.id);
    const ids = (after.get(lineId) ?? []).map((candidate) => candidate.providerCompanyId);
    expect(ids).not.toContain(target!.providerCompanyId);
  });

  it('still lists a company that declined, but flags it as having refused', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    await dispatchNextOffer(lineId, { evaluationNow: NOW });
    const offer = await liveOffer(lineId);
    expect(offer).not.toBeNull();

    await declineOffer({
      offerId: offer!.id,
      providerCompanyId: offer!.providerCompanyId,
      actorUserId: OPS.userId,
      actorRole: 'provider_dispatcher',
      actorLabel: 'test-dispatcher',
      reason: 'No crew available for that window',
      now: NOW,
    });

    const candidates = await loadOverrideCandidates(created.request.id);
    const refused = (candidates.get(lineId) ?? []).find(
      (candidate) => candidate.providerCompanyId === offer!.providerCompanyId,
    );

    expect(refused).toBeDefined();
    expect(refused?.previouslyRefused).toBe(true);
  });
});

describe('overriding the provider choice', () => {
  it('withdraws the live offer and sends a real one to the chosen provider', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    await dispatchNextOffer(lineId, { evaluationNow: NOW });
    const original = await liveOffer(lineId);
    expect(original).not.toBeNull();

    const candidates = await loadOverrideCandidates(created.request.id);
    const alternative = (candidates.get(lineId) ?? []).find(
      (candidate) => candidate.providerCompanyId !== original!.providerCompanyId,
    );
    if (alternative === undefined) throw new Error('seed has only one covering provider');

    await overrideProvider(
      {
        requestServiceLineId: lineId,
        providerCompanyId: alternative.providerCompanyId,
        reason: 'Client asked for them by name for this arrival.',
        now: NOW,
      },
      OPS,
    );

    const [previous] = await getDb()
      .select({ status: providerOffers.status, reason: providerOffers.withdrawnReason })
      .from(providerOffers)
      .where(eq(providerOffers.id, original!.id));

    expect(previous?.status).toBe('withdrawn');
    expect(previous?.reason).toMatch(/override/i);

    const replacement = await liveOffer(lineId);
    expect(replacement).not.toBeNull();
    expect(replacement?.providerCompanyId).toBe(alternative.providerCompanyId);
    // A real offer, with a real deadline — the choice is overridden, not the process.
    expect(replacement?.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('leaves the overridden provider free to decline, like any other offer', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    const candidates = await loadOverrideCandidates(created.request.id);
    const chosen = (candidates.get(lineId) ?? [])[0]!;

    await overrideProvider(
      {
        requestServiceLineId: lineId,
        providerCompanyId: chosen.providerCompanyId,
        reason: 'Operations preference for this client.',
        now: NOW,
      },
      OPS,
    );

    const offer = await liveOffer(lineId);
    await declineOffer({
      offerId: offer!.id,
      providerCompanyId: offer!.providerCompanyId,
      actorUserId: OPS.userId,
      actorRole: 'provider_dispatcher',
      actorLabel: 'test-dispatcher',
      reason: 'Vehicles committed elsewhere',
      now: NOW,
    });

    const [after] = await getDb()
      .select({ status: providerOffers.status })
      .from(providerOffers)
      .where(eq(providerOffers.id, offer!.id));

    expect(after?.status).toBe('declined');
  });

  it('refuses a provider that does not cover this service at this airport', async () => {
    const created = await makeRequest([fixture.closeProtectionId]);
    const lineId = created.lineIds[0]!;

    // A company that covers something here, but not close protection.
    const outsider = await getDb().execute<{ id: string }>(sql`
      select p.id from provider_companies p
      where p.status = 'approved'
        and not exists (
          select 1 from provider_coverage pc
          join request_service_lines l on l.service_category_id = pc.service_category_id
          join requests r on r.id = l.request_id
          where l.id = ${lineId}::uuid
            and pc.provider_company_id = p.id
            and pc.airport_id = r.airport_id
            and pc.active
        )
      limit 1
    `);

    const outsiderId = outsider.rows[0]?.id;
    if (outsiderId === undefined) throw new Error('seed has no non-covering approved provider');

    const error = await captureError(() =>
      overrideProvider(
        {
          requestServiceLineId: lineId,
          providerCompanyId: outsiderId,
          reason: 'Trying to force it through.',
          now: NOW,
        },
        OPS,
      ),
    );

    expect(error.message).toMatch(/does not cover/i);
  });

  it('refuses a suspended provider, whatever operations says', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    const candidates = await loadOverrideCandidates(created.request.id);
    const target = (candidates.get(lineId) ?? [])[0]!;
    await suspendProvider(target.providerCompanyId, 'Under investigation.', ADMIN);

    const error = await captureError(() =>
      overrideProvider(
        {
          requestServiceLineId: lineId,
          providerCompanyId: target.providerCompanyId,
          reason: 'I know the owner personally.',
          now: NOW,
        },
        OPS,
      ),
    );

    expect(error.message).toMatch(/suspended/i);
  });

  it('refuses without a reason and changes nothing', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;
    await dispatchNextOffer(lineId, { evaluationNow: NOW });
    const before = await liveOffer(lineId);

    const candidates = await loadOverrideCandidates(created.request.id);
    const target = (candidates.get(lineId) ?? [])[0]!;

    const error = await captureError(() =>
      overrideProvider(
        {
          requestServiceLineId: lineId,
          providerCompanyId: target.providerCompanyId,
          reason: '  ',
          now: NOW,
        },
        OPS,
      ),
    );

    expect(error.message).toMatch(/reason/i);

    const after = await liveOffer(lineId);
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe('sent');
  });

  it('records the override with its reason against the line', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    const candidates = await loadOverrideCandidates(created.request.id);
    const target = (candidates.get(lineId) ?? [])[0]!;

    await overrideProvider(
      {
        requestServiceLineId: lineId,
        providerCompanyId: target.providerCompanyId,
        reason: 'Client asked for them by name.',
        now: NOW,
      },
      OPS,
    );

    const rows = await getDb()
      .select({ action: auditEvents.action, reason: auditEvents.reason, role: auditEvents.actorRole })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, lineId));

    const override = rows.find((row) => row.action.includes('override'));
    expect(override).toBeDefined();
    expect(override?.reason).toBe('Client asked for them by name.');
    expect(override?.role).toBe('operations_manager');
  });
});

describe('retrying a failed line', () => {
  it('refuses a line that has not actually failed', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    const error = await captureError(() =>
      retryFailedLine(
        { requestServiceLineId: lineId, reason: 'Trying again for luck.', now: NOW },
        OPS,
      ),
    );

    expect(error.message).toMatch(/not failed|nothing to retry/i);
  });

  it('puts a failed line back into matching and resets the re-match counter', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    await getDb()
      .update(requestServiceLines)
      .set({ status: 'failed', rematchCount: 3, failureReason: 'No provider could cover it.' })
      .where(eq(requestServiceLines.id, lineId));

    await retryFailedLine(
      {
        requestServiceLineId: lineId,
        reason: 'Meridian has confirmed a second crew for this arrival.',
        now: NOW,
      },
      OPS,
    );

    const [line] = await getDb()
      .select({
        status: requestServiceLines.status,
        rematchCount: requestServiceLines.rematchCount,
        failureReason: requestServiceLines.failureReason,
      })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, lineId));

    expect(line?.status).not.toBe('failed');
    expect(line?.rematchCount).toBe(0);
    expect(line?.failureReason).toBeNull();

    expect(await auditActions(lineId)).toContain('request_line.retry');
  });
});

describe('releasing passenger contacts early', () => {
  it('refuses when that provider holds no live offer on the line', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    const [anyProvider] = await getDb()
      .select({ id: providerCompanies.id })
      .from(providerCompanies)
      .where(eq(providerCompanies.status, 'approved'))
      .limit(1);

    const error = await captureError(() =>
      releaseContactsToProvider(
        {
          requestServiceLineId: lineId,
          providerCompanyId: anyProvider!.id,
          reason: 'Driver is already on the ramp.',
        },
        OPS,
      ),
    );

    expect(error.message).toMatch(/does not hold a live offer/i);
  });

  it('records the release so the contact permission check can see it', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    await dispatchNextOffer(lineId, { evaluationNow: NOW });
    const offer = await liveOffer(lineId);

    expect(await contactsReleasedTo(lineId)).toHaveLength(0);

    await releaseContactsToProvider(
      {
        requestServiceLineId: lineId,
        providerCompanyId: offer!.providerCompanyId,
        reason: 'Driver is at the FBO and needs to reach the principal.',
      },
      OPS,
    );

    expect(await contactsReleasedTo(lineId)).toContain(offer!.providerCompanyId);
    expect(await auditActions(offer!.id)).toContain('request.release_contacts');
  });

  it('releases to exactly one provider on one line, not to every provider on the request', async () => {
    const created = await makeRequest([fixture.groundTransportId, fixture.closeProtectionId]);
    const [groundLine, protectionLine] = created.lineIds as [string, string];

    await dispatchNextOffer(groundLine, { evaluationNow: NOW });
    await dispatchNextOffer(protectionLine, { evaluationNow: NOW });

    const groundOffer = await liveOffer(groundLine);
    await releaseContactsToProvider(
      {
        requestServiceLineId: groundLine,
        providerCompanyId: groundOffer!.providerCompanyId,
        reason: 'Driver already on site.',
      },
      OPS,
    );

    expect(await contactsReleasedTo(groundLine)).toHaveLength(1);
    expect(await contactsReleasedTo(protectionLine)).toHaveLength(0);
  });
});

describe('cancelling a request', () => {
  it('refuses without a reason', async () => {
    const created = await makeRequest();
    const error = await captureError(() =>
      cancelRequest({ requestId: created.request.id, reason: '' }, OPS),
    );
    expect(error.message).toMatch(/reason/i);
  });

  it('withdraws live offers, cancels every line and records the reason', async () => {
    const created = await makeRequest([fixture.groundTransportId, fixture.closeProtectionId]);
    for (const lineId of created.lineIds) {
      await dispatchNextOffer(lineId, { evaluationNow: NOW });
    }

    await cancelRequest(
      { requestId: created.request.id, reason: 'Client cancelled — aircraft went technical.' },
      OPS,
    );

    const [request] = await getDb()
      .select({ status: requests.status, reason: requests.cancellationReason })
      .from(requests)
      .where(eq(requests.id, created.request.id));

    expect(request?.status).toBe('cancelled');
    expect(request?.reason).toBe('Client cancelled — aircraft went technical.');

    const lines = await getDb()
      .select({ status: requestServiceLines.status })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.requestId, created.request.id));
    expect(lines.every((line) => line.status === 'cancelled')).toBe(true);

    const live = await getDb().execute<{ n: number }>(sql`
      select count(*)::int as n from provider_offers o
      join request_service_lines l on l.id = o.request_service_line_id
      where l.request_id = ${created.request.id}::uuid and o.status = 'sent'
    `);
    expect(live.rows[0]?.n).toBe(0);
  });

  it('releases committed resources so they are free for other work', async () => {
    const created = await makeRequest();
    const lineId = created.lineIds[0]!;

    await dispatchNextOffer(lineId, { evaluationNow: NOW });
    const offer = await liveOffer(lineId);

    const dispatcher = {
      actorUserId: OPS.userId,
      actorRole: 'provider_dispatcher' as const,
      actorLabel: 'test-dispatcher',
      providerCompanyId: offer!.providerCompanyId,
    };

    await acknowledgeOffer({ offerId: offer!.id, ...dispatcher, now: NOW });

    // Commit the resources through the real assignment path, constraints and all.
    const resources = await getDb().execute<{ vehicle_id: string; driver_id: string }>(sql`
      select v.id as vehicle_id, d.id as driver_id
      from vehicles v
      join drivers d on d.provider_company_id = v.provider_company_id
      where v.provider_company_id = ${offer!.providerCompanyId}::uuid
        and v.active and d.active
      limit 1
    `);

    const pair = resources.rows[0];
    if (pair === undefined) throw new Error('provider has no vehicle and driver to commit');

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
      actorUserId: OPS.userId,
      actorRole: 'provider_dispatcher',
      actorLabel: 'test-dispatcher',
      startUtc: line!.startUtc ?? ARRIVAL,
      endUtc: line!.endUtc ?? new Date(ARRIVAL.getTime() + 3 * 3_600_000),
      resources: [
        { kind: 'vehicle', resourceId: pair.vehicle_id },
        { kind: 'driver', resourceId: pair.driver_id },
      ],
    });

    const committedBefore = await getDb().execute<{ n: number }>(sql`
      select count(*)::int as n from assignment_resources ar
      join assignments a on a.id = ar.assignment_id
      where a.request_service_line_id = ${lineId}::uuid and ar.released = false
    `);
    expect(committedBefore.rows[0]?.n).toBeGreaterThan(0);

    await cancelRequest(
      { requestId: created.request.id, reason: 'Trip cancelled by the client.' },
      OPS,
    );

    const committedAfter = await getDb().execute<{ n: number }>(sql`
      select count(*)::int as n from assignment_resources ar
      join assignments a on a.id = ar.assignment_id
      where a.request_service_line_id = ${lineId}::uuid and ar.released = false
    `);
    expect(committedAfter.rows[0]?.n).toBe(0);

    const [assignment] = await getDb()
      .select({ status: assignments.status })
      .from(assignments)
      .where(eq(assignments.requestServiceLineId, lineId));
    expect(assignment?.status).toBe('cancelled');
  });

  it('is idempotent — cancelling twice does not throw or double-write', async () => {
    const created = await makeRequest();
    await cancelRequest({ requestId: created.request.id, reason: 'Client cancelled.' }, OPS);
    await cancelRequest({ requestId: created.request.id, reason: 'Client cancelled.' }, OPS);

    const events = await getDb()
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, created.request.id));

    expect(events.filter((event) => event.action === 'request.cancel')).toHaveLength(1);
  });
});
