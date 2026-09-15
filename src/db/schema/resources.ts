import { relations } from 'drizzle-orm';
import { boolean, date, integer, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import {
  activeFlag,
  citext,
  closeMinute,
  createdAt,
  dimension,
  latitude,
  longitude,
  openMinute,
  primaryId,
  prose,
  updatedAt,
  weekday,
} from './_shared';
import { airports, fbos } from './geography';
import { providerCompanies } from './identity';
import type { FuelType, StaffStatus, VehicleClass, VehicleStatus } from './enums';

/**
 * Concrete operational resources.
 *
 * Deliberately NOT forced into one shape (CLAUDE.md §6). A shared coverage and scheduling
 * vocabulary is reused — weekday shifts, an `active` flag, a provider owner — but each
 * resource keeps the columns its own eligibility rule actually needs: a vehicle has seats
 * and luggage, a hangar has door dimensions, a fuel truck has an uplift ceiling.
 */

// --- ground transport -------------------------------------------------------

export const vehicles = pgTable('vehicles', {
  id: primaryId(),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'cascade' }),
  homeAirportId: uuid('home_airport_id').references(() => airports.id, { onDelete: 'set null' }),
  vehicleClass: text('vehicle_class').$type<VehicleClass>().notNull(),
  make: text('make').notNull(),
  model: text('model').notNull(),
  modelYear: integer('model_year'),
  plateReference: text('plate_reference').notNull(),
  passengerCapacity: integer('passenger_capacity').notNull(),
  luggageCapacity: integer('luggage_capacity').notNull().default(0),
  /** Free-form capability tags: `wifi`, `child_seat`, `partition`, `armored_b6`. */
  features: text('features').array().notNull().default([]),
  status: text('status').$type<VehicleStatus>().notNull().default('available'),
  notes: prose('notes'),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const drivers = pgTable('drivers', {
  id: primaryId(),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'cascade' }),
  homeAirportId: uuid('home_airport_id').references(() => airports.id, { onDelete: 'set null' }),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  email: citext('email'),
  licenseReference: text('license_reference'),
  licenseExpiresAt: date('license_expires_at'),
  languages: text('languages').array().notNull().default([]),
  /** Shifts below are weekday wall-clock windows interpreted in this zone. */
  timezoneIana: text('timezone_iana').notNull(),
  status: text('status').$type<StaffStatus>().notNull().default('available'),
  notes: prose('notes'),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const driverShifts = pgTable('driver_shifts', {
  id: primaryId(),
  driverId: uuid('driver_id')
    .notNull()
    .references(() => drivers.id, { onDelete: 'cascade' }),
  weekday: weekday(),
  openMinute: openMinute(),
  closeMinute: closeMinute(),
});

// --- close protection -------------------------------------------------------

export const securityOfficers = pgTable('security_officers', {
  id: primaryId(),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'cascade' }),
  homeAirportId: uuid('home_airport_id').references(() => airports.id, { onDelete: 'set null' }),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  email: citext('email'),
  credentialReference: text('credential_reference'),
  credentialExpiresAt: date('credential_expires_at'),
  /** A request asking for armed officers filters on this; it is never inferred. */
  armedCertified: boolean('armed_certified').notNull().default(false),
  languages: text('languages').array().notNull().default([]),
  timezoneIana: text('timezone_iana').notNull(),
  status: text('status').$type<StaffStatus>().notNull().default('available'),
  notes: prose('notes'),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const officerShifts = pgTable('officer_shifts', {
  id: primaryId(),
  officerId: uuid('officer_id')
    .notNull()
    .references(() => securityOfficers.id, { onDelete: 'cascade' }),
  weekday: weekday(),
  openMinute: openMinute(),
  closeMinute: closeMinute(),
});

// --- hotel ------------------------------------------------------------------

export const hotelProperties = pgTable('hotel_properties', {
  id: primaryId(),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'cascade' }),
  airportId: uuid('airport_id')
    .notNull()
    .references(() => airports.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  address: text('address'),
  latitude: latitude(),
  longitude: longitude(),
  starRating: smallint('star_rating'),
  driveMinutesToFbo: integer('drive_minutes_to_fbo'),
  partnerTerms: prose('partner_terms'),
  /** Latest local time a room can be held without a guaranteed booking. */
  holdReleaseMinute: openMinute('hold_release_minute').default(1080),
  timezoneIana: text('timezone_iana').notNull(),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Availability is derived from committed assignments against `totalRooms`, never from a
 * separately maintained counter — consistent with "nothing is held until acknowledgement"
 * and impossible to drift out of step with reality.
 */
export const hotelRoomTypes = pgTable('hotel_room_types', {
  id: primaryId(),
  hotelPropertyId: uuid('hotel_property_id')
    .notNull()
    .references(() => hotelProperties.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  maxOccupancy: integer('max_occupancy').notNull().default(2),
  totalRooms: integer('total_rooms').notNull(),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- catering ---------------------------------------------------------------

export const cateringCapabilities = pgTable('catering_capabilities', {
  id: primaryId(),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'cascade' }),
  airportId: uuid('airport_id')
    .notNull()
    .references(() => airports.id, { onDelete: 'restrict' }),
  fboId: uuid('fbo_id').references(() => fbos.id, { onDelete: 'set null' }),
  kitchenName: text('kitchen_name').notNull(),
  leadTimeMinutes: integer('lead_time_minutes').notNull().default(240),
  maxOrdersPerDay: integer('max_orders_per_day').notNull().default(6),
  menuTags: text('menu_tags').array().notNull().default([]),
  /** `kosher`, `halal`, `vegan`, `gluten_free` — matched against line requirements. */
  dietaryTags: text('dietary_tags').array().notNull().default([]),
  timezoneIana: text('timezone_iana').notNull(),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- fuel -------------------------------------------------------------------

export const fuelCapabilities = pgTable('fuel_capabilities', {
  id: primaryId(),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'cascade' }),
  airportId: uuid('airport_id')
    .notNull()
    .references(() => airports.id, { onDelete: 'restrict' }),
  fboId: uuid('fbo_id').references(() => fbos.id, { onDelete: 'set null' }),
  fuelType: text('fuel_type').$type<FuelType>().notNull().default('jet_a'),
  truckReference: text('truck_reference').notNull(),
  maxUpliftGallons: integer('max_uplift_gallons').notNull(),
  concurrentUplifts: integer('concurrent_uplifts').notNull().default(1),
  supportsPrist: boolean('supports_prist').notNull().default(false),
  timezoneIana: text('timezone_iana').notNull(),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- hangar -----------------------------------------------------------------

/**
 * Dimensions are the real constraint. The hangar-fit rule compares the aircraft's
 * wingspan, length and tail height against the door and floor limits; a missing aircraft
 * dimension makes the check fail, never pass.
 */
export const hangarResources = pgTable('hangar_resources', {
  id: primaryId(),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'cascade' }),
  airportId: uuid('airport_id')
    .notNull()
    .references(() => airports.id, { onDelete: 'restrict' }),
  fboId: uuid('fbo_id').references(() => fbos.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  doorWidthFt: dimension('door_width_ft').notNull(),
  doorHeightFt: dimension('door_height_ft').notNull(),
  floorLengthFt: dimension('floor_length_ft').notNull(),
  floorWidthFt: dimension('floor_width_ft').notNull(),
  maxAircraftWeightLbs: integer('max_aircraft_weight_lbs'),
  heated: boolean('heated').notNull().default(false),
  /**
   * Bays holding more than one aircraft are modelled as separate rows, which keeps the
   * `EXCLUDE` constraint on `assignment_resources` exact.
   */
  concurrentAircraft: integer('concurrent_aircraft').notNull().default(1),
  timezoneIana: text('timezone_iana').notNull(),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- relations --------------------------------------------------------------

export const vehiclesRelations = relations(vehicles, ({ one }) => ({
  providerCompany: one(providerCompanies, {
    fields: [vehicles.providerCompanyId],
    references: [providerCompanies.id],
  }),
  homeAirport: one(airports, { fields: [vehicles.homeAirportId], references: [airports.id] }),
}));

export const driversRelations = relations(drivers, ({ one, many }) => ({
  providerCompany: one(providerCompanies, {
    fields: [drivers.providerCompanyId],
    references: [providerCompanies.id],
  }),
  homeAirport: one(airports, { fields: [drivers.homeAirportId], references: [airports.id] }),
  shifts: many(driverShifts),
}));

export const driverShiftsRelations = relations(driverShifts, ({ one }) => ({
  driver: one(drivers, { fields: [driverShifts.driverId], references: [drivers.id] }),
}));

export const securityOfficersRelations = relations(securityOfficers, ({ one, many }) => ({
  providerCompany: one(providerCompanies, {
    fields: [securityOfficers.providerCompanyId],
    references: [providerCompanies.id],
  }),
  homeAirport: one(airports, {
    fields: [securityOfficers.homeAirportId],
    references: [airports.id],
  }),
  shifts: many(officerShifts),
}));

export const officerShiftsRelations = relations(officerShifts, ({ one }) => ({
  officer: one(securityOfficers, {
    fields: [officerShifts.officerId],
    references: [securityOfficers.id],
  }),
}));

export const hotelPropertiesRelations = relations(hotelProperties, ({ one, many }) => ({
  providerCompany: one(providerCompanies, {
    fields: [hotelProperties.providerCompanyId],
    references: [providerCompanies.id],
  }),
  airport: one(airports, { fields: [hotelProperties.airportId], references: [airports.id] }),
  roomTypes: many(hotelRoomTypes),
}));

export const hotelRoomTypesRelations = relations(hotelRoomTypes, ({ one }) => ({
  property: one(hotelProperties, {
    fields: [hotelRoomTypes.hotelPropertyId],
    references: [hotelProperties.id],
  }),
}));

export const cateringCapabilitiesRelations = relations(cateringCapabilities, ({ one }) => ({
  providerCompany: one(providerCompanies, {
    fields: [cateringCapabilities.providerCompanyId],
    references: [providerCompanies.id],
  }),
  airport: one(airports, { fields: [cateringCapabilities.airportId], references: [airports.id] }),
  fbo: one(fbos, { fields: [cateringCapabilities.fboId], references: [fbos.id] }),
}));

export const fuelCapabilitiesRelations = relations(fuelCapabilities, ({ one }) => ({
  providerCompany: one(providerCompanies, {
    fields: [fuelCapabilities.providerCompanyId],
    references: [providerCompanies.id],
  }),
  airport: one(airports, { fields: [fuelCapabilities.airportId], references: [airports.id] }),
  fbo: one(fbos, { fields: [fuelCapabilities.fboId], references: [fbos.id] }),
}));

export const hangarResourcesRelations = relations(hangarResources, ({ one }) => ({
  providerCompany: one(providerCompanies, {
    fields: [hangarResources.providerCompanyId],
    references: [providerCompanies.id],
  }),
  airport: one(airports, { fields: [hangarResources.airportId], references: [airports.id] }),
  fbo: one(fbos, { fields: [hangarResources.fboId], references: [fbos.id] }),
}));

export type Vehicle = typeof vehicles.$inferSelect;
export type NewVehicle = typeof vehicles.$inferInsert;
export type Driver = typeof drivers.$inferSelect;
export type NewDriver = typeof drivers.$inferInsert;
export type DriverShift = typeof driverShifts.$inferSelect;
export type SecurityOfficer = typeof securityOfficers.$inferSelect;
export type NewSecurityOfficer = typeof securityOfficers.$inferInsert;
export type OfficerShift = typeof officerShifts.$inferSelect;
export type HotelProperty = typeof hotelProperties.$inferSelect;
export type NewHotelProperty = typeof hotelProperties.$inferInsert;
export type HotelRoomType = typeof hotelRoomTypes.$inferSelect;
export type NewHotelRoomType = typeof hotelRoomTypes.$inferInsert;
export type CateringCapability = typeof cateringCapabilities.$inferSelect;
export type NewCateringCapability = typeof cateringCapabilities.$inferInsert;
export type FuelCapability = typeof fuelCapabilities.$inferSelect;
export type NewFuelCapability = typeof fuelCapabilities.$inferInsert;
export type HangarResource = typeof hangarResources.$inferSelect;
export type NewHangarResource = typeof hangarResources.$inferInsert;
