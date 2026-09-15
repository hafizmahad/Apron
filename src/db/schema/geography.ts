import { relations } from 'drizzle-orm';
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import {
  citext,
  activeFlag,
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
import type { AircraftCategory } from './enums';

/**
 * The aviation registry: airports, their FBOs and the aircraft that visit them.
 *
 * Mirrors `0001_foundation.sql`. Uniqueness, format and range rules live in the database;
 * this module is the typed query surface (ADR-003).
 */

export const airports = pgTable('airports', {
  id: primaryId(),
  /** Unique where present; a small field can have an IATA code and no ICAO, or neither. */
  icao: text('icao'),
  iata: text('iata'),
  name: text('name').notNull(),
  city: text('city').notNull(),
  stateRegion: text('state_region'),
  countryCode: text('country_code').notNull(),
  latitude: latitude().notNull(),
  longitude: longitude().notNull(),
  /** The zone every local wall time at this airport is resolved against (CLAUDE.md §7). */
  timezoneIana: text('timezone_iana').notNull(),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const fbos = pgTable('fbos', {
  id: primaryId(),
  airportId: uuid('airport_id')
    .notNull()
    .references(() => airports.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  phone: text('phone'),
  email: citext('email'),
  address: text('address'),
  website: text('website'),
  /** Stored as a pair or not at all — half a position would misplace a map marker. */
  latitude: latitude(),
  longitude: longitude(),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Desk hours, weekday-based, in the parent airport's zone. Crossing midnight allowed. */
export const fboOperatingHours = pgTable('fbo_operating_hours', {
  id: primaryId(),
  fboId: uuid('fbo_id')
    .notNull()
    .references(() => fbos.id, { onDelete: 'cascade' }),
  weekday: weekday(),
  openMinute: openMinute(),
  closeMinute: closeMinute(),
});

export const aircraft = pgTable('aircraft', {
  id: primaryId(),
  tailNumber: text('tail_number').notNull(),
  typeCode: text('type_code'),
  model: text('model').notNull(),
  manufacturer: text('manufacturer'),
  operatorName: text('operator_name'),
  category: text('category').$type<AircraftCategory>().notNull().default('midsize'),
  passengerCapacity: integer('passenger_capacity'),
  /**
   * Nullable on purpose. An unknown wingspan must make the hangar-fit check FAIL loudly
   * rather than pass on an assumed default (CLAUDE.md §9).
   */
  wingspanFt: dimension('wingspan_ft'),
  lengthFt: dimension('length_ft'),
  tailHeightFt: dimension('tail_height_ft'),
  mtowLbs: integer('mtow_lbs'),
  notes: prose('notes'),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const airportsRelations = relations(airports, ({ many }) => ({
  fbos: many(fbos),
}));

export const fbosRelations = relations(fbos, ({ one, many }) => ({
  airport: one(airports, { fields: [fbos.airportId], references: [airports.id] }),
  operatingHours: many(fboOperatingHours),
}));

export const fboOperatingHoursRelations = relations(fboOperatingHours, ({ one }) => ({
  fbo: one(fbos, { fields: [fboOperatingHours.fboId], references: [fbos.id] }),
}));

export type Airport = typeof airports.$inferSelect;
export type NewAirport = typeof airports.$inferInsert;
export type Fbo = typeof fbos.$inferSelect;
export type NewFbo = typeof fbos.$inferInsert;
export type FboOperatingHour = typeof fboOperatingHours.$inferSelect;
export type Aircraft = typeof aircraft.$inferSelect;
export type NewAircraft = typeof aircraft.$inferInsert;
