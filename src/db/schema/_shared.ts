import {
  boolean,
  customType,
  integer,
  numeric,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Column builders reused across every table, so the conventions in the migrations are
 * expressed once rather than retyped forty-three times.
 */

/** `uuid primary key default gen_random_uuid()` */
export const primaryId = () => uuid('id').primaryKey().defaultRandom();

/** `timestamptz not null default now()` — an instant, always UTC. */
/**
 * A creation instant. The column name is a parameter because several tables name theirs
 * for what it records — `occurred_at` on audit events, `evaluated_at` on match attempts —
 * and a mismatch between this mapping and the SQL is exactly the kind of bug that only
 * surfaces at query time.
 */
export const createdAt = (name = 'created_at') =>
  timestamp(name, { withTimezone: true, mode: 'date' }).notNull().defaultNow();
export const updatedAt = () => timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

/** A nullable instant. */
export const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

/** A required instant. */
export const requiredInstant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' }).notNull();

export const activeFlag = () => boolean('active').notNull().default(true);

/** `text not null default ''` — notes, descriptions and other optional prose. */
export const prose = (name: string) => text(name).notNull().default('');

/**
 * ISO 8601 weekday, 1 = Monday .. 7 = Sunday, interpreted in the owning record's zone.
 * Backed by the `apron_weekday` domain in SQL.
 */
export const weekday = () => smallint('weekday').notNull();

/** Minutes from local midnight, 0..1439. Backed by the `apron_open_minute` domain. */
export const openMinute = (name = 'open_minute') => integer(name).notNull();

/**
 * Minutes from local midnight, 1..2880. Values above 1440 cross midnight into the next
 * day, which is how a Friday 18:00 -> Saturday 02:00 desk is expressed.
 * Backed by the `apron_close_minute` domain.
 */
export const closeMinute = (name = 'close_minute') => integer(name).notNull();

/**
 * Coordinates are `numeric`, never float, so a stored position round-trips exactly.
 * Drizzle returns numerics as strings; `src/lib/geo` is the only place they are parsed.
 */
export const latitude = (name = 'latitude') => numeric(name, { precision: 9, scale: 6 });
export const longitude = (name = 'longitude') => numeric(name, { precision: 9, scale: 6 });

/** Aircraft and hangar dimensions: numeric(6,2), returned as an exact string. */
export const dimension = (name: string) => numeric(name, { precision: 6, scale: 2 });

/**
 * PostgreSQL `citext`: case-insensitive text, used for every email column so
 * `Ops@apron.local` and `ops@apron.local` are the same identity. Drizzle 0.39 has no
 * built-in helper for it, so it is declared here once.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});
