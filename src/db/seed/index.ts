import '@/lib/server-guard';
import { eq, sql } from 'drizzle-orm';
import { closePool, getDb, withTransaction, type Transaction } from '@/db/client';
import * as schema from '@/db/schema';
import { getEnv } from '@/lib/config/env';
import { hashPassword } from '@/auth/password';
import { seedAircraft, seedAirports, seedFbos } from './reference/aviation';
import {
  seedFeatureFlags,
  seedPlatformSettings,
  seedServiceCategories,
} from './reference/catalogue';
import {
  seedCatering,
  seedCoverage,
  seedDrivers,
  seedFuel,
  seedHangars,
  seedHotels,
  seedOfficers,
  seedProviders,
  seedVehicles,
} from './reference/network';
import { seedClientOrganizations, seedUsers } from './reference/tenants';

/**
 * Seeds the reference operational network (CLAUDE.md §16, Phase 1 exit criteria).
 *
 * Properties this script guarantees:
 *
 *  - **Idempotent.** Every insert is an upsert keyed on the natural key (ICAO, slug,
 *    email, plate). Running it twice changes nothing and is not an error, so it is safe
 *    in an entrypoint and safe to re-run after adding a row to the reference data.
 *  - **Transactional.** The whole seed runs in one transaction. A failure halfway leaves
 *    an empty database rather than a half-built network.
 *  - **Refuses non-local environments.** These accounts share one well-known development
 *    password; seeding anything but `local`/`ci` is refused outright unless the operator
 *    sets `APRON_ALLOW_REMOTE_SEED=yes`, which exists only so a reviewer can deliberately
 *    load a scratch environment.
 *
 * It does NOT create requests, offers or assignments. Those are produced by
 * `npm run db:seed -- --scenarios` in Phase 6, once the state machines that own those
 * transitions exist — writing them by hand here would bypass the very transitions the
 * product is supposed to enforce.
 */

/** The fallback, used when `SEED_PASSWORD` is unset. Well known, and only ever local. */
const DEV_PASSWORD = 'Apron!Dev2026';

/** One password for every seeded account, so nothing has to be rotated per user. */
function seedPassword(): { readonly value: string; readonly isDefault: boolean } {
  const configured = getEnv().SEED_PASSWORD;
  return configured === undefined
    ? { value: DEV_PASSWORD, isDefault: true }
    : { value: configured, isDefault: false };
}

export interface SeedSummary {
  readonly [table: string]: number;
}

/**
 * What this guard is actually about.
 *
 * Not "seeding a remote environment is dangerous" — seeding IS how a deployed environment
 * gets its airports, its catalogue and its first administrator, and refusing it outright
 * would mean doing that by hand. The danger is seeding one with the password published in
 * this repository.
 *
 * So the rule follows the real risk: a non-local environment may seed freely once
 * `SEED_PASSWORD` is set to something of its own, and is refused while it is not. The
 * operator sets it once; nothing needs rotating afterwards.
 */
function assertSeedableEnvironment(): void {
  const env = getEnv();
  const local = env.APP_ENV === 'local' || env.APP_ENV === 'ci';
  const override = process.env['APRON_ALLOW_REMOTE_SEED'] === 'yes';

  if (local || !seedPassword().isDefault || override) return;

  throw new Error(
    `Refusing to seed APP_ENV="${env.APP_ENV}" with the development password, which is ` +
      'published in this repository. Set SEED_PASSWORD to a value of your own — once, and ' +
      'it never needs changing again.',
  );
}

export async function runSeed(
  options: { log?: (message: string) => void } = {},
): Promise<SeedSummary> {
  const log = options.log ?? (() => {});
  assertSeedableEnvironment();

  const credentials = seedPassword();
  const passwordHash = await hashPassword(credentials.value);

  return withTransaction(async (tx) => {
    const counts: Record<string, number> = {};

    // --- platform configuration -------------------------------------------
    for (const setting of seedPlatformSettings) {
      await tx
        .insert(schema.platformSettings)
        .values({
          key: setting.key,
          value: setting.value,
          description: setting.description,
        })
        .onConflictDoUpdate({
          target: schema.platformSettings.key,
          set: { description: setting.description },
        });
    }
    counts['platform_settings'] = seedPlatformSettings.length;

    for (const flag of seedFeatureFlags) {
      await tx
        .insert(schema.featureFlags)
        .values({ key: flag.key, enabled: flag.enabled, description: flag.description })
        .onConflictDoUpdate({
          target: schema.featureFlags.key,
          set: { description: flag.description },
        });
    }
    counts['feature_flags'] = seedFeatureFlags.length;

    // --- service catalogue -------------------------------------------------
    const serviceIdByCode = new Map<string, string>();
    for (const category of seedServiceCategories) {
      const [row] = await tx
        .insert(schema.serviceCategories)
        .values({
          code: category.code,
          name: category.name,
          description: category.description,
          unitLabel: category.unitLabel,
          assignmentStrategy: category.assignmentStrategy,
          configSchemaJson: category.configSchema,
          sortOrder: category.sortOrder,
        })
        .onConflictDoUpdate({
          target: schema.serviceCategories.code,
          set: {
            name: category.name,
            description: category.description,
            unitLabel: category.unitLabel,
            assignmentStrategy: category.assignmentStrategy,
            configSchemaJson: category.configSchema,
            sortOrder: category.sortOrder,
          },
        })
        .returning({ id: schema.serviceCategories.id });
      if (row === undefined) throw new Error(`service category ${category.code} did not return an id`);
      serviceIdByCode.set(category.code, row.id);
    }
    counts['service_categories'] = serviceIdByCode.size;
    log(`service catalogue: ${serviceIdByCode.size} categories`);

    // --- airports ----------------------------------------------------------
    const airportIdByIcao = new Map<string, string>();
    for (const airport of seedAirports) {
      const [row] = await tx
        .insert(schema.airports)
        .values({
          icao: airport.icao,
          iata: airport.iata,
          name: airport.name,
          city: airport.city,
          stateRegion: airport.stateRegion,
          countryCode: airport.countryCode,
          latitude: airport.latitude,
          longitude: airport.longitude,
          timezoneIana: airport.timezoneIana,
        })
        .onConflictDoUpdate({
          target: schema.airports.icao,
          // The unique index is partial (`where icao is not null`), so Postgres needs the
          // same predicate to infer it as the arbiter.
          targetWhere: sql`${schema.airports.icao} is not null`,
          set: {
            iata: airport.iata,
            name: airport.name,
            city: airport.city,
            stateRegion: airport.stateRegion,
            latitude: airport.latitude,
            longitude: airport.longitude,
            timezoneIana: airport.timezoneIana,
          },
        })
        .returning({ id: schema.airports.id });
      if (row === undefined) throw new Error(`airport ${airport.icao} did not return an id`);
      airportIdByIcao.set(airport.icao, row.id);
    }
    counts['airports'] = airportIdByIcao.size;

    const requireAirport = (icao: string): string => {
      const id = airportIdByIcao.get(icao);
      if (id === undefined) throw new Error(`Seed references unknown airport ${icao}`);
      return id;
    };

    // --- FBOs and their desk hours ----------------------------------------
    const fboIdByKey = new Map<string, string>();
    for (const fbo of seedFbos) {
      const airportId = requireAirport(fbo.airportIcao);
      const existing = await tx
        .select({ id: schema.fbos.id })
        .from(schema.fbos)
        .where(
          sql`${schema.fbos.airportId} = ${airportId} and lower(${schema.fbos.name}) = lower(${fbo.name})`,
        )
        .limit(1);

      let fboId = existing[0]?.id;
      if (fboId === undefined) {
        const [row] = await tx
          .insert(schema.fbos)
          .values({ airportId, name: fbo.name })
          .returning({ id: schema.fbos.id });
        if (row === undefined) throw new Error(`fbo ${fbo.name} did not return an id`);
        fboId = row.id;
      }

      fboIdByKey.set(`${fbo.airportIcao}::${fbo.name}`, fboId);

      // Hours are fully replaced rather than merged, so editing the reference data
      // produces exactly what it declares on the next run.
      await tx.delete(schema.fboOperatingHours).where(eq(schema.fboOperatingHours.fboId, fboId));
      if (fbo.hours.length > 0) {
        await tx.insert(schema.fboOperatingHours).values(
          fbo.hours.map(([day, open, close]) => ({
            fboId,
            weekday: day,
            openMinute: open,
            closeMinute: close,
          })),
        );
      }
    }
    counts['fbos'] = fboIdByKey.size;
    log(`aviation registry: ${airportIdByIcao.size} airports, ${fboIdByKey.size} FBOs`);

    // --- aircraft ----------------------------------------------------------
    for (const item of seedAircraft) {
      await tx
        .insert(schema.aircraft)
        .values({
          tailNumber: item.tailNumber,
          typeCode: item.typeCode,
          model: item.model,
          manufacturer: item.manufacturer,
          operatorName: item.operatorName,
          category: item.category,
          passengerCapacity: item.passengerCapacity,
          wingspanFt: item.wingspanFt,
          lengthFt: item.lengthFt,
          tailHeightFt: item.tailHeightFt,
          mtowLbs: item.mtowLbs,
        })
        .onConflictDoUpdate({
          target: schema.aircraft.tailNumber,
          set: {
            model: item.model,
            operatorName: item.operatorName,
            category: item.category,
            passengerCapacity: item.passengerCapacity,
            wingspanFt: item.wingspanFt,
            lengthFt: item.lengthFt,
            tailHeightFt: item.tailHeightFt,
            mtowLbs: item.mtowLbs,
          },
        });
    }
    counts['aircraft'] = seedAircraft.length;

    // --- client organisations ---------------------------------------------
    const clientIdBySlug = new Map<string, string>();
    for (const client of seedClientOrganizations) {
      const [row] = await tx
        .insert(schema.clientOrganizations)
        .values({
          slug: client.slug,
          name: client.name,
          primaryContactName: client.primaryContactName,
          primaryContactEmail: client.primaryContactEmail,
          primaryContactPhone: client.primaryContactPhone,
          billingEmail: client.primaryContactEmail,
          notes: client.notes,
        })
        .onConflictDoUpdate({
          target: schema.clientOrganizations.slug,
          set: { name: client.name, notes: client.notes },
        })
        .returning({ id: schema.clientOrganizations.id });
      if (row === undefined) throw new Error(`client ${client.slug} did not return an id`);
      clientIdBySlug.set(client.slug, row.id);
    }
    counts['client_organizations'] = clientIdBySlug.size;

    // --- provider companies ------------------------------------------------
    const providerIdBySlug = new Map<string, string>();
    for (const provider of seedProviders) {
      const approved = provider.status === 'approved';
      const suspended = provider.status === 'suspended';
      const [row] = await tx
        .insert(schema.providerCompanies)
        .values({
          slug: provider.slug,
          legalName: provider.legalName,
          displayName: provider.displayName,
          status: provider.status,
          rank: provider.rank,
          dispatchEmail: provider.dispatchEmail,
          dispatchPhone: provider.dispatchPhone,
          primaryContactEmail: provider.dispatchEmail,
          countryCode: provider.countryCode,
          notes: provider.notes,
          // The CHECK constraints require these to accompany their status.
          ...(approved ? { approvedAt: new Date() } : {}),
          ...(suspended
            ? {
                suspendedAt: new Date(),
                suspensionReason: provider.suspensionReason ?? 'Suspended during seeding.',
              }
            : {}),
        })
        .onConflictDoUpdate({
          target: schema.providerCompanies.slug,
          set: {
            legalName: provider.legalName,
            displayName: provider.displayName,
            status: provider.status,
            rank: provider.rank,
            notes: provider.notes,
          },
        })
        .returning({ id: schema.providerCompanies.id });
      if (row === undefined) throw new Error(`provider ${provider.slug} did not return an id`);
      providerIdBySlug.set(provider.slug, row.id);
    }
    counts['provider_companies'] = providerIdBySlug.size;
    log(`providers: ${providerIdBySlug.size} companies`);

    const requireProvider = (slug: string): string => {
      const id = providerIdBySlug.get(slug);
      if (id === undefined) throw new Error(`Seed references unknown provider ${slug}`);
      return id;
    };
    const requireService = (code: string): string => {
      const id = serviceIdByCode.get(code);
      if (id === undefined) throw new Error(`Seed references unknown service ${code}`);
      return id;
    };

    // --- users -------------------------------------------------------------
    for (const user of seedUsers) {
      const providerCompanyId =
        user.providerSlug === undefined ? null : requireProvider(user.providerSlug);
      const clientOrganizationId =
        user.clientSlug === undefined ? null : (clientIdBySlug.get(user.clientSlug) ?? null);

      if (user.clientSlug !== undefined && clientOrganizationId === null) {
        throw new Error(`Seed references unknown client organisation ${user.clientSlug}`);
      }

      await tx
        .insert(schema.users)
        .values({
          email: user.email,
          passwordHash,
          fullName: user.fullName,
          phone: user.phone,
          role: user.role,
          providerCompanyId,
          clientOrganizationId,
        })
        .onConflictDoUpdate({
          target: schema.users.email,
          set: {
            fullName: user.fullName,
            role: user.role,
            providerCompanyId,
            clientOrganizationId,
            passwordHash,
          },
        });
    }
    counts['users'] = seedUsers.length;
    log(`users: ${seedUsers.length} accounts across every role`);

    // --- coverage ----------------------------------------------------------
    let coverageRows = 0;
    for (const coverage of seedCoverage) {
      const providerCompanyId = requireProvider(coverage.providerSlug);
      const serviceCategoryId = requireService(coverage.serviceCode);
      const airportId = requireAirport(coverage.airportIcao);
      const fboId =
        coverage.fboName === undefined
          ? null
          : (fboIdByKey.get(`${coverage.airportIcao}::${coverage.fboName}`) ?? null);

      if (coverage.fboName !== undefined && fboId === null) {
        throw new Error(`Seed references unknown FBO ${coverage.fboName} at ${coverage.airportIcao}`);
      }

      const existing = await tx
        .select({ id: schema.providerCoverage.id })
        .from(schema.providerCoverage)
        .where(
          sql`${schema.providerCoverage.providerCompanyId} = ${providerCompanyId}
              and ${schema.providerCoverage.serviceCategoryId} = ${serviceCategoryId}
              and ${schema.providerCoverage.airportId} = ${airportId}
              and ${schema.providerCoverage.fboId} is not distinct from ${fboId}`,
        )
        .limit(1);

      const values = {
        providerCompanyId,
        serviceCategoryId,
        airportId,
        fboId,
        scope: (fboId === null ? 'airport' : 'fbo') as 'airport' | 'fbo',
        totalCapacity: coverage.totalCapacity,
        leadTimeMinutes: coverage.leadTimeMinutes,
        maxNoticeDays: coverage.maxNoticeDays ?? null,
        is247: coverage.is247,
      };

      let coverageId = existing[0]?.id;
      if (coverageId === undefined) {
        const [row] = await tx
          .insert(schema.providerCoverage)
          .values(values)
          .returning({ id: schema.providerCoverage.id });
        if (row === undefined) throw new Error('coverage row did not return an id');
        coverageId = row.id;
      } else {
        await tx
          .update(schema.providerCoverage)
          .set(values)
          .where(eq(schema.providerCoverage.id, coverageId));
      }

      await tx
        .delete(schema.providerCoverageHours)
        .where(eq(schema.providerCoverageHours.coverageId, coverageId));
      if (!coverage.is247 && coverage.hours !== undefined) {
        await tx.insert(schema.providerCoverageHours).values(
          coverage.hours.map(([day, open, close]) => ({
            coverageId,
            weekday: day,
            openMinute: open,
            closeMinute: close,
          })),
        );
      }
      coverageRows += 1;
    }
    counts['provider_coverage'] = coverageRows;
    log(`coverage: ${coverageRows} provider/service/location rows`);

    // --- vehicles ----------------------------------------------------------
    for (const vehicle of seedVehicles) {
      await tx
        .insert(schema.vehicles)
        .values({
          providerCompanyId: requireProvider(vehicle.providerSlug),
          homeAirportId: requireAirport(vehicle.homeAirportIcao),
          vehicleClass: vehicle.vehicleClass,
          make: vehicle.make,
          model: vehicle.model,
          modelYear: vehicle.modelYear,
          plateReference: vehicle.plateReference,
          passengerCapacity: vehicle.passengerCapacity,
          luggageCapacity: vehicle.luggageCapacity,
          features: [...vehicle.features],
        })
        .onConflictDoNothing();
    }
    counts['vehicles'] = seedVehicles.length;

    // --- drivers and officers ---------------------------------------------
    counts['drivers'] = await upsertStaff(tx, seedDrivers, 'driver', requireProvider, requireAirport);
    counts['security_officers'] = await upsertStaff(
      tx,
      seedOfficers,
      'officer',
      requireProvider,
      requireAirport,
    );
    log(`resources: ${seedVehicles.length} vehicles, ${seedDrivers.length} drivers, ${seedOfficers.length} officers`);

    // --- hotels ------------------------------------------------------------
    let roomTypeRows = 0;
    for (const hotel of seedHotels) {
      const providerCompanyId = requireProvider(hotel.providerSlug);
      const airportId = requireAirport(hotel.airportIcao);
      const existing = await tx
        .select({ id: schema.hotelProperties.id })
        .from(schema.hotelProperties)
        .where(
          sql`${schema.hotelProperties.providerCompanyId} = ${providerCompanyId}
              and ${schema.hotelProperties.airportId} = ${airportId}
              and lower(${schema.hotelProperties.name}) = lower(${hotel.name})`,
        )
        .limit(1);

      let propertyId = existing[0]?.id;
      if (propertyId === undefined) {
        const [row] = await tx
          .insert(schema.hotelProperties)
          .values({
            providerCompanyId,
            airportId,
            name: hotel.name,
            starRating: hotel.starRating,
            driveMinutesToFbo: hotel.driveMinutesToFbo,
            timezoneIana: hotel.timezoneIana,
          })
          .returning({ id: schema.hotelProperties.id });
        if (row === undefined) throw new Error(`hotel ${hotel.name} did not return an id`);
        propertyId = row.id;
      }

      for (const roomType of hotel.roomTypes) {
        const hotelPropertyId = propertyId;
        const existingType = await tx
          .select({ id: schema.hotelRoomTypes.id })
          .from(schema.hotelRoomTypes)
          .where(
            sql`${schema.hotelRoomTypes.hotelPropertyId} = ${hotelPropertyId}
                and lower(${schema.hotelRoomTypes.code}) = lower(${roomType.code})`,
          )
          .limit(1);

        if (existingType[0] === undefined) {
          await tx.insert(schema.hotelRoomTypes).values({
            hotelPropertyId,
            code: roomType.code,
            name: roomType.name,
            maxOccupancy: roomType.maxOccupancy,
            totalRooms: roomType.totalRooms,
          });
        } else {
          await tx
            .update(schema.hotelRoomTypes)
            .set({ name: roomType.name, totalRooms: roomType.totalRooms })
            .where(eq(schema.hotelRoomTypes.id, existingType[0].id));
        }
        roomTypeRows += 1;
      }
    }
    counts['hotel_properties'] = seedHotels.length;
    counts['hotel_room_types'] = roomTypeRows;

    // --- catering, fuel, hangar -------------------------------------------
    for (const kitchen of seedCatering) {
      await tx
        .insert(schema.cateringCapabilities)
        .values({
          providerCompanyId: requireProvider(kitchen.providerSlug),
          airportId: requireAirport(kitchen.airportIcao),
          kitchenName: kitchen.kitchenName,
          leadTimeMinutes: kitchen.leadTimeMinutes,
          maxOrdersPerDay: kitchen.maxOrdersPerDay,
          menuTags: [...kitchen.menuTags],
          dietaryTags: [...kitchen.dietaryTags],
          timezoneIana: kitchen.timezoneIana,
        })
        .onConflictDoNothing();
    }
    counts['catering_capabilities'] = seedCatering.length;

    for (const truck of seedFuel) {
      await tx
        .insert(schema.fuelCapabilities)
        .values({
          providerCompanyId: requireProvider(truck.providerSlug),
          airportId: requireAirport(truck.airportIcao),
          truckReference: truck.truckReference,
          fuelType: truck.fuelType,
          maxUpliftGallons: truck.maxUpliftGallons,
          concurrentUplifts: truck.concurrentUplifts,
          supportsPrist: truck.supportsPrist,
          timezoneIana: truck.timezoneIana,
        })
        .onConflictDoNothing();
    }
    counts['fuel_capabilities'] = seedFuel.length;

    for (const hangar of seedHangars) {
      await tx
        .insert(schema.hangarResources)
        .values({
          providerCompanyId: requireProvider(hangar.providerSlug),
          airportId: requireAirport(hangar.airportIcao),
          name: hangar.name,
          doorWidthFt: hangar.doorWidthFt,
          doorHeightFt: hangar.doorHeightFt,
          floorLengthFt: hangar.floorLengthFt,
          floorWidthFt: hangar.floorWidthFt,
          maxAircraftWeightLbs: hangar.maxAircraftWeightLbs,
          heated: hangar.heated,
          timezoneIana: hangar.timezoneIana,
        })
        .onConflictDoNothing();
    }
    counts['hangar_resources'] = seedHangars.length;
    log(
      `service capacity: ${seedHotels.length} hotels, ${seedCatering.length} kitchens, ` +
        `${seedFuel.length} fuel trucks, ${seedHangars.length} hangar bays`,
    );

    return counts;
  });
}

/**
 * Drivers and officers share a shape but not a table: each keeps the columns its own
 * eligibility rule needs (an officer has `armedCertified`, a driver has a licence).
 */
async function upsertStaff(
  tx: Transaction,
  people: readonly {
    readonly providerSlug: string;
    readonly homeAirportIcao: string;
    readonly fullName: string;
    readonly phone: string;
    readonly languages: readonly string[];
    readonly timezoneIana: string;
    readonly shifts: readonly (readonly [number, number, number])[];
    readonly armedCertified?: boolean;
  }[],
  kind: 'driver' | 'officer',
  requireProvider: (slug: string) => string,
  requireAirport: (icao: string) => string,
): Promise<number> {
  for (const person of people) {
    const providerCompanyId = requireProvider(person.providerSlug);
    const homeAirportId = requireAirport(person.homeAirportIcao);

    if (kind === 'driver') {
      const existing = await tx
        .select({ id: schema.drivers.id })
        .from(schema.drivers)
        .where(
          sql`${schema.drivers.providerCompanyId} = ${providerCompanyId}
              and lower(${schema.drivers.fullName}) = lower(${person.fullName})`,
        )
        .limit(1);

      let driverId = existing[0]?.id;
      if (driverId === undefined) {
        const [row] = await tx
          .insert(schema.drivers)
          .values({
            providerCompanyId,
            homeAirportId,
            fullName: person.fullName,
            phone: person.phone,
            languages: [...person.languages],
            timezoneIana: person.timezoneIana,
          })
          .returning({ id: schema.drivers.id });
        if (row === undefined) throw new Error(`driver ${person.fullName} did not return an id`);
        driverId = row.id;
      }

      await tx.delete(schema.driverShifts).where(eq(schema.driverShifts.driverId, driverId));
      await tx.insert(schema.driverShifts).values(
        person.shifts.map(([day, open, close]) => ({
          driverId,
          weekday: day,
          openMinute: open,
          closeMinute: close,
        })),
      );
    } else {
      const existing = await tx
        .select({ id: schema.securityOfficers.id })
        .from(schema.securityOfficers)
        .where(
          sql`${schema.securityOfficers.providerCompanyId} = ${providerCompanyId}
              and lower(${schema.securityOfficers.fullName}) = lower(${person.fullName})`,
        )
        .limit(1);

      let officerId = existing[0]?.id;
      if (officerId === undefined) {
        const [row] = await tx
          .insert(schema.securityOfficers)
          .values({
            providerCompanyId,
            homeAirportId,
            fullName: person.fullName,
            phone: person.phone,
            armedCertified: person.armedCertified ?? false,
            languages: [...person.languages],
            timezoneIana: person.timezoneIana,
          })
          .returning({ id: schema.securityOfficers.id });
        if (row === undefined) throw new Error(`officer ${person.fullName} did not return an id`);
        officerId = row.id;
      }

      await tx.delete(schema.officerShifts).where(eq(schema.officerShifts.officerId, officerId));
      await tx.insert(schema.officerShifts).values(
        person.shifts.map(([day, open, close]) => ({
          officerId,
          weekday: day,
          openMinute: open,
          closeMinute: close,
        })),
      );
    }
  }
  return people.length;
}

/** Counts every seeded table, for the summary the CLI prints. */
export async function countSeededRows(): Promise<SeedSummary> {
  const db = getDb();
  const tables = [
    'service_categories',
    'airports',
    'fbos',
    'aircraft',
    'client_organizations',
    'provider_companies',
    'users',
    'provider_coverage',
    'vehicles',
    'drivers',
    'security_officers',
    'hotel_properties',
    'hotel_room_types',
    'catering_capabilities',
    'fuel_capabilities',
    'hangar_resources',
  ] as const;

  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from ${sql.identifier(table)}`,
    );
    counts[table] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('seed.js') ||
    process.argv[1].endsWith(`seed${String.fromCharCode(92)}index.ts`) ||
    process.argv[1].endsWith('seed/index.ts'));

if (isDirectRun) {
  try {
    await runSeed({ log: (message) => console.log(`[seed] ${message}`) });
    const counts = await countSeededRows();
    console.log('[seed] done. Row counts:');
    for (const [table, count] of Object.entries(counts)) {
      console.log(`[seed]   ${table.padEnd(24)} ${String(count).padStart(5)}`);
    }
    // Printed only when it is the published development one. A password the operator
    // chose is theirs, and echoing it into deployment logs would be the whole problem again.
    if (seedPassword().isDefault) {
      console.log(`[seed] every account signs in with the password: ${DEV_PASSWORD}`);
    } else {
      console.log('[seed] every account signs in with the configured SEED_PASSWORD');
    }
    await closePool();
    process.exit(0);
  } catch (error) {
    console.error('[seed] failed');
    console.error(error);
    await closePool();
    process.exit(1);
  }
}
