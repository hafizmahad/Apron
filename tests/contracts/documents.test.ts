import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  auditEvents,
  clientOrganizations,
  providerOffers,
  serviceCategories,
  users,
} from '@/db/schema';
import { createRequest } from '@/domain/requests/create';
import { dispatchNextOffer } from '@/services/offers';
import { generateDocument, type DocumentActor } from '@/services/documents';
import { createSession, revokeAllSessionsForUser } from '@/auth/session';
import { resetStorageForTests } from '@/lib/storage';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import { useMemoryMailTransportForTests } from '@/lib/mail';
import { getEnv } from '@/lib/config/env';
import { setEnv } from '../setup/env';
import { ensureMigrated, truncateAll } from '../helpers/database';

/**
 * HTTP contract for `GET /api/documents/[id]`.
 *
 * `tests/integration/documents` already proves the *contents* — that a work order holds
 * one provider's work and no other's. What is proved here is the part a caller reaches
 * over the wire: the status code, the headers, and above all that authorisation is
 * decided from the document record rather than from possession of the URL.
 *
 * Journey G in CLAUDE.md §32 is one provider reaching for another provider's data. A
 * document id in a URL is the cheapest possible way to try it, so that attempt is made
 * here for real, through the route, with a real session cookie.
 *
 * Note what a refusal looks like: 404, never 403. Distinguishing "not yours" from "does
 * not exist" would confirm the id is real, which turns a guess into an oracle.
 */

const jar = vi.hoisted(() => ({ cookie: null as string | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.cookie === null ? undefined : { name, value: jar.cookie }),
  }),
  headers: async () => new Headers(),
}));

interface Actors {
  readonly adminToken: string;
  readonly offerProviderToken: string;
  readonly otherProviderToken: string;
  readonly clientToken: string;
}

let storageRoot: string;
let adminUserId: string;
let actors: Actors;
let workOrderId: string;
let clientConfirmationId: string;

const ARRIVAL = new Date('2026-09-18T07:00:00.000Z');
const NOW = new Date(ARRIVAL.getTime() - 12 * 3_600_000);

beforeAll(async () => {
  await ensureMigrated();
  storageRoot = await mkdtemp(join(tmpdir(), 'apron-doc-contract-'));
  setEnv('DOCUMENT_STORAGE_PATH', storageRoot);
  setEnv('DOCUMENT_STORAGE_DRIVER', 'filesystem');
  resetStorageForTests();
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll();
  await runSeed();
  setAiAdapterForTests(undefined);
  useMemoryMailTransportForTests();
  jar.cookie = null;

  const db = getDb();
  const [client] = await db
    .select({ id: clientOrganizations.id })
    .from(clientOrganizations)
    .where(eq(clientOrganizations.slug, 'meridian-capital-partners'));
  const [kteb] = await db
    .select({ id: airports.id })
    .from(airports)
    .where(eq(airports.icao, 'KTEB'));
  const [ground] = await db
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(eq(serviceCategories.code, 'ground_transport'));
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'platform_admin'));

  if (
    client === undefined ||
    kteb === undefined ||
    ground === undefined ||
    admin === undefined
  ) {
    throw new Error('seeded fixture incomplete');
  }

  const [clientUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clientOrganizationId, client.id));
  if (clientUser === undefined) throw new Error('seeded client user missing');

  adminUserId = admin.id;
  const adminActor: DocumentActor = {
    userId: admin.id,
    role: 'platform_admin',
    label: 'contract-admin',
  };

  const created = await createRequest({
    clientOrganizationId: client.id,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'Landing at Teterboro Friday at 7am, two cars.',
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

  await dispatchNextOffer(created.lineIds[0]!, { evaluationNow: NOW });
  const [offer] = await db
    .select({ providerCompanyId: providerOffers.providerCompanyId })
    .from(providerOffers)
    .limit(1);
  if (offer === undefined) throw new Error('no offer was dispatched');

  // The company the work order belongs to, and a different one to attack it with.
  const [offerUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.providerCompanyId, offer.providerCompanyId));
  const [otherUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, 'provider_dispatcher'),
        ne(users.providerCompanyId, offer.providerCompanyId),
      ),
    );
  if (offerUser === undefined || otherUser === undefined) {
    throw new Error('seeded provider users missing');
  }

  const workOrder = await generateDocument(
    {
      requestId: created.request.id,
      kind: 'provider_work_order',
      providerCompanyId: offer.providerCompanyId,
    },
    adminActor,
  );
  const confirmation = await generateDocument(
    { requestId: created.request.id, kind: 'client_confirmation' },
    adminActor,
  );

  workOrderId = workOrder.id;
  clientConfirmationId = confirmation.id;

  actors = {
    adminToken: (await createSession(admin.id)).token,
    offerProviderToken: (await createSession(offerUser.id)).token,
    otherProviderToken: (await createSession(otherUser.id)).token,
    clientToken: (await createSession(clientUser.id)).token,
  };
});

async function get(id: string, token: string | null): Promise<Response> {
  jar.cookie = token;
  const { GET } = await import('@/app/api/documents/[id]/route');
  return GET(new Request(`http://localhost/api/documents/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/documents/[id], rejection', () => {
  it('answers 404 for an id that is not a uuid, without touching the session', async () => {
    // Checked before authentication on purpose: a malformed id is not a lookup.
    const response = await get('not-a-uuid', null);
    expect(response.status).toBe(404);
  });

  it('answers 401 for a well-formed id with no session', async () => {
    const response = await get(workOrderId, null);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('Not authenticated');
  });

  it('answers 404, not 403, when a provider reaches for another company document', async () => {
    const response = await get(workOrderId, actors.otherProviderToken);

    // Journey G. The refusal must not confirm that the id exists.
    expect(response.status).toBe(404);

    const unknown = await get('00000000-0000-4000-8000-000000000000', actors.otherProviderToken);
    expect(unknown.status).toBe(404);
    expect(await response.text()).toBe(await unknown.text());
  });

  it('refuses a client a document kind that is not theirs, on their own request', async () => {
    // The request belongs to this client. The work order still does not.
    const response = await get(workOrderId, actors.clientToken);
    expect(response.status).toBe(404);
  });

  it('writes no audit row for a refused read', async () => {
    await get(workOrderId, actors.otherProviderToken);

    const rows = await getDb()
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.action, 'document.download'));
    expect(rows).toHaveLength(0);
  });
});

describe('GET /api/documents/[id], release', () => {
  it('serves the bytes to operations and admin', async () => {
    const response = await get(workOrderId, actors.adminToken);
    expect(response.status).toBe(200);

    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(response.headers.get('content-length')).toBe(String(body.byteLength));
  });

  it('serves a provider their own work order', async () => {
    const response = await get(workOrderId, actors.offerProviderToken);
    expect(response.status).toBe(200);
  });

  it('serves a client a confirmation on their own request', async () => {
    const response = await get(clientConfirmationId, actors.clientToken);
    expect(response.status).toBe(200);
  });

  it('sets headers that keep a private document out of a shared cache', async () => {
    const response = await get(workOrderId, actors.adminToken);

    expect(response.headers.get('content-type')).toBe('application/pdf');
    // A client manifest held in an intermediary cache is a disclosure.
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^inline; filename="[A-Za-z0-9 _-]+\.pdf"$/);
  });

  it('audits every successful read', async () => {
    await get(workOrderId, actors.adminToken);

    const rows = await getDb()
      .select({ entityId: auditEvents.entityId, actorRole: auditEvents.actorRole })
      .from(auditEvents)
      .where(eq(auditEvents.action, 'document.download'));

    // "Who downloaded the manifest" is asked after the fact and must have an answer.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entityId).toBe(workOrderId);
    expect(rows[0]?.actorRole).toBe('platform_admin');
  });
});

describe('GET /api/documents/[id], session state', () => {
  it('stops serving once the session is revoked', async () => {
    expect((await get(workOrderId, actors.adminToken)).status).toBe(200);

    await revokeAllSessionsForUser(adminUserId);

    // Revocation is immediate; a cookie is not a bearer of past authority.
    expect((await get(workOrderId, actors.adminToken)).status).toBe(401);
  });

  it('ignores a cookie value that was never issued', async () => {
    expect(getEnv().SESSION_COOKIE_NAME.length).toBeGreaterThan(0);

    const response = await get(workOrderId, 'a-token-nobody-issued');
    expect(response.status).toBe(401);
  });
});
