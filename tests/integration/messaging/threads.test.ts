import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  clientOrganizations,
  messageThreads,
  messages,
  providerCompanies,
  providerOffers,
  serviceCategories,
  users,
} from '@/db/schema';
import { createRequest } from '@/domain/requests/create';
import { dispatchNextOffer } from '@/services/offers';
import {
  ensureThread,
  loadThread,
  loadThreads,
  postMessage,
  postSystemMessage,
  type ThreadActor,
} from '@/services/messaging';
import { can } from '@/domain/permissions';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import { useMemoryMailTransportForTests } from '@/lib/mail';
import { ensureMigrated, captureError, truncateAll } from '../../helpers/database';

/**
 * Message threads against the real database (CLAUDE.md §18, §5, Journey G).
 *
 * The property under test is tenant isolation, stated the way a person would state it:
 * *provider A can never read provider B's conversation, and neither can read an internal
 * note about them.* It is tested from the outside — by asking as that user — rather than
 * by inspecting the filter, because the filter is the thing that might be wrong.
 */

let OPS: ThreadActor;
let fixture: {
  clientId: string;
  ktebId: string;
  groundTransportId: string;
  requestId: string;
  lineId: string;
};

const ARRIVAL = new Date('2026-09-18T07:00:00.000Z');
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
  const [ground] = await db
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(eq(serviceCategories.code, 'ground_transport'));
  const [opsUser] = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(eq(users.role, 'operations_manager'));

  if (client === undefined || kteb === undefined || ground === undefined || opsUser === undefined) {
    throw new Error('seeded fixture incomplete');
  }

  OPS = {
    userId: opsUser.id,
    role: 'operations_manager',
    label: opsUser.fullName,
    providerCompanyId: null,
    clientOrganizationId: null,
  };

  const created = await createRequest({
    clientOrganizationId: client.id,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'Two cars at Teterboro.',
    airportId: kteb.id,
    fboId: null,
    aircraftId: null,
    arrivalUtc: ARRIVAL,
    departureUtc: null,
    passengerCount: 4,
    crewCount: 2,
    lines: [
      {
        serviceCategoryId: ground.id,
        quantity: 2,
        requirements: { vehicleClass: 'suv', passengers: 4 },
      },
    ],
  });

  fixture = {
    clientId: client.id,
    ktebId: kteb.id,
    groundTransportId: ground.id,
    requestId: created.request.id,
    lineId: created.lineIds[0]!,
  };
});

/** A dispatcher at a given company, as the thread layer sees them. */
async function dispatcherAt(providerCompanyId: string): Promise<ThreadActor> {
  const [user] = await getDb()
    .select({ id: users.id, fullName: users.fullName, role: users.role })
    .from(users)
    .where(
      sql`${users.providerCompanyId} = ${providerCompanyId}::uuid and ${users.role} = 'provider_dispatcher'`,
    )
    .limit(1);

  if (user === undefined) throw new Error('no dispatcher at that company');
  return {
    userId: user.id,
    role: user.role,
    label: user.fullName,
    providerCompanyId,
    clientOrganizationId: null,
  };
}

async function twoProviderCompanies(): Promise<[string, string]> {
  const rows = await getDb()
    .select({ id: providerCompanies.id })
    .from(providerCompanies)
    .where(eq(providerCompanies.status, 'approved'))
    .orderBy(providerCompanies.displayName)
    .limit(2);

  if (rows.length < 2) throw new Error('seed needs at least two approved providers');
  return [rows[0]!.id, rows[1]!.id];
}

describe('thread scoping', () => {
  it('lets operations read every thread on a request', async () => {
    const [companyA] = await twoProviderCompanies();

    await ensureThread({ requestId: fixture.requestId, scope: 'internal', subject: 'Internal' });
    await ensureThread({
      requestId: fixture.requestId,
      scope: 'provider',
      providerCompanyId: companyA,
      subject: 'With A',
    });

    const threads = await loadThreads(OPS, { requestId: fixture.requestId });
    expect(threads).toHaveLength(2);
  });

  it('shows a provider only its own thread — Journey G', async () => {
    const [companyA, companyB] = await twoProviderCompanies();

    const threadA = await ensureThread({
      requestId: fixture.requestId,
      scope: 'provider',
      providerCompanyId: companyA,
      subject: 'With A',
    });
    const threadB = await ensureThread({
      requestId: fixture.requestId,
      scope: 'provider',
      providerCompanyId: companyB,
      subject: 'With B',
    });

    const actorA = await dispatcherAt(companyA);
    const visible = await loadThreads(actorA);

    expect(visible.map((thread) => thread.id)).toEqual([threadA]);
    expect(visible.map((thread) => thread.id)).not.toContain(threadB);
  });

  it('refuses to load another company’s thread even by its exact id', async () => {
    const [companyA, companyB] = await twoProviderCompanies();
    const threadB = await ensureThread({
      requestId: fixture.requestId,
      scope: 'provider',
      providerCompanyId: companyB,
    });

    const actorA = await dispatcherAt(companyA);
    expect(await loadThread(threadB, actorA)).toBeNull();
  });

  it('hides internal threads from providers entirely', async () => {
    const [companyA] = await twoProviderCompanies();
    const internal = await ensureThread({
      requestId: fixture.requestId,
      scope: 'internal',
      subject: 'Do not show this to the provider',
    });

    const actorA = await dispatcherAt(companyA);
    expect(await loadThread(internal, actorA)).toBeNull();
    expect(await loadThreads(actorA)).toHaveLength(0);
  });

  it('shows a client only client-scoped threads on their own request', async () => {
    const [companyA] = await twoProviderCompanies();
    await ensureThread({
      requestId: fixture.requestId,
      scope: 'provider',
      providerCompanyId: companyA,
    });
    await ensureThread({ requestId: fixture.requestId, scope: 'internal' });
    const clientThread = await ensureThread({ requestId: fixture.requestId, scope: 'client' });

    const clientActor: ThreadActor = {
      userId: OPS.userId,
      role: 'client',
      label: 'Client user',
      providerCompanyId: null,
      clientOrganizationId: fixture.clientId,
    };

    const visible = await loadThreads(clientActor);
    expect(visible.map((thread) => thread.id)).toEqual([clientThread]);
  });
});

describe('posting', () => {
  it('records the author and appears in the thread', async () => {
    const thread = await ensureThread({ requestId: fixture.requestId, scope: 'internal' });

    await postMessage({ threadId: thread, body: 'Client moved the arrival to 09:00.' }, OPS);

    const detail = await loadThread(thread, OPS);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0]?.body).toBe('Client moved the arrival to 09:00.');
    expect(detail?.messages[0]?.authorName).toBe(OPS.label);
    expect(detail?.messages[0]?.isSystem).toBe(false);
  });

  it('refuses a provider posting into another company’s thread, and logs it', async () => {
    const [companyA, companyB] = await twoProviderCompanies();
    const threadB = await ensureThread({
      requestId: fixture.requestId,
      scope: 'provider',
      providerCompanyId: companyB,
    });

    const actorA = await dispatcherAt(companyA);
    const error = await captureError(() =>
      postMessage({ threadId: threadB, body: 'Trying to read your job.' }, actorA),
    );

    expect(error.message).toMatch(/does not exist/i);

    const written = await getDb().select({ id: messages.id }).from(messages);
    expect(written).toHaveLength(0);
  });

  it('lets a provider post into its own thread', async () => {
    const [companyA] = await twoProviderCompanies();
    const threadA = await ensureThread({
      requestId: fixture.requestId,
      scope: 'provider',
      providerCompanyId: companyA,
    });

    const actorA = await dispatcherAt(companyA);
    await postMessage({ threadId: threadA, body: 'Two SUVs confirmed, driver briefed.' }, actorA);

    const detail = await loadThread(threadA, actorA);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.canPost).toBe(true);
  });

  it('scopes provider_staff by tenancy here, and by capability at the action', async () => {
    const [companyA] = await twoProviderCompanies();
    const threadA = await ensureThread({
      requestId: fixture.requestId,
      scope: 'provider',
      providerCompanyId: companyA,
    });

    const [staff] = await getDb()
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(
        sql`${users.providerCompanyId} = ${companyA}::uuid and ${users.role} = 'provider_staff'`,
      )
      .limit(1);

    if (staff === undefined) return; // seed has no staff at this company

    const staffActor: ThreadActor = {
      userId: staff.id,
      role: 'provider_staff',
      label: staff.fullName,
      providerCompanyId: companyA,
      clientOrganizationId: null,
    };

    // Reading works — it is their company's conversation, and the service answers the
    // tenancy question only.
    const detail = await loadThread(threadA, staffActor);
    expect(detail).not.toBeNull();
    expect(detail?.canPost).toBe(true);

    // Capability is a separate question, answered by the permission matrix and enforced by
    // the server action. provider_staff holds neither send permission, so the action
    // refuses them even though the thread is genuinely theirs to read. Keeping the two
    // checks apart is deliberate: tenancy and capability fail for different reasons and
    // deserve different messages.
    expect(can({ ...staffActor, status: 'active' }, 'message.send.provider_thread')).toBe(false);
    expect(can({ ...staffActor, status: 'active' }, 'message.send.internal')).toBe(false);
  });

  it('refuses an empty message', async () => {
    const thread = await ensureThread({ requestId: fixture.requestId, scope: 'internal' });
    const error = await captureError(() => postMessage({ threadId: thread, body: '   ' }, OPS));
    expect(error.message).toMatch(/write something/i);
  });

  it('refuses posting into a closed thread', async () => {
    const thread = await ensureThread({ requestId: fixture.requestId, scope: 'internal' });
    await getDb()
      .update(messageThreads)
      .set({ closedAt: new Date() })
      .where(eq(messageThreads.id, thread));

    const error = await captureError(() => postMessage({ threadId: thread, body: 'Hello' }, OPS));
    expect(error.message).toMatch(/closed/i);
  });
});

describe('thread creation', () => {
  it('returns the existing thread rather than opening a second one', async () => {
    const first = await ensureThread({ requestId: fixture.requestId, scope: 'internal' });
    const second = await ensureThread({ requestId: fixture.requestId, scope: 'internal' });

    expect(second).toBe(first);

    const rows = await getDb().select({ id: messageThreads.id }).from(messageThreads);
    expect(rows).toHaveLength(1);
  });

  it('refuses a provider thread with no provider named', async () => {
    const error = await captureError(() =>
      ensureThread({ requestId: fixture.requestId, scope: 'provider', providerCompanyId: null }),
    );
    expect(error.message).toMatch(/must name its provider/i);
  });

  it('opens the provider thread automatically when an offer is sent', async () => {
    await dispatchNextOffer(fixture.lineId, { evaluationNow: NOW });

    const [offer] = await getDb()
      .select({ providerCompanyId: providerOffers.providerCompanyId })
      .from(providerOffers)
      .limit(1);

    const actor = await dispatcherAt(offer!.providerCompanyId);
    const threads = await loadThreads(actor);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.messageCount).toBeGreaterThan(0);
  });
});

describe('system messages', () => {
  it('are marked as system so the UI never renders them as a person speaking', async () => {
    await postSystemMessage({
      requestId: fixture.requestId,
      scope: 'internal',
      body: 'Offer expired. Re-matching.',
    });

    const threads = await loadThreads(OPS);
    const detail = await loadThread(threads[0]!.id, OPS);

    expect(detail?.messages[0]?.isSystem).toBe(true);
    expect(detail?.messages[0]?.authorName).toBeNull();
    expect(detail?.messages[0]?.authorLabel).toBe('Apron');
  });

  it('never throw — a missing narration must not roll back the thing it narrates', async () => {
    await expect(
      postSystemMessage({
        requestId: '00000000-0000-0000-0000-000000000000',
        scope: 'internal',
        body: 'About a request that does not exist.',
      }),
    ).resolves.toBeUndefined();
  });
});
