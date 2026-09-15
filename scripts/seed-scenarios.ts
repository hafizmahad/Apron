import '@/lib/server-guard';
import { eq } from 'drizzle-orm';
import { closePool, getDb } from '@/db/client';
import { airports, clientOrganizations, serviceCategories, users } from '@/db/schema';
import { createRequest } from '@/domain/requests/create';
import { dispatchNextOffer, acknowledgeOffer } from '@/services/offers';
import { createAssignment } from '@/services/assignments';
import { setAiAdapterForTests } from '@/ai/client';
import { getEnv } from '@/lib/config/env';

/**
 * Creates live scenario requests so the portals have real work to show.
 *
 * Separate from `db:seed` on purpose: the reference network is stable data, whereas these
 * are living requests that move through the lifecycle. They are created by calling the
 * SAME services the product uses — never by inserting rows — so every status, offer and
 * assignment here is one the state machines actually produced.
 *
 *   npm run db:scenarios
 *
 * Idempotent in effect: it refuses to run twice by checking for its own marker request.
 */

const MARKER = 'Scenario: two cars meeting a 03:00 arrival at Teterboro.';

async function main(): Promise<void> {
  const env = getEnv();
  if (env.APP_ENV !== 'local' && env.APP_ENV !== 'ci') {
    throw new Error(`Refusing to create scenario requests in APP_ENV="${env.APP_ENV}".`);
  }

  // Deterministic: the scenarios should look the same every time they are loaded.
  setAiAdapterForTests(undefined);

  const db = getDb();

  const existing = await db
    .select({ id: (await import('@/db/schema')).requests.id })
    .from((await import('@/db/schema')).requests)
    .where(eq((await import('@/db/schema')).requests.sourceSentence, MARKER))
    .limit(1);

  if (existing.length > 0) {
    console.log('[scenarios] already loaded — nothing to do');
    return;
  }

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

  const categories = await db.select().from(serviceCategories);
  const byCode = new Map(categories.map((row) => [row.code, row.id]));

  if (client === undefined || kteb === undefined) {
    throw new Error('The reference network is missing — run "npm run db:seed" first.');
  }

  // Tomorrow at 03:00 local, so the requests are always in the near future and the SLA
  // clocks in the provider portal are live rather than long expired.
  const arrival = nextLocal0300();
  const now = new Date();

  // --- 1. waiting on a provider -------------------------------------------
  const waiting = await createRequest({
    clientOrganizationId: client.id,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: MARKER,
    airportId: kteb.id,
    fboId: null,
    aircraftId: null,
    arrivalUtc: arrival,
    departureUtc: null,
    passengerCount: 4,
    crewCount: 2,
    lines: [
      {
        serviceCategoryId: byCode.get('ground_transport')!,
        quantity: 2,
        requirements: { vehicleClass: 'suv', passengers: 4 },
      },
    ],
  });

  const waitingOffer = await dispatchNextOffer(waiting.lineIds[0]!, { evaluationNow: now });
  console.log(
    `[scenarios] ${waiting.request.reference} — offer sent to a provider, awaiting response`,
  );

  // --- 2. accepted, awaiting resources ------------------------------------
  const accepted = await createRequest({
    clientOrganizationId: client.id,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'Scenario: fuel uplift on arrival at Teterboro.',
    airportId: kteb.id,
    fboId: null,
    aircraftId: null,
    arrivalUtc: arrival,
    departureUtc: null,
    passengerCount: 6,
    crewCount: 2,
    lines: [
      {
        serviceCategoryId: byCode.get('fuel')!,
        quantity: 1,
        requirements: { fuelType: 'jet_a', gallons: 2200 },
      },
    ],
  });

  const fuelOffer = await dispatchNextOffer(accepted.lineIds[0]!, { evaluationNow: now });
  if (fuelOffer.offer !== null) {
    const dispatcher = await dispatcherFor(fuelOffer.offer.providerCompanyId);
    await acknowledgeOffer({
      offerId: fuelOffer.offer.id,
      actorUserId: dispatcher.id,
      actorRole: dispatcher.role,
      actorLabel: dispatcher.email,
      providerCompanyId: fuelOffer.offer.providerCompanyId,
      now,
    });
    console.log(
      `[scenarios] ${accepted.request.reference} — accepted by ${dispatcher.email}, awaiting resources`,
    );
  }

  // --- 3. fully covered ----------------------------------------------------
  const covered = await createRequest({
    clientOrganizationId: client.id,
    createdByUserId: null,
    createdVia: 'ops',
    sourceSentence: 'Scenario: one car meeting an evening arrival at Teterboro.',
    airportId: kteb.id,
    fboId: null,
    aircraftId: null,
    // 22:00 local, comfortably inside the overnight driver shift.
    arrivalUtc: new Date(arrival.getTime() - 5 * 3_600_000),
    departureUtc: null,
    passengerCount: 3,
    crewCount: 2,
    lines: [
      {
        serviceCategoryId: byCode.get('ground_transport')!,
        quantity: 1,
        requirements: { vehicleClass: 'suv', passengers: 3 },
      },
    ],
  });

  const carOffer = await dispatchNextOffer(covered.lineIds[0]!, { evaluationNow: now });
  if (carOffer.offer !== null) {
    const dispatcher = await dispatcherFor(carOffer.offer.providerCompanyId);
    await acknowledgeOffer({
      offerId: carOffer.offer.id,
      actorUserId: dispatcher.id,
      actorRole: dispatcher.role,
      actorLabel: dispatcher.email,
      providerCompanyId: carOffer.offer.providerCompanyId,
      now,
    });

    const { vehicles, drivers } = await import('@/db/schema');
    const [vehicle] = await db
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(eq(vehicles.providerCompanyId, carOffer.offer.providerCompanyId))
      .limit(1);
    const [driver] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.providerCompanyId, carOffer.offer.providerCompanyId))
      .limit(1);

    const start = new Date(arrival.getTime() - 5 * 3_600_000);
    if (vehicle !== undefined && driver !== undefined) {
      await createAssignment({
        requestServiceLineId: covered.lineIds[0]!,
        providerCompanyId: carOffer.offer.providerCompanyId,
        actorUserId: dispatcher.id,
        actorRole: dispatcher.role,
        actorLabel: dispatcher.email,
        startUtc: start,
        endUtc: new Date(start.getTime() + 3 * 3_600_000),
        resources: [
          { kind: 'vehicle', resourceId: vehicle.id },
          { kind: 'driver', resourceId: driver.id },
        ],
      });
      console.log(`[scenarios] ${covered.request.reference} — fully covered with a car and driver`);
    }
  }

  console.log('\n[scenarios] done. Sign in as a provider to see the queue and the schedule.');
  if (waitingOffer.offer !== null) {
    const dispatcher = await dispatcherFor(waitingOffer.offer.providerCompanyId);
    console.log(`[scenarios] the waiting offer is with: ${dispatcher.email}`);
  }
}

async function dispatcherFor(providerCompanyId: string) {
  const [user] = await getDb()
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.providerCompanyId, providerCompanyId))
    .limit(1);

  if (user === undefined) {
    throw new Error(`No user account exists for provider company ${providerCompanyId}`);
  }
  return user;
}

/** The next 03:00 America/New_York, as a UTC instant. */
function nextLocal0300(): Date {
  const now = new Date();
  // 03:00 EDT is 07:00Z; EST would be 08:00Z. Resolving properly through the time module
  // would need a wall-time input, and this script only needs "soon and in the future".
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 7, 0, 0, 0),
  );
  return candidate;
}

try {
  await main();
  await closePool();
  process.exit(0);
} catch (error) {
  console.error('[scenarios] failed');
  console.error(error);
  await closePool();
  process.exit(1);
}
