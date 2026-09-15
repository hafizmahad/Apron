import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  clientOrganizations,
  notificationDeliveries,
  notifications,
  providerCompanies,
  providerOffers,
  requestServiceLines,
  serviceCategories,
  users,
} from '@/db/schema';
import { createRequest } from '@/domain/requests/create';
import { declineOffer, dispatchNextOffer, expireOffer } from '@/services/offers';
import { cancelRequest, type InterventionActor } from '@/services/interventions';
import { suspendProvider } from '@/services/governance';
import { notify, retryFailedDeliveries } from '@/services/notifications';
import { handleNotification } from '@/jobs/workers/register';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import {
  resetMailTransportForTests,
  setMailTransportForTests,
  useMemoryMailTransportForTests,
  type CapturedEmail,
} from '@/lib/mail';
import { ensureMigrated, truncateAll } from '../../helpers/database';

/**
 * Notifications against the real database (CLAUDE.md §18).
 *
 * The guarantee under test is the one the brief states outright: **never send duplicate
 * notifications on job retries.** Everything else here exists to prove that guarantee holds
 * under the conditions that actually break it — the same job delivered twice, a handler
 * re-run after a restart, an event fired again for an operation that was already idempotent.
 */

let sent: CapturedEmail[];
let OPS: InterventionActor;

interface Fixture {
  readonly clientId: string;
  readonly ktebId: string;
  readonly groundTransportId: string;
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
  sent = useMemoryMailTransportForTests();

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
  const [opsUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'operations_manager'));

  if (client === undefined || kteb === undefined || ground === undefined || opsUser === undefined) {
    throw new Error('seeded fixture incomplete');
  }

  OPS = { userId: opsUser.id, role: 'operations_manager', label: 'test-ops' };
  fixture = { clientId: client.id, ktebId: kteb.id, groundTransportId: ground.id };
});

afterEach(() => {
  resetMailTransportForTests();
});

async function makeRequest() {
  return createRequest({
    clientOrganizationId: fixture.clientId,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'Two cars at Teterboro Friday morning.',
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
}

async function liveOffer(lineId: string) {
  const [row] = await getDb()
    .select({
      id: providerOffers.id,
      providerCompanyId: providerOffers.providerCompanyId,
      expiresAt: providerOffers.expiresAt,
    })
    .from(providerOffers)
    .where(
      sql`${providerOffers.requestServiceLineId} = ${lineId}::uuid and ${providerOffers.status} = 'sent'`,
    )
    .limit(1);
  return row ?? null;
}

describe('an offer notifies the provider', () => {
  it('emails the provider dispatchers, not operations, and not the client', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });

    const offer = await liveOffer(created.lineIds[0]!);
    expect(offer).not.toBeNull();

    const recipients = await getDb()
      .select({ role: users.role, email: users.email })
      .from(users)
      .where(eq(users.providerCompanyId, offer!.providerCompanyId));

    const notifiable = recipients
      .filter((row) => row.role === 'provider_admin' || row.role === 'provider_dispatcher')
      .map((row) => row.email);

    expect(sent.length).toBeGreaterThan(0);
    for (const email of sent) {
      expect(notifiable).toContain(email.to);
    }
  });

  it('states the acknowledgement deadline in the body', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });

    expect(sent[0]?.text).toMatch(/Acknowledge by/i);
    expect(sent[0]?.subject).toMatch(/KTEB|Teterboro/);
  });

  it('does not put passenger contact details in the email', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });

    // The body says how contacts are obtained, rather than containing them.
    expect(sent[0]?.text).toMatch(/become visible once you acknowledge/i);
    expect(sent[0]?.text).not.toMatch(/\+1 \d{3} \d{3} \d{4}/);
  });

  it('records an in-app notification alongside the email', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });

    const rows = await getDb()
      .select({ kind: notifications.kind, title: notifications.title })
      .from(notifications);

    expect(rows.some((row) => row.kind === 'offer.sent')).toBe(true);
  });
});

describe('a retried job does not send a second email', () => {
  it('sends once however many times the same event is notified', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });

    const firstCount = sent.length;
    expect(firstCount).toBeGreaterThan(0);

    const offer = await liveOffer(created.lineIds[0]!);

    // Three more attempts at exactly the same event — a redelivered job, a worker restart,
    // a manual replay.
    await notify({ kind: 'offer.sent', offerId: offer!.id });
    await notify({ kind: 'offer.sent', offerId: offer!.id });
    await notify({ kind: 'offer.sent', offerId: offer!.id });

    expect(sent.length).toBe(firstCount);
  });

  it('holds the line through the worker handler too', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });
    const firstCount = sent.length;

    const offer = await liveOffer(created.lineIds[0]!);

    await handleNotification({
      idempotencyKey: `offer.sent-${offer!.id}`,
      kind: 'offer.sent',
      correlationId: 'test',
      payload: { kind: 'offer.sent', offerId: offer!.id },
    });

    expect(sent.length).toBe(firstCount);
  });

  it('keeps exactly one delivery row per recipient per event', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });
    const offer = await liveOffer(created.lineIds[0]!);

    await notify({ kind: 'offer.sent', offerId: offer!.id });

    const rows = await getDb()
      .select({ key: notificationDeliveries.idempotencyKey })
      .from(notificationDeliveries);

    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('does not stack identical in-app notifications', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });
    const offer = await liveOffer(created.lineIds[0]!);

    const before = await getDb().select({ id: notifications.id }).from(notifications);
    await notify({ kind: 'offer.sent', offerId: offer!.id });
    const after = await getDb().select({ id: notifications.id }).from(notifications);

    expect(after.length).toBe(before.length);
  });

  it('drops an unrecognised job rather than crashing the worker', async () => {
    await expect(
      handleNotification({
        idempotencyKey: 'whatever',
        kind: 'offer.teleported',
        correlationId: 'test',
        payload: { kind: 'offer.teleported', offerId: 'not-a-uuid' },
      }),
    ).resolves.toBeUndefined();

    expect(sent).toHaveLength(0);
  });
});

describe('exceptions reach operations', () => {
  it('emails operations when a provider declines, with the reason', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });
    const offer = await liveOffer(created.lineIds[0]!);

    sent.length = 0;

    await declineOffer({
      offerId: offer!.id,
      providerCompanyId: offer!.providerCompanyId,
      actorUserId: OPS.userId,
      actorRole: 'provider_dispatcher',
      actorLabel: 'test-dispatcher',
      reason: 'No crew available overnight',
      now: NOW,
    });

    const opsEmails = await getDb()
      .select({ email: users.email })
      .from(users)
      .where(sql`${users.role} in ('operations_manager', 'operations_agent')`);
    const opsAddresses = opsEmails.map((row) => row.email);

    expect(sent.length).toBeGreaterThan(0);
    for (const email of sent) expect(opsAddresses).toContain(email.to);
    expect(sent[0]?.text).toMatch(/No crew available overnight/);
  });

  it('notifies once for an expiry, and not at all when the expiry was a no-op', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });
    const offer = await liveOffer(created.lineIds[0]!);

    sent.length = 0;

    const past = new Date(offer!.expiresAt.getTime() + 60_000);
    const first = await expireOffer(offer!.id, past);
    expect(first.expired).toBe(true);
    const afterFirst = sent.length;
    expect(afterFirst).toBeGreaterThan(0);

    // The job is redelivered. The offer is already expired, so nothing is sent.
    const second = await expireOffer(offer!.id, past);
    expect(second.expired).toBe(false);
    expect(sent.length).toBe(afterFirst);
  });

  it('tells every provider holding work that a request was cancelled', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });
    const offer = await liveOffer(created.lineIds[0]!);

    sent.length = 0;

    await cancelRequest(
      { requestId: created.request.id, reason: 'Client cancelled the trip.' },
      OPS,
    );

    const providerEmails = await getDb()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.providerCompanyId, offer!.providerCompanyId));

    const addresses = new Set(providerEmails.map((row) => row.email));
    expect(sent.some((email) => addresses.has(email.to))).toBe(true);
    expect(sent.some((email) => /cancelled/i.test(email.subject))).toBe(true);
  });
});

describe('delivery failures', () => {
  it('records a failed delivery rather than failing the business operation', async () => {
    // A mail server that is down. Installed through the module's own test hook rather than
    // by patching the export, because an ES module binding cannot be reassigned.
    setMailTransportForTests({
      name: 'memory',
      send: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1025');
      },
    });

    const created = await makeRequest();

    // The dispatch itself must succeed even though every email fails. A provider still has
    // a real offer with a real deadline; only the courtesy email is missing.
    const result = await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });
    expect(result.kind).toBe('offered');

    const rows = await getDb()
      .select({ status: notificationDeliveries.status, lastError: notificationDeliveries.lastError })
      .from(notificationDeliveries);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === 'failed')).toBe(true);
    expect(rows[0]?.lastError).toMatch(/ECONNREFUSED/);

    // And the in-app notification is there regardless, which is the point of keeping the
    // two separate: the provider sees the offer in the product even with no email.
    const inApp = await getDb().select({ kind: notifications.kind }).from(notifications);
    expect(inApp.some((row) => row.kind === 'offer.sent')).toBe(true);
  });

  it('retries a failed delivery and marks it sent', async () => {
    const created = await makeRequest();
    void created;
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });

    // Force the rows into the failed state the sweep looks for.
    await getDb()
      .update(notificationDeliveries)
      .set({ status: 'failed', lastError: 'transient', sentAt: null });

    const result = await retryFailedDeliveries();
    expect(result.retried).toBeGreaterThan(0);

    const rows = await getDb()
      .select({ status: notificationDeliveries.status })
      .from(notificationDeliveries);

    expect(rows.every((row) => row.status === 'sent')).toBe(true);
  });

  it('stops retrying once attempts reach the ceiling', async () => {
    const created = await makeRequest();
    await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });

    await getDb()
      .update(notificationDeliveries)
      .set({ status: 'failed', lastError: 'permanent', attempts: 3, sentAt: null });

    const result = await retryFailedDeliveries({ maxAttempts: 3 });
    expect(result.retried).toBe(0);
  });
});

describe('the line that nobody can cover', () => {
  it('emails operations and says what to do about it', async () => {
    const created = await makeRequest();

    // Suspend every approved provider through the real service, so the line genuinely
    // cannot be covered. A raw UPDATE is refused by `provider_companies_suspension_recorded`,
    // which is the constraint doing its job: a suspension without a recorded time and
    // reason is not a suspension anybody could later explain.
    const approved = await getDb()
      .select({ id: providerCompanies.id })
      .from(providerCompanies)
      .where(eq(providerCompanies.status, 'approved'));

    const [admin] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'platform_admin'));

    for (const provider of approved) {
      await suspendProvider(provider.id, 'Suspended for this test.', {
        userId: admin!.id,
        role: 'platform_admin',
        label: 'test-admin',
      });
    }

    sent.length = 0;
    const result = await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });
    expect(result.kind).toBe('failed');

    const [line] = await getDb()
      .select({ status: requestServiceLines.status })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, created.lineIds[0]!));
    expect(line?.status).toBe('failed');

    expect(sent.some((email) => /no provider could cover/i.test(email.subject))).toBe(true);
    expect(sent.some((email) => /Nothing further happens automatically/i.test(email.text))).toBe(
      true,
    );
  });
});
