import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import * as schema from '@/db/schema';
import {
  captureError,
  databaseMessage,
  ensureMigrated,
  sqlState,
  truncateAll,
  violatedConstraint,
  withTwoSessions,
} from '../../helpers/database';

/**
 * The integrity guarantees the product depends on must be enforced by PostgreSQL, not by
 * the services that happen to call it (ADR-002, CLAUDE.md §30: "Do not rely on frontend
 * disabling a button for correctness").
 *
 * Every test here bypasses the application layer entirely and writes straight to the
 * database — which is the point. If a constraint only holds because a service checks it
 * first, these tests fail.
 */

/** Postgres SQLSTATEs used below. */
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const EXCLUSION_VIOLATION = '23P01';
const FOREIGN_KEY_VIOLATION = '23503';

interface Fixture {
  readonly clientId: string;
  readonly airportId: string;
  readonly otherAirportId: string;
  readonly fboId: string;
  readonly otherAirportFboId: string;
  readonly serviceId: string;
  readonly providerId: string;
  readonly vehicleId: string;
  readonly secondVehicleId: string;
  readonly driverId: string;
  readonly officerId: string;
  readonly hangarId: string;
  readonly hotelRoomTypeId: string;
}

let fixture: Fixture;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fixture = await buildFixture();
});

describe('exclusion constraints — a resource cannot be double-booked', () => {
  it('rejects two overlapping live commitments of the same vehicle', async () => {
    const assignmentId = await createAssignment('07:00', '12:00');
    await commitResource(assignmentId, 'vehicle', fixture.vehicleId, '07:00', '10:00');

    const error = await captureError(async () =>
      commitResource(assignmentId, 'vehicle', fixture.vehicleId, '09:59', '11:00'),
    );

    expect(sqlState(error)).toBe(EXCLUSION_VIOLATION);
    expect(violatedConstraint(error)).toBe('assignment_resources_vehicle_no_overlap');
  });

  it('allows a back-to-back handover at the exact boundary', async () => {
    const assignmentId = await createAssignment('07:00', '14:00');
    await commitResource(assignmentId, 'vehicle', fixture.vehicleId, '07:00', '10:00');

    // Half-open `[start, end)`: a car finishing at 10:00 is free at 10:00.
    await expect(
      commitResource(assignmentId, 'vehicle', fixture.vehicleId, '10:00', '12:00'),
    ).resolves.toBeTypeOf('string');
  });

  it('rejects overlapping commitments of the same driver', async () => {
    const assignmentId = await createAssignment('07:00', '12:00');
    await commitResource(assignmentId, 'driver', fixture.driverId, '07:00', '10:00');

    const error = await captureError(async () =>
      commitResource(assignmentId, 'driver', fixture.driverId, '08:00', '09:00'),
    );
    expect(violatedConstraint(error)).toBe('assignment_resources_driver_no_overlap');
  });

  it('rejects overlapping commitments of the same officer', async () => {
    const assignmentId = await createAssignment('07:00', '12:00');
    await commitResource(assignmentId, 'officer', fixture.officerId, '07:00', '10:00');

    const error = await captureError(async () =>
      commitResource(assignmentId, 'officer', fixture.officerId, '06:00', '08:00'),
    );
    expect(violatedConstraint(error)).toBe('assignment_resources_officer_no_overlap');
  });

  it('rejects overlapping commitments of the same hangar bay', async () => {
    const assignmentId = await createAssignment('07:00', '23:00');
    await commitResource(assignmentId, 'hangar', fixture.hangarId, '18:00', '23:00');

    const error = await captureError(async () =>
      commitResource(assignmentId, 'hangar', fixture.hangarId, '20:00', '22:00'),
    );
    expect(violatedConstraint(error)).toBe('assignment_resources_hangar_no_overlap');
  });

  it('does not constrain two different vehicles over the same window', async () => {
    const assignmentId = await createAssignment('07:00', '12:00');
    await commitResource(assignmentId, 'vehicle', fixture.vehicleId, '07:00', '10:00');
    await expect(
      commitResource(assignmentId, 'vehicle', fixture.secondVehicleId, '07:00', '10:00'),
    ).resolves.toBeTypeOf('string');
  });

  it('frees the resource once a commitment is released', async () => {
    const assignmentId = await createAssignment('07:00', '12:00');
    const resourceId = await commitResource(assignmentId, 'vehicle', fixture.vehicleId, '07:00', '10:00');

    await getDb().execute(sql`
      update assignment_resources
      set released = true, released_at = now()
      where id = ${resourceId}::uuid
    `);

    // The released row stays for the audit trail but no longer blocks the vehicle.
    await expect(
      commitResource(assignmentId, 'vehicle', fixture.vehicleId, '08:00', '09:00'),
    ).resolves.toBeTypeOf('string');
  });

  it('permits concurrent pooled hotel-room rows, which are capacity not objects', async () => {
    const assignmentId = await createAssignment('07:00', '32:00');
    await commitResource(assignmentId, 'hotel_room', fixture.hotelRoomTypeId, '18:00', '30:00');
    // Two overlapping room commitments are legitimate — the pool limit is enforced in the
    // assignment transaction, not by an exclusion constraint.
    await expect(
      commitResource(assignmentId, 'hotel_room', fixture.hotelRoomTypeId, '18:00', '30:00'),
    ).resolves.toBeTypeOf('string');
  });
});

describe('exclusion constraints under genuine concurrency', () => {
  it('lets exactly one of two racing transactions commit the same vehicle', async () => {
    const assignmentId = await createAssignment('07:00', '12:00');

    const outcome = await withTwoSessions(async (first, second) => {
      await first.query('begin');
      await second.query('begin');

      const statement = `
        insert into assignment_resources
          (assignment_id, resource_kind, vehicle_id, start_utc, end_utc)
        values ($1, 'vehicle', $2, $3, $4)
      `;
      const window = [instant('08:00'), instant('11:00')];

      await first.query(statement, [assignmentId, fixture.vehicleId, ...window]);

      // The second session blocks on the exclusion constraint until the first commits,
      // so this promise must not be awaited before the commit below.
      const blocked = second.query(statement, [assignmentId, fixture.vehicleId, ...window]);

      await first.query('commit');

      let secondFailed = false;
      try {
        await blocked;
      } catch (error) {
        secondFailed = sqlState(error) === EXCLUSION_VIOLATION;
      }
      await second.query('rollback').catch(() => undefined);
      return secondFailed;
    });

    expect(outcome).toBe(true);

    const rows = await getDb().execute<{ count: string }>(sql`
      select count(*)::text as count from assignment_resources where released = false
    `);
    expect(Number(rows.rows[0]?.count)).toBe(1);
  });
});

describe('resource-kind integrity', () => {
  it('rejects a row whose kind does not match the foreign key that is set', async () => {
    const assignmentId = await createAssignment('07:00', '12:00');
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into assignment_resources (assignment_id, resource_kind, driver_id, start_utc, end_utc)
        values (${assignmentId}::uuid, 'vehicle', ${fixture.driverId}::uuid,
                ${instant('07:00')}::timestamptz, ${instant('10:00')}::timestamptz)
      `),
    );
    expect(sqlState(error)).toBe(CHECK_VIOLATION);
    expect(violatedConstraint(error)).toBe('assignment_resources_kind_matches_reference');
  });

  it('rejects a row that sets two resource references at once', async () => {
    const assignmentId = await createAssignment('07:00', '12:00');
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into assignment_resources
          (assignment_id, resource_kind, vehicle_id, driver_id, start_utc, end_utc)
        values (${assignmentId}::uuid, 'vehicle', ${fixture.vehicleId}::uuid, ${fixture.driverId}::uuid,
                ${instant('07:00')}::timestamptz, ${instant('10:00')}::timestamptz)
      `),
    );
    expect(violatedConstraint(error)).toBe('assignment_resources_kind_matches_reference');
  });

  it('rejects an inverted or zero-length window', async () => {
    const assignmentId = await createAssignment('07:00', '12:00');
    for (const [start, end] of [
      ['10:00', '07:00'],
      ['10:00', '10:00'],
    ] as const) {
      const error = await captureError(async () =>
        commitResource(assignmentId, 'vehicle', fixture.vehicleId, start, end),
      );
      expect(violatedConstraint(error)).toBe('assignment_resources_window_ordered');
    }
  });
});

describe('tenancy constraints on users', () => {
  it('rejects a provider user with no provider company', async () => {
    const error = await captureError(async () =>
      insertUser({ role: 'provider_dispatcher', providerCompanyId: null, clientOrganizationId: null }),
    );
    expect(violatedConstraint(error)).toBe('users_provider_tenancy');
  });

  it('rejects an operations user scoped to a provider company', async () => {
    const error = await captureError(async () =>
      insertUser({
        role: 'operations_agent',
        providerCompanyId: fixture.providerId,
        clientOrganizationId: null,
      }),
    );
    expect(violatedConstraint(error)).toBe('users_provider_tenancy');
  });

  it('rejects a client user with no client organisation', async () => {
    const error = await captureError(async () =>
      insertUser({ role: 'client', providerCompanyId: null, clientOrganizationId: null }),
    );
    expect(violatedConstraint(error)).toBe('users_client_tenancy');
  });

  it('rejects an unknown role outright', async () => {
    const error = await captureError(async () =>
      insertUser({ role: 'superuser', providerCompanyId: null, clientOrganizationId: null }),
    );
    expect(violatedConstraint(error)).toBe('users_role_known');
  });

  it('treats email as case-insensitive for identity', async () => {
    await insertUser({
      role: 'operations_agent',
      providerCompanyId: null,
      clientOrganizationId: null,
      email: 'Duplicate.Person@apron.local',
    });
    const error = await captureError(async () =>
      insertUser({
        role: 'operations_agent',
        providerCompanyId: null,
        clientOrganizationId: null,
        email: 'duplicate.person@apron.local',
      }),
    );
    expect(sqlState(error)).toBe(UNIQUE_VIOLATION);
  });
});

describe('coverage constraints', () => {
  it('rejects fbo scope with no FBO', async () => {
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into provider_coverage
          (provider_company_id, service_category_id, scope, airport_id, total_capacity, lead_time_minutes)
        values (${fixture.providerId}::uuid, ${fixture.serviceId}::uuid, 'fbo',
                ${fixture.airportId}::uuid, 2, 120)
      `),
    );
    expect(violatedConstraint(error)).toBe('provider_coverage_scope_consistent');
  });

  it('rejects airport scope that names an FBO', async () => {
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into provider_coverage
          (provider_company_id, service_category_id, scope, airport_id, fbo_id, total_capacity, lead_time_minutes)
        values (${fixture.providerId}::uuid, ${fixture.serviceId}::uuid, 'airport',
                ${fixture.airportId}::uuid, ${fixture.fboId}::uuid, 2, 120)
      `),
    );
    expect(violatedConstraint(error)).toBe('provider_coverage_scope_consistent');
  });

  it('requires an airport — there is no way to express "everywhere"', async () => {
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into provider_coverage
          (provider_company_id, service_category_id, scope, airport_id, total_capacity, lead_time_minutes)
        values (${fixture.providerId}::uuid, ${fixture.serviceId}::uuid, 'airport', null, 2, 120)
      `),
    );
    // A NOT NULL violation, which is exactly the intent of CLAUDE.md §6.
    expect(sqlState(error)).toBe('23502');
  });

  it('rejects a duplicate coverage row for the same provider/service/airport', async () => {
    await getDb().execute(sql`
      insert into provider_coverage
        (provider_company_id, service_category_id, scope, airport_id, total_capacity, lead_time_minutes)
      values (${fixture.providerId}::uuid, ${fixture.serviceId}::uuid, 'airport',
              ${fixture.airportId}::uuid, 2, 120)
    `);
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into provider_coverage
          (provider_company_id, service_category_id, scope, airport_id, total_capacity, lead_time_minutes)
        values (${fixture.providerId}::uuid, ${fixture.serviceId}::uuid, 'airport',
                ${fixture.airportId}::uuid, 5, 60)
      `),
    );
    expect(sqlState(error)).toBe(UNIQUE_VIOLATION);
  });
});

describe('request constraints', () => {
  it('rejects an FBO belonging to a different airport', async () => {
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into requests
          (reference, client_organization_id, airport_id, fbo_id, arrival_utc, status)
        values ('RQ-XAIR01', ${fixture.clientId}::uuid, ${fixture.airportId}::uuid,
                ${fixture.otherAirportFboId}::uuid, ${instant('07:00')}::timestamptz, 'sourcing')
      `),
    );
    expect(sqlState(error)).toBe(CHECK_VIOLATION);
    expect(databaseMessage(error)).toMatch(/belongs to airport/i);
  });

  it('accepts an FBO that belongs to the request airport', async () => {
    await expect(
      getDb().execute(sql`
        insert into requests
          (reference, client_organization_id, airport_id, fbo_id, arrival_utc, status)
        values ('RQ-OKAIR1', ${fixture.clientId}::uuid, ${fixture.airportId}::uuid,
                ${fixture.fboId}::uuid, ${instant('07:00')}::timestamptz, 'sourcing')
      `),
    ).resolves.toBeDefined();
  });

  it('rejects a departure before its arrival', async () => {
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into requests
          (reference, client_organization_id, airport_id, arrival_utc, departure_utc, status)
        values ('RQ-BADWIN', ${fixture.clientId}::uuid, ${fixture.airportId}::uuid,
                ${instant('12:00')}::timestamptz, ${instant('07:00')}::timestamptz, 'sourcing')
      `),
    );
    expect(violatedConstraint(error)).toBe('requests_window_ordered');
  });

  it('rejects a malformed reference', async () => {
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into requests (reference, client_organization_id, airport_id, arrival_utc, status)
        values ('nonsense', ${fixture.clientId}::uuid, ${fixture.airportId}::uuid,
                ${instant('07:00')}::timestamptz, 'sourcing')
      `),
    );
    expect(violatedConstraint(error)).toBe('requests_reference_format');
  });

  it('requires a cancellation reason when cancelling', async () => {
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into requests (reference, client_organization_id, airport_id, arrival_utc, status)
        values ('RQ-NOREAS', ${fixture.clientId}::uuid, ${fixture.airportId}::uuid,
                ${instant('07:00')}::timestamptz, 'cancelled')
      `),
    );
    expect(violatedConstraint(error)).toBe('requests_cancellation_reason_required');
  });
});

describe('offer constraints', () => {
  it('permits only one live offer per service line', async () => {
    const lineId = await createServiceLine();
    await createOffer(lineId, 1);

    const error = await captureError(async () => createOffer(lineId, 2));
    expect(sqlState(error)).toBe(UNIQUE_VIOLATION);
    expect(databaseMessage(error)).toMatch(/provider_offers_one_live_per_line/);
  });

  it('permits a new offer once the previous one is no longer live', async () => {
    const lineId = await createServiceLine();
    const firstOfferId = await createOffer(lineId, 1);

    await getDb().execute(sql`
      update provider_offers
      set status = 'declined', declined_at = now(), decline_reason = 'No vehicles available'
      where id = ${firstOfferId}::uuid
    `);

    await expect(createOffer(lineId, 2)).resolves.toBeTypeOf('string');
  });

  it('requires a decline reason on a declined offer', async () => {
    const lineId = await createServiceLine();
    const offerId = await createOffer(lineId, 1);
    const error = await captureError(async () =>
      getDb().execute(sql`
        update provider_offers set status = 'declined', declined_at = now()
        where id = ${offerId}::uuid
      `),
    );
    expect(violatedConstraint(error)).toBe('provider_offers_decline_reason_required');
  });

  it('requires a timestamp on every terminal offer state', async () => {
    const lineId = await createServiceLine();
    const offerId = await createOffer(lineId, 1);
    const error = await captureError(async () =>
      getDb().execute(sql`
        update provider_offers set status = 'expired' where id = ${offerId}::uuid
      `),
    );
    expect(violatedConstraint(error)).toBe('provider_offers_terminal_timestamps');
  });
});

describe('audit constraints', () => {
  it('requires a reason on an override', async () => {
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into audit_events (action, entity_type, entity_id)
        values ('request_line.override_provider', 'request_service_line', 'abc')
      `),
    );
    expect(violatedConstraint(error)).toBe('audit_events_reason_required');
  });

  it('accepts an override that carries a reason', async () => {
    await expect(
      getDb().execute(sql`
        insert into audit_events (action, entity_type, entity_id, reason)
        values ('request_line.override_provider', 'request_service_line', 'abc',
                'Client requested a specific operator by name.')
      `),
    ).resolves.toBeDefined();
  });

  it('does not demand a reason for ordinary actions', async () => {
    await expect(
      getDb().execute(sql`
        insert into audit_events (action, entity_type, entity_id)
        values ('request.create', 'request', 'abc')
      `),
    ).resolves.toBeDefined();
  });
});

describe('quote arithmetic is checked by the database', () => {
  it('rejects a total that does not equal subtotal plus fee', async () => {
    const requestId = await createRequest();
    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into quotes (request_id, subtotal_minor, platform_fee_minor, total_minor)
        values (${requestId}::uuid, 100000, 7500, 999999)
      `),
    );
    expect(violatedConstraint(error)).toBe('quotes_total_consistent');
  });

  it('rejects a line amount that is not quantity times unit', async () => {
    const requestId = await createRequest();
    const rows = await getDb().execute<{ id: string }>(sql`
      insert into quotes (request_id, subtotal_minor, platform_fee_minor, total_minor)
      values (${requestId}::uuid, 0, 0, 0)
      returning id
    `);
    const quoteId = rows.rows[0]?.id;
    expect(quoteId).toBeDefined();

    const error = await captureError(async () =>
      getDb().execute(sql`
        insert into quote_lines (quote_id, label, quantity, unit_amount_minor, amount_minor)
        values (${quoteId}::uuid, 'Two SUVs', 2, 45000, 45000)
      `),
    );
    expect(violatedConstraint(error)).toBe('quote_lines_amount_consistent');
  });
});

describe('referential integrity', () => {
  it('refuses to delete an airport that requests still reference', async () => {
    await createRequest();
    const error = await captureError(async () =>
      getDb().execute(sql`delete from airports where id = ${fixture.airportId}::uuid`),
    );
    expect(sqlState(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('cascades service lines when a request is deleted', async () => {
    const lineId = await createServiceLine();
    await getDb().execute(sql`delete from requests where reference = 'RQ-FIXTUR'`);

    const rows = await getDb().execute<{ count: string }>(sql`
      select count(*)::text as count from request_service_lines where id = ${lineId}::uuid
    `);
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fixture construction
// ---------------------------------------------------------------------------

/** All test instants sit on 2026-09-18 UTC; hours past 24 roll into the next day. */
function instant(hhmm: string): string {
  const [rawHour, rawMinute] = hhmm.split(':');
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const base = Date.UTC(2026, 8, 18, 0, 0, 0, 0);
  return new Date(base + hour * 3_600_000 + minute * 60_000).toISOString();
}

async function scalar(statement: ReturnType<typeof sql>): Promise<string> {
  const result = await getDb().execute<{ id: string }>(statement);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('expected the statement to return an id');
  return id;
}

async function buildFixture(): Promise<Fixture> {
  const db = getDb();

  const [client] = await db
    .insert(schema.clientOrganizations)
    .values({ slug: 'fixture-client', name: 'Fixture Client Group' })
    .returning({ id: schema.clientOrganizations.id });

  const [airport] = await db
    .insert(schema.airports)
    .values({
      icao: 'KTST',
      iata: 'TST',
      name: 'Fixture Field',
      city: 'Fixtureville',
      countryCode: 'US',
      latitude: '40.850101',
      longitude: '-74.060799',
      timezoneIana: 'America/New_York',
    })
    .returning({ id: schema.airports.id });

  const [otherAirport] = await db
    .insert(schema.airports)
    .values({
      icao: 'KOTH',
      iata: 'OTH',
      name: 'Other Field',
      city: 'Elsewhere',
      countryCode: 'US',
      latitude: '34.209801',
      longitude: '-118.489998',
      timezoneIana: 'America/Los_Angeles',
    })
    .returning({ id: schema.airports.id });

  if (client === undefined || airport === undefined || otherAirport === undefined) {
    throw new Error('fixture inserts did not return ids');
  }

  const [fbo] = await db
    .insert(schema.fbos)
    .values({ airportId: airport.id, name: 'Fixture Handling' })
    .returning({ id: schema.fbos.id });

  const [otherFbo] = await db
    .insert(schema.fbos)
    .values({ airportId: otherAirport.id, name: 'Other Handling' })
    .returning({ id: schema.fbos.id });

  const [service] = await db
    .insert(schema.serviceCategories)
    .values({
      code: 'ground_transport',
      name: 'Ground transport',
      unitLabel: 'vehicle',
      assignmentStrategy: 'vehicle_with_driver',
      configSchemaJson: { fields: [] },
    })
    .returning({ id: schema.serviceCategories.id });

  const [provider] = await db
    .insert(schema.providerCompanies)
    .values({
      slug: 'fixture-provider',
      legalName: 'Fixture Transport LLC',
      displayName: 'Fixture Transport',
      status: 'approved',
      approvedAt: new Date(),
      rank: 100,
    })
    .returning({ id: schema.providerCompanies.id });

  if (fbo === undefined || otherFbo === undefined || service === undefined || provider === undefined) {
    throw new Error('fixture inserts did not return ids');
  }

  const [vehicle] = await db
    .insert(schema.vehicles)
    .values({
      providerCompanyId: provider.id,
      vehicleClass: 'suv',
      make: 'Cadillac',
      model: 'Escalade ESV',
      plateReference: 'FIX-001',
      passengerCapacity: 6,
      luggageCapacity: 6,
    })
    .returning({ id: schema.vehicles.id });

  const [secondVehicle] = await db
    .insert(schema.vehicles)
    .values({
      providerCompanyId: provider.id,
      vehicleClass: 'suv',
      make: 'Lincoln',
      model: 'Navigator',
      plateReference: 'FIX-002',
      passengerCapacity: 6,
      luggageCapacity: 5,
    })
    .returning({ id: schema.vehicles.id });

  const [driver] = await db
    .insert(schema.drivers)
    .values({
      providerCompanyId: provider.id,
      fullName: 'Fixture Driver',
      timezoneIana: 'America/New_York',
    })
    .returning({ id: schema.drivers.id });

  const [officer] = await db
    .insert(schema.securityOfficers)
    .values({
      providerCompanyId: provider.id,
      fullName: 'Fixture Officer',
      timezoneIana: 'America/New_York',
      armedCertified: true,
    })
    .returning({ id: schema.securityOfficers.id });

  const [hangar] = await db
    .insert(schema.hangarResources)
    .values({
      providerCompanyId: provider.id,
      airportId: airport.id,
      name: 'Fixture Bay',
      doorWidthFt: '120.00',
      doorHeightFt: '28.00',
      floorLengthFt: '130.00',
      floorWidthFt: '130.00',
      timezoneIana: 'America/New_York',
    })
    .returning({ id: schema.hangarResources.id });

  const [hotel] = await db
    .insert(schema.hotelProperties)
    .values({
      providerCompanyId: provider.id,
      airportId: airport.id,
      name: 'Fixture Hotel',
      timezoneIana: 'America/New_York',
    })
    .returning({ id: schema.hotelProperties.id });

  if (
    vehicle === undefined ||
    secondVehicle === undefined ||
    driver === undefined ||
    officer === undefined ||
    hangar === undefined ||
    hotel === undefined
  ) {
    throw new Error('fixture inserts did not return ids');
  }

  const [roomType] = await db
    .insert(schema.hotelRoomTypes)
    .values({ hotelPropertyId: hotel.id, code: 'std', name: 'Standard king', totalRooms: 10 })
    .returning({ id: schema.hotelRoomTypes.id });

  if (roomType === undefined) throw new Error('fixture inserts did not return ids');

  return {
    clientId: client.id,
    airportId: airport.id,
    otherAirportId: otherAirport.id,
    fboId: fbo.id,
    otherAirportFboId: otherFbo.id,
    serviceId: service.id,
    providerId: provider.id,
    vehicleId: vehicle.id,
    secondVehicleId: secondVehicle.id,
    driverId: driver.id,
    officerId: officer.id,
    hangarId: hangar.id,
    hotelRoomTypeId: roomType.id,
  };
}

async function createRequest(): Promise<string> {
  return scalar(sql`
    insert into requests (reference, client_organization_id, airport_id, arrival_utc, status, passenger_count)
    values ('RQ-FIXTUR', ${fixture.clientId}::uuid, ${fixture.airportId}::uuid,
            ${instant('07:00')}::timestamptz, 'sourcing', 4)
    on conflict (reference) do update set status = 'sourcing'
    returning id
  `);
}

async function createServiceLine(): Promise<string> {
  const requestId = await createRequest();
  return scalar(sql`
    insert into request_service_lines
      (request_id, service_category_id, requirements_json, service_start_utc, service_end_utc, status)
    values (${requestId}::uuid, ${fixture.serviceId}::uuid, '{}'::jsonb,
            ${instant('07:00')}::timestamptz, ${instant('10:00')}::timestamptz, 'matching')
    returning id
  `);
}

async function createOffer(lineId: string, attempt: number): Promise<string> {
  return scalar(sql`
    insert into provider_offers
      (request_service_line_id, provider_company_id, attempt_number, rank_at_selection,
       eligibility_snapshot, expires_at)
    values (${lineId}::uuid, ${fixture.providerId}::uuid, ${attempt}, 100,
            '{"candidates":[],"engineVersion":"test"}'::jsonb, now() + interval '45 minutes')
    returning id
  `);
}

async function createAssignment(start: string, end: string): Promise<string> {
  const lineId = await createServiceLine();
  return scalar(sql`
    insert into assignments (request_service_line_id, provider_company_id, start_utc, end_utc, status)
    values (${lineId}::uuid, ${fixture.providerId}::uuid,
            ${instant(start)}::timestamptz, ${instant(end)}::timestamptz, 'confirmed')
    returning id
  `);
}

const RESOURCE_COLUMN = {
  vehicle: 'vehicle_id',
  driver: 'driver_id',
  officer: 'officer_id',
  hotel_room: 'hotel_room_type_id',
  hangar: 'hangar_resource_id',
} as const;

async function commitResource(
  assignmentId: string,
  kind: keyof typeof RESOURCE_COLUMN,
  resourceId: string,
  start: string,
  end: string,
): Promise<string> {
  const column = RESOURCE_COLUMN[kind];
  return scalar(sql`
    insert into assignment_resources
      (assignment_id, resource_kind, ${sql.identifier(column)}, start_utc, end_utc)
    values (${assignmentId}::uuid, ${kind}, ${resourceId}::uuid,
            ${instant(start)}::timestamptz, ${instant(end)}::timestamptz)
    returning id
  `);
}

async function insertUser(input: {
  readonly role: string;
  readonly providerCompanyId: string | null;
  readonly clientOrganizationId: string | null;
  readonly email?: string;
}): Promise<string> {
  const email = input.email ?? `fixture.${Math.random().toString(36).slice(2)}@apron.local`;
  return scalar(sql`
    insert into users (email, password_hash, full_name, role, provider_company_id, client_organization_id)
    values (${email}, 'not-a-real-hash', 'Fixture Person', ${input.role},
            ${input.providerCompanyId}::uuid, ${input.clientOrganizationId}::uuid)
    returning id
  `);
}
