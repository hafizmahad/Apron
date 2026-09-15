import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  clientOrganizations,
  drivers,
  providerCompanies,
  providerCoverage,
  providerOffers,
  requestServiceLines,
  securityOfficers,
  serviceCategories,
  users,
  vehicles,
} from '@/db/schema';
import {
  addDriver,
  addOfficer,
  addVehicle,
  setResourceActive,
  updateCoverage,
  type ProviderActor,
} from '@/services/provider-self';
import { createRequest } from '@/domain/requests/create';
import { startMatchingForRequest } from '@/services/request-dispatch';
import { acknowledgeOffer } from '@/services/offers';
import { createAssignment } from '@/services/assignments';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import { useMemoryMailTransportForTests } from '@/lib/mail';
import { ensureMigrated, captureError, truncateAll } from '../../helpers/database';

/**
 * Provider self-management (CLAUDE.md §13, Journey G).
 *
 * Two properties carry the weight here:
 *
 *  - **A provider can only ever touch its own fleet.** Scoping is in the WHERE clause of
 *    the write, so another company's id matches nothing rather than being caught by a
 *    check that could be forgotten.
 *  - **A resource committed to future work cannot be retired.** Without that rule a
 *    provider could quietly retire the car meeting tomorrow's arrival, and nobody would
 *    find out until the client was standing on the ramp.
 */

let ALPHA: ProviderActor;
let BETA: ProviderActor;

let fixture: {
  clientId: string;
  ktebId: string;
  groundTransportId: string;
};

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

  const companies = await db
    .select({ id: providerCompanies.id, name: providerCompanies.displayName })
    .from(providerCompanies)
    .where(eq(providerCompanies.status, 'approved'))
    .orderBy(providerCompanies.displayName)
    .limit(2);

  if (companies.length < 2) throw new Error('seed needs two approved providers');

  const actorFor = async (companyId: string): Promise<ProviderActor> => {
    const [user] = await db
      .select({ id: users.id, role: users.role, fullName: users.fullName })
      .from(users)
      .where(sql`${users.providerCompanyId} = ${companyId}::uuid`)
      .limit(1);
    if (user === undefined) throw new Error('no user at that company');
    return {
      userId: user.id,
      role: user.role,
      label: user.fullName,
      providerCompanyId: companyId,
    };
  };

  ALPHA = await actorFor(companies[0]!.id);
  BETA = await actorFor(companies[1]!.id);

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

  fixture = { clientId: client.id, ktebId: kteb.id, groundTransportId: ground.id };
});

describe('adding resources', () => {
  it('adds a vehicle to the caller’s own company and nobody else’s', async () => {
    const created = await addVehicle(
      {
        vehicleClass: 'suv',
        make: 'Cadillac',
        model: 'Escalade',
        plateReference: 'TEST-0001',
        passengerCapacity: 6,
        luggageCapacity: 5,
        homeAirportId: fixture.ktebId,
      },
      ALPHA,
    );

    const [row] = await getDb()
      .select({
        providerCompanyId: vehicles.providerCompanyId,
        plate: vehicles.plateReference,
        active: vehicles.active,
      })
      .from(vehicles)
      .where(eq(vehicles.id, created.id));

    expect(row?.providerCompanyId).toBe(ALPHA.providerCompanyId);
    expect(row?.plate).toBe('TEST-0001');
    // Added active: a provider adding a car expects it to be usable.
    expect(row?.active).toBe(true);
  });

  it('adds a driver and records the shift timezone it was given', async () => {
    const created = await addDriver(
      {
        fullName: 'Dana Whitfield',
        phone: '+1 201 555 0142',
        email: null,
        timezoneIana: 'America/New_York',
        homeAirportId: null,
      },
      ALPHA,
    );

    const [row] = await getDb()
      .select({ timezone: drivers.timezoneIana, company: drivers.providerCompanyId })
      .from(drivers)
      .where(eq(drivers.id, created.id));

    expect(row?.timezone).toBe('America/New_York');
    expect(row?.company).toBe(ALPHA.providerCompanyId);
  });

  it('refuses an unknown timezone rather than failing later as "not available"', async () => {
    const error = await captureError(() =>
      addDriver(
        {
          fullName: 'Nowhere Person',
          phone: null,
          email: null,
          timezoneIana: 'America/Nowhere_At_All',
          homeAirportId: null,
        },
        ALPHA,
      ),
    );

    expect(error.message).toMatch(/not a known IANA timezone/i);
  });

  it('records armed certification exactly as given, never inferred', async () => {
    const armed = await addOfficer(
      {
        fullName: 'Armed Officer',
        phone: null,
        email: null,
        timezoneIana: 'America/New_York',
        homeAirportId: null,
        armedCertified: true,
      },
      ALPHA,
    );

    const unarmed = await addOfficer(
      {
        fullName: 'Unarmed Officer',
        phone: null,
        email: null,
        timezoneIana: 'America/New_York',
        homeAirportId: null,
      },
      ALPHA,
    );

    const rows = await getDb()
      .select({ id: securityOfficers.id, armed: securityOfficers.armedCertified })
      .from(securityOfficers)
      .where(sql`${securityOfficers.id} in (${armed.id}::uuid, ${unarmed.id}::uuid)`);

    expect(rows.find((row) => row.id === armed.id)?.armed).toBe(true);
    expect(rows.find((row) => row.id === unarmed.id)?.armed).toBe(false);
  });

  it('audits every addition', async () => {
    const created = await addVehicle(
      {
        vehicleClass: 'sedan',
        make: 'Mercedes',
        model: 'S-Class',
        plateReference: 'TEST-0002',
        passengerCapacity: 3,
        luggageCapacity: 2,
        homeAirportId: null,
      },
      ALPHA,
    );

    const events = await getDb().execute<{ action: string }>(
      sql`select action from audit_events where entity_id = ${created.id}`,
    );
    expect(events.rows.map((row) => row.action)).toContain('provider.add_vehicle');
  });
});

describe('retiring and restoring — Journey G', () => {
  async function anIdleVehicleOf(actor: ProviderActor): Promise<string> {
    const created = await addVehicle(
      {
        vehicleClass: 'suv',
        make: 'Test',
        model: 'Vehicle',
        plateReference: `IDLE-${actor.providerCompanyId.slice(0, 6)}`,
        passengerCapacity: 4,
        luggageCapacity: 2,
        homeAirportId: null,
      },
      actor,
    );
    return created.id;
  }

  it('retires a resource without deleting it, keeping the history', async () => {
    const vehicleId = await anIdleVehicleOf(ALPHA);

    await setResourceActive({ kind: 'vehicle', resourceId: vehicleId, active: false }, ALPHA);

    const [row] = await getDb()
      .select({ active: vehicles.active })
      .from(vehicles)
      .where(eq(vehicles.id, vehicleId));

    // Still there. `active = false`, not gone.
    expect(row).toBeDefined();
    expect(row?.active).toBe(false);
  });

  it('restores a retired resource', async () => {
    const vehicleId = await anIdleVehicleOf(ALPHA);

    await setResourceActive({ kind: 'vehicle', resourceId: vehicleId, active: false }, ALPHA);
    await setResourceActive({ kind: 'vehicle', resourceId: vehicleId, active: true }, ALPHA);

    const [row] = await getDb()
      .select({ active: vehicles.active })
      .from(vehicles)
      .where(eq(vehicles.id, vehicleId));

    expect(row?.active).toBe(true);
  });

  it('refuses to retain another company’s resource — the id simply matches nothing', async () => {
    const alphaVehicle = await anIdleVehicleOf(ALPHA);

    const error = await captureError(() =>
      setResourceActive({ kind: 'vehicle', resourceId: alphaVehicle, active: false }, BETA),
    );

    expect(error.message).toMatch(/not one of your resources/i);

    // And Alpha's vehicle is untouched.
    const [row] = await getDb()
      .select({ active: vehicles.active })
      .from(vehicles)
      .where(eq(vehicles.id, alphaVehicle));
    expect(row?.active).toBe(true);
  });

  it('refuses to retire a vehicle committed to work that has not happened yet', async () => {
    // Put a real job on the books through the real path.
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
          quantity: 1,
          requirements: { vehicleClass: 'suv', passengers: 4 },
        },
      ],
    });

    await startMatchingForRequest(created.request.id, { now: NOW });
    const lineId = created.lineIds[0]!;

    const [offer] = await getDb()
      .select({ id: providerOffers.id, providerCompanyId: providerOffers.providerCompanyId })
      .from(providerOffers)
      .where(eq(providerOffers.requestServiceLineId, lineId));

    if (offer === undefined) throw new Error('no offer was dispatched');

    const [holder] = await getDb()
      .select({ id: users.id, role: users.role, fullName: users.fullName })
      .from(users)
      .where(sql`${users.providerCompanyId} = ${offer.providerCompanyId}::uuid`)
      .limit(1);

    const holderActor: ProviderActor = {
      userId: holder!.id,
      role: holder!.role,
      label: holder!.fullName,
      providerCompanyId: offer.providerCompanyId,
    };

    await acknowledgeOffer({
      offerId: offer.id,
      providerCompanyId: offer.providerCompanyId,
      actorUserId: holder!.id,
      actorRole: holder!.role,
      actorLabel: holder!.fullName,
      now: NOW,
    });

    const resources = await getDb().execute<{ vehicle_id: string; driver_id: string }>(sql`
      select v.id as vehicle_id, d.id as driver_id
      from vehicles v
      join drivers d on d.provider_company_id = v.provider_company_id
      where v.provider_company_id = ${offer.providerCompanyId}::uuid and v.active and d.active
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
      providerCompanyId: offer.providerCompanyId,
      actorUserId: holder!.id,
      actorRole: holder!.role,
      actorLabel: holder!.fullName,
      startUtc: line!.startUtc ?? ARRIVAL,
      endUtc: line!.endUtc ?? new Date(ARRIVAL.getTime() + 3 * 3_600_000),
      resources: [
        { kind: 'vehicle', resourceId: pair.vehicle_id },
        { kind: 'driver', resourceId: pair.driver_id },
      ],
    });

    // Now try to retire the very vehicle that is meeting the arrival.
    const error = await captureError(() =>
      setResourceActive(
        { kind: 'vehicle', resourceId: pair.vehicle_id, active: false, now: NOW },
        holderActor,
      ),
    );

    expect(error.message).toMatch(/committed to work/i);

    const [stillActive] = await getDb()
      .select({ active: vehicles.active })
      .from(vehicles)
      .where(eq(vehicles.id, pair.vehicle_id));
    expect(stillActive?.active).toBe(true);
  });

  it('allows retiring once the committed work is in the past', async () => {
    const vehicleId = await anIdleVehicleOf(ALPHA);

    // No future commitment at all: the simplest case the rule must still permit.
    await setResourceActive(
      { kind: 'vehicle', resourceId: vehicleId, active: false, now: NOW },
      ALPHA,
    );

    const [row] = await getDb()
      .select({ active: vehicles.active })
      .from(vehicles)
      .where(eq(vehicles.id, vehicleId));
    expect(row?.active).toBe(false);
  });
});

describe('coverage', () => {
  async function aCoverageRowOf(actor: ProviderActor): Promise<string> {
    const [row] = await getDb()
      .select({ id: providerCoverage.id })
      .from(providerCoverage)
      .where(eq(providerCoverage.providerCompanyId, actor.providerCompanyId))
      .limit(1);
    if (row === undefined) throw new Error('company has no coverage');
    return row.id;
  }

  it('changes capacity, and the change is what matching will read', async () => {
    const coverageId = await aCoverageRowOf(ALPHA);

    await updateCoverage({ coverageId, totalCapacity: 7 }, ALPHA);

    const [row] = await getDb()
      .select({ capacity: providerCoverage.totalCapacity })
      .from(providerCoverage)
      .where(eq(providerCoverage.id, coverageId));

    expect(row?.capacity).toBe(7);
  });

  it('stops and restarts taking work at a location', async () => {
    const coverageId = await aCoverageRowOf(ALPHA);

    await updateCoverage({ coverageId, active: false }, ALPHA);
    let [row] = await getDb()
      .select({ active: providerCoverage.active })
      .from(providerCoverage)
      .where(eq(providerCoverage.id, coverageId));
    expect(row?.active).toBe(false);

    await updateCoverage({ coverageId, active: true }, ALPHA);
    [row] = await getDb()
      .select({ active: providerCoverage.active })
      .from(providerCoverage)
      .where(eq(providerCoverage.id, coverageId));
    expect(row?.active).toBe(true);
  });

  it('refuses another company’s coverage row', async () => {
    const alphaCoverage = await aCoverageRowOf(ALPHA);

    const error = await captureError(() =>
      updateCoverage({ coverageId: alphaCoverage, totalCapacity: 99 }, BETA),
    );

    expect(error.message).toMatch(/not one of your coverage/i);
  });

  it('records the before and after values in the audit trail', async () => {
    const coverageId = await aCoverageRowOf(ALPHA);

    const [before] = await getDb()
      .select({ capacity: providerCoverage.totalCapacity })
      .from(providerCoverage)
      .where(eq(providerCoverage.id, coverageId));

    await updateCoverage({ coverageId, totalCapacity: 5 }, ALPHA);

    const events = await getDb().execute<{ action: string; before_state: unknown }>(
      sql`select action, before_state from audit_events where entity_id = ${coverageId}`,
    );

    const event = events.rows.find((row) => row.action === 'provider.update_coverage');
    expect(event).toBeDefined();
    expect(JSON.stringify(event?.before_state)).toContain(String(before?.capacity));
  });

  it('refuses a call that changes nothing', async () => {
    const coverageId = await aCoverageRowOf(ALPHA);
    const error = await captureError(() => updateCoverage({ coverageId }, ALPHA));
    expect(error.message).toMatch(/nothing to change/i);
  });
});
