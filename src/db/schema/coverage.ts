import { relations } from 'drizzle-orm';
import { boolean, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import {
  activeFlag,
  closeMinute,
  createdAt,
  openMinute,
  primaryId,
  prose,
  requiredInstant,
  updatedAt,
  weekday,
} from './_shared';
import { airports, fbos } from './geography';
import { serviceCategories } from './catalogue';
import { providerCompanies } from './identity';
import type { CoverageScope } from './enums';

/**
 * Which provider offers which service at which airport or FBO.
 *
 * `airportId` is NOT NULL and there is no "all airports" representation: a NULL location
 * never means everywhere (CLAUDE.md §6). FBO-specific coverage sets `fboId` and declares
 * `scope = 'fbo'`; the two are kept consistent by a CHECK constraint.
 */
export const providerCoverage = pgTable('provider_coverage', {
  id: primaryId(),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'cascade' }),
  serviceCategoryId: uuid('service_category_id')
    .notNull()
    .references(() => serviceCategories.id, { onDelete: 'restrict' }),
  scope: text('scope').$type<CoverageScope>().notNull().default('airport'),
  airportId: uuid('airport_id')
    .notNull()
    .references(() => airports.id, { onDelete: 'restrict' }),
  fboId: uuid('fbo_id').references(() => fbos.id, { onDelete: 'restrict' }),

  /**
   * Concurrent units of this service the provider can sustain here. Compared against
   * overlapping committed assignments at evaluation time — never a running counter that
   * could drift.
   */
  totalCapacity: integer('total_capacity').notNull().default(1),
  /** Minimum notice from "now" to the start of the service window. */
  leadTimeMinutes: integer('lead_time_minutes').notNull().default(120),
  /** Furthest ahead a booking is accepted. NULL means no upper bound. */
  maxNoticeDays: integer('max_notice_days'),
  /** When true, `providerCoverageHours` is not consulted. */
  is247: boolean('is_24_7').notNull().default(false),

  notes: prose('notes'),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Desk hours for a coverage row, in the airport's zone. Distinct from whether a driver
 * happens to be free — a staffed desk is what lets a provider accept and coordinate work.
 */
export const providerCoverageHours = pgTable('provider_coverage_hours', {
  id: primaryId(),
  coverageId: uuid('coverage_id')
    .notNull()
    .references(() => providerCoverage.id, { onDelete: 'cascade' }),
  weekday: weekday(),
  openMinute: openMinute(),
  closeMinute: closeMinute(),
});

/** Company-wide when `coverageId` is null, otherwise scoped to one service/location. */
export const providerBlackouts = pgTable('provider_blackouts', {
  id: primaryId(),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'cascade' }),
  coverageId: uuid('coverage_id').references(() => providerCoverage.id, { onDelete: 'cascade' }),
  startsAt: requiredInstant('starts_at'),
  endsAt: requiredInstant('ends_at'),
  reason: prose('reason'),
  createdAt: createdAt(),
});

export const providerCoverageRelations = relations(providerCoverage, ({ one, many }) => ({
  providerCompany: one(providerCompanies, {
    fields: [providerCoverage.providerCompanyId],
    references: [providerCompanies.id],
  }),
  serviceCategory: one(serviceCategories, {
    fields: [providerCoverage.serviceCategoryId],
    references: [serviceCategories.id],
  }),
  airport: one(airports, { fields: [providerCoverage.airportId], references: [airports.id] }),
  fbo: one(fbos, { fields: [providerCoverage.fboId], references: [fbos.id] }),
  hours: many(providerCoverageHours),
  blackouts: many(providerBlackouts),
}));

export const providerCoverageHoursRelations = relations(providerCoverageHours, ({ one }) => ({
  coverage: one(providerCoverage, {
    fields: [providerCoverageHours.coverageId],
    references: [providerCoverage.id],
  }),
}));

export const providerBlackoutsRelations = relations(providerBlackouts, ({ one }) => ({
  providerCompany: one(providerCompanies, {
    fields: [providerBlackouts.providerCompanyId],
    references: [providerCompanies.id],
  }),
  coverage: one(providerCoverage, {
    fields: [providerBlackouts.coverageId],
    references: [providerCoverage.id],
  }),
}));

export type ProviderCoverage = typeof providerCoverage.$inferSelect;
export type NewProviderCoverage = typeof providerCoverage.$inferInsert;
export type ProviderCoverageHour = typeof providerCoverageHours.$inferSelect;
export type ProviderBlackout = typeof providerBlackouts.$inferSelect;
export type NewProviderBlackout = typeof providerBlackouts.$inferInsert;
