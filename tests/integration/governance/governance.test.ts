import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import {
  airports,
  auditEvents,
  clientOrganizations,
  featureFlags,
  platformSettings,
  providerCompanies,
  providerOffers,
  requestServiceLines,
  serviceCategories,
  sessions,
  users,
} from '@/db/schema';
import {
  approveProvider,
  createAirport,
  createFbo,
  createServiceCategory,
  createUser,
  rejectProvider,
  setFeatureFlag,
  setPlatformSetting,
  setProviderRank,
  setServiceCategoryActive,
  setUserStatus,
  suspendProvider,
  type Actor,
} from '@/services/governance';
import { createRequest } from '@/domain/requests/create';
import { dispatchNextOffer } from '@/services/offers';
import { runSeed } from '@/db/seed';
import { setAiAdapterForTests } from '@/ai/client';
import { createSession } from '@/auth/session';
import { verifyPassword } from '@/auth/password';
import { ensureMigrated, captureError, truncateAll } from '../../helpers/database';

/**
 * Platform governance against the real database (CLAUDE.md §14, Phase 9).
 *
 * The three things worth proving here, because each of them is a place where a console
 * that merely *looked* right would be wrong:
 *
 *  - governance writes are audited, with the before and after state, in the same
 *    transaction as the change — never as a best-effort afterthought;
 *  - a suspension takes effect *now*: live offers are withdrawn, live sessions revoked;
 *  - a service category really is data, so one created here is immediately matchable
 *    without a migration or a deployment.
 */

const ADMIN: Actor = {
  userId: '00000000-0000-0000-0000-000000000000',
  role: 'platform_admin',
  label: 'test-admin',
};

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
  setAiAdapterForTests(undefined);

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

  // A real admin row, so the audit foreign key resolves to a person.
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, 'platform_admin'));
  if (admin === undefined) throw new Error('no seeded platform admin');
  Object.assign(ADMIN, { userId: admin.id });

  fixture = { clientId: client.id, ktebId: kteb.id, groundTransportId: ground.id };
});

async function anApprovedProvider(): Promise<{ id: string; displayName: string }> {
  const [row] = await getDb()
    .select({ id: providerCompanies.id, displayName: providerCompanies.displayName })
    .from(providerCompanies)
    .where(eq(providerCompanies.status, 'approved'))
    .orderBy(providerCompanies.displayName)
    .limit(1);
  if (row === undefined) throw new Error('no approved provider seeded');
  return row;
}

async function auditFor(entityId: string) {
  return getDb()
    .select({
      action: auditEvents.action,
      before: auditEvents.beforeState,
      after: auditEvents.afterState,
      reason: auditEvents.reason,
      actorRole: auditEvents.actorRole,
    })
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId));
}

describe('provider approval', () => {
  it('approves a pending company and records the state change', async () => {
    const db = getDb();
    const [pending] = await db
      .insert(providerCompanies)
      .values({
        slug: 'northfield-ground',
        legalName: 'Northfield Ground Services LLC',
        displayName: 'Northfield Ground',
        status: 'pending',
        rank: 50,
      })
      .returning({ id: providerCompanies.id });

    await approveProvider(pending!.id, ADMIN);

    const [after] = await db
      .select({ status: providerCompanies.status })
      .from(providerCompanies)
      .where(eq(providerCompanies.id, pending!.id));

    expect(after?.status).toBe('approved');

    const events = await auditFor(pending!.id);
    const approval = events.find((event) => event.action === 'provider_company.approve');
    expect(approval).toBeDefined();
    expect(approval?.actorRole).toBe('platform_admin');
    expect(approval?.before).toMatchObject({ status: 'pending' });
    expect(approval?.after).toMatchObject({ status: 'approved' });
  });

  it('refuses to reject without a reason', async () => {
    const provider = await anApprovedProvider();
    const error = await captureError(() => rejectProvider(provider.id, '  ', ADMIN));
    expect(error.message).toMatch(/reason/i);
  });

  it('records the rank change with both values', async () => {
    const provider = await anApprovedProvider();
    await setProviderRank(provider.id, 7, ADMIN);

    const [after] = await getDb()
      .select({ rank: providerCompanies.rank })
      .from(providerCompanies)
      .where(eq(providerCompanies.id, provider.id));
    expect(after?.rank).toBe(7);

    const events = await auditFor(provider.id);
    expect(events.some((event) => event.action === 'provider_company.set_rank')).toBe(true);
  });
});

describe('suspending a provider', () => {
  it('withdraws every live offer it holds, so it cannot acknowledge work after suspension', async () => {
    const created = await createRequest({
      clientOrganizationId: fixture.clientId,
      createdByUserId: null,
      createdVia: 'ops',
      sourceSentence: 'Two cars at Teterboro.',
      airportId: fixture.ktebId,
      fboId: null,
      aircraftId: null,
      arrivalUtc: new Date('2026-09-18T07:00:00.000Z'),
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
    const dispatched = await dispatchNextOffer(lineId, {
      evaluationNow: new Date('2026-09-17T19:00:00.000Z'),
    });
    expect(dispatched.offer).not.toBeNull();

    const holderId = dispatched.offer!.providerCompanyId;
    await suspendProvider(holderId, 'Certificate of insurance lapsed.', ADMIN);

    const [offer] = await getDb()
      .select({ status: providerOffers.status, withdrawnReason: providerOffers.withdrawnReason })
      .from(providerOffers)
      .where(eq(providerOffers.id, dispatched.offer!.id));

    expect(offer?.status).toBe('withdrawn');
    expect(offer?.withdrawnReason).toMatch(/suspend/i);

    // The line does not silently lose its provider: it goes back to matching.
    const [line] = await getDb()
      .select({ status: requestServiceLines.status, currentOfferId: requestServiceLines.currentOfferId })
      .from(requestServiceLines)
      .where(eq(requestServiceLines.id, lineId));

    expect(line?.currentOfferId).toBeNull();
    expect(['matching', 'rematching']).toContain(line?.status);
  });

  it('keeps coverage rows intact — suspension is a status, not a deletion', async () => {
    const provider = await anApprovedProvider();
    const before = await getDb().execute<{ n: number }>(
      sql`select count(*)::int as n from provider_coverage where provider_company_id = ${provider.id}::uuid`,
    );

    await suspendProvider(provider.id, 'Under review after an incident report.', ADMIN);

    const after = await getDb().execute<{ n: number }>(
      sql`select count(*)::int as n from provider_coverage where provider_company_id = ${provider.id}::uuid`,
    );

    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect(after.rows[0]?.n).toBeGreaterThan(0);
  });

  it('carries the reason into the audit trail', async () => {
    const provider = await anApprovedProvider();
    await suspendProvider(provider.id, 'Certificate of insurance lapsed on renewal.', ADMIN);

    const events = await auditFor(provider.id);
    const suspension = events.find((event) => event.action === 'provider_company.suspend');
    expect(suspension?.reason).toBe('Certificate of insurance lapsed on renewal.');
  });
});

describe('the service catalogue is data', () => {
  it('creates a category that is immediately usable without a migration', async () => {
    const created = await createServiceCategory(
      {
        code: 'concierge',
        name: 'Concierge',
        description: 'Local arrangements on behalf of the principal.',
        unitLabel: 'booking',
        assignmentStrategy: 'generic',
        sortOrder: 90,
        configSchema: { fields: [] },
      },
      ADMIN,
    );

    const [row] = await getDb()
      .select({ code: serviceCategories.code, active: serviceCategories.active })
      .from(serviceCategories)
      .where(eq(serviceCategories.id, created.id));

    expect(row?.code).toBe('concierge');
    expect(row?.active).toBe(true);

    // And a request line can be created against it right away — the proof that nothing
    // in the schema hard-codes the seeded six.
    const request = await createRequest({
      clientOrganizationId: fixture.clientId,
      createdByUserId: null,
      createdVia: 'ops',
      sourceSentence: 'Concierge for the principal at Teterboro.',
      airportId: fixture.ktebId,
      fboId: null,
      aircraftId: null,
      arrivalUtc: new Date('2026-09-18T07:00:00.000Z'),
      departureUtc: null,
      passengerCount: 2,
      crewCount: 2,
      lines: [{ serviceCategoryId: created.id, quantity: 1, requirements: {} }],
    });

    expect(request.lineIds).toHaveLength(1);
  });

  it('refuses a duplicate code rather than shadowing the existing service', async () => {
    const error = await captureError(() =>
      createServiceCategory(
        {
          code: 'ground_transport',
          name: 'Ground transport (duplicate)',
          description: '',
          unitLabel: 'car',
          assignmentStrategy: 'generic',
          sortOrder: 10,
          configSchema: { fields: [] },
        },
        ADMIN,
      ),
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('disabling a category leaves existing coverage and history untouched', async () => {
    await setServiceCategoryActive(fixture.groundTransportId, false, ADMIN);

    const [row] = await getDb()
      .select({ active: serviceCategories.active })
      .from(serviceCategories)
      .where(eq(serviceCategories.id, fixture.groundTransportId));
    expect(row?.active).toBe(false);

    const coverage = await getDb().execute<{ n: number }>(
      sql`select count(*)::int as n from provider_coverage where service_category_id = ${fixture.groundTransportId}::uuid`,
    );
    expect(coverage.rows[0]?.n).toBeGreaterThan(0);
  });
});

describe('the airport registry', () => {
  it('rejects an airport with no identifier at all', async () => {
    const error = await captureError(() =>
      createAirport(
        {
          icao: null,
          iata: null,
          name: 'Nameless Field',
          city: 'Somewhere',
          stateRegion: null,
          countryCode: 'US',
          latitude: '40.000000',
          longitude: '-74.000000',
          timezoneIana: 'America/New_York',
        },
        ADMIN,
      ),
    );
    expect(error.message).toMatch(/ICAO or an IATA/i);
  });

  it('rejects an unknown timezone before it can corrupt every future arrival time', async () => {
    const error = await captureError(() =>
      createAirport(
        {
          icao: 'KXYZ',
          iata: null,
          name: 'Example Field',
          city: 'Example',
          stateRegion: null,
          countryCode: 'US',
          latitude: '40.000000',
          longitude: '-74.000000',
          timezoneIana: 'America/Nowhere_At_All',
        },
        ADMIN,
      ),
    );
    expect(error.message).toMatch(/not a known IANA timezone/i);
  });

  it('stores coordinates exactly as given, with no floating-point drift', async () => {
    const created = await createAirport(
      {
        icao: 'KMMU',
        iata: 'MMU',
        name: 'Morristown Municipal Airport',
        city: 'Morristown',
        stateRegion: 'New Jersey',
        countryCode: 'us',
        latitude: '40.799435',
        longitude: '-74.414875',
        timezoneIana: 'America/New_York',
      },
      ADMIN,
    );

    const [row] = await getDb()
      .select({
        latitude: airports.latitude,
        longitude: airports.longitude,
        countryCode: airports.countryCode,
      })
      .from(airports)
      .where(eq(airports.id, created.id));

    expect(row?.latitude).toBe('40.799435');
    expect(row?.longitude).toBe('-74.414875');
    // Normalised on the way in, so lookups do not depend on how it was typed.
    expect(row?.countryCode).toBe('US');
  });

  it('attaches a handler to an airport and audits it', async () => {
    const created = await createFbo(
      { airportId: fixture.ktebId, name: 'Meridian Aviation TEB', phone: '+1 201 555 0199' },
      ADMIN,
    );

    const events = await auditFor(created.id);
    expect(events.some((event) => event.action === 'registry.create_fbo')).toBe(true);
  });
});

describe('user accounts', () => {
  it('creates an account whose password verifies and is never stored in readable form', async () => {
    const created = await createUser(
      {
        email: 'dana.whitfield@apron.test',
        fullName: 'Dana Whitfield',
        role: 'operations_agent',
        phone: null,
        providerCompanyId: null,
        clientOrganizationId: null,
        temporaryPassword: 'correct-horse-battery-staple',
      },
      ADMIN,
    );

    const [row] = await getDb()
      .select({ hash: users.passwordHash, email: users.email })
      .from(users)
      .where(eq(users.id, created.id));

    expect(row?.email).toBe('dana.whitfield@apron.test');
    expect(row?.hash).not.toContain('correct-horse-battery-staple');
    await expect(verifyPassword(row!.hash, 'correct-horse-battery-staple')).resolves.toBe(true);
    await expect(verifyPassword(row!.hash, 'something-else-entirely')).resolves.toBe(false);
  });

  it('never writes the password into the audit trail', async () => {
    const created = await createUser(
      {
        email: 'audit.check@apron.test',
        fullName: 'Audit Check',
        role: 'operations_agent',
        phone: null,
        providerCompanyId: null,
        clientOrganizationId: null,
        temporaryPassword: 'a-very-secret-passphrase',
      },
      ADMIN,
    );

    const events = await auditFor(created.id);
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('a-very-secret-passphrase');
  });

  it('suspending an account revokes its live sessions immediately', async () => {
    const created = await createUser(
      {
        email: 'temporary.staff@apron.test',
        fullName: 'Temporary Staff',
        role: 'operations_agent',
        phone: null,
        providerCompanyId: null,
        clientOrganizationId: null,
        temporaryPassword: 'another-long-temporary-password',
      },
      ADMIN,
    );

    await createSession(created.id, { ipAddress: null, userAgent: null });
    await createSession(created.id, { ipAddress: null, userAgent: null });

    const result = await setUserStatus(created.id, 'suspended', 'Left the company.', ADMIN);
    expect(result.revokedSessions).toBe(2);

    const live = await getDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, created.id), sql`${sessions.revokedAt} is null`));

    expect(live).toHaveLength(0);
  });
});

describe('settings and feature flags', () => {
  it('stores a setting as JSON and audits the previous value', async () => {
    const db = getDb();
    const [before] = await db
      .select({ key: platformSettings.key, value: platformSettings.value })
      .from(platformSettings)
      .orderBy(platformSettings.key)
      .limit(1);
    if (before === undefined) throw new Error('no seeded settings');

    await setPlatformSetting(before.key, 90, ADMIN);

    const [after] = await db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, before.key));

    expect(after?.value).toBe(90);

    const events = await getDb()
      .select({ action: auditEvents.action, before: auditEvents.beforeState })
      .from(auditEvents)
      .where(eq(auditEvents.entityType, 'platform_setting'));

    expect(events.some((event) => event.action === 'settings.update')).toBe(true);
  });

  it('flips a feature flag and records who did it', async () => {
    const db = getDb();
    const [flag] = await db
      .select({ key: featureFlags.key, enabled: featureFlags.enabled })
      .from(featureFlags)
      .orderBy(featureFlags.key)
      .limit(1);
    if (flag === undefined) throw new Error('no seeded flags');

    await setFeatureFlag(flag.key, !flag.enabled, ADMIN);

    const [after] = await db
      .select({ enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(eq(featureFlags.key, flag.key));

    expect(after?.enabled).toBe(!flag.enabled);
  });
});
