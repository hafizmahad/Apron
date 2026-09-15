import { relations } from 'drizzle-orm';
import { boolean, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId, prose, requiredInstant, updatedAt } from './_shared';
import { providerCompanies, users } from './identity';
import { requestServiceLines } from './requests';
import { providerOffers } from './matching';
import {
  cateringCapabilities,
  drivers,
  fuelCapabilities,
  hangarResources,
  hotelRoomTypes,
  securityOfficers,
  vehicles,
} from './resources';
import type { AssignmentStatus, ResourceKind } from './enums';

/**
 * Confirmed concrete assignments.
 *
 * `assignmentResources` is the anti-double-booking table. One row per concrete resource
 * committed to an assignment; exactly one resource foreign key is set, selected by
 * `resourceKind` and enforced by a CHECK.
 *
 * Four `EXCLUDE USING gist` constraints over `tstzrange(start_utc, end_utc, '[)')` make
 * it impossible for two live rows to overlap in time on the same vehicle, driver, officer
 * or hangar bay — the same half-open semantics as `overlaps()` in
 * `src/lib/time/interval.ts`, so the application and the database agree exactly on what a
 * conflict is (ADR-002, CLAUDE.md §30).
 *
 * Hotel rooms, catering and fuel are pooled capacity rather than singular objects:
 * concurrent rows are legitimate up to the pool size, which is checked under a row lock
 * inside the assignment transaction.
 */

export const assignments = pgTable('assignments', {
  id: primaryId(),
  requestServiceLineId: uuid('request_service_line_id')
    .notNull()
    .references(() => requestServiceLines.id, { onDelete: 'cascade' }),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'restrict' }),
  providerOfferId: uuid('provider_offer_id').references(() => providerOffers.id, {
    onDelete: 'set null',
  }),
  status: text('status').$type<AssignmentStatus>().notNull().default('planned'),
  startUtc: requiredInstant('start_utc'),
  endUtc: requiredInstant('end_utc'),
  notes: prose('notes'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  releasedAt: instant('released_at'),
  releaseReason: text('release_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const assignmentResources = pgTable('assignment_resources', {
  id: primaryId(),
  assignmentId: uuid('assignment_id')
    .notNull()
    .references(() => assignments.id, { onDelete: 'cascade' }),
  resourceKind: text('resource_kind').$type<ResourceKind>().notNull(),

  vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'restrict' }),
  driverId: uuid('driver_id').references(() => drivers.id, { onDelete: 'restrict' }),
  officerId: uuid('officer_id').references(() => securityOfficers.id, { onDelete: 'restrict' }),
  hotelRoomTypeId: uuid('hotel_room_type_id').references(() => hotelRoomTypes.id, {
    onDelete: 'restrict',
  }),
  cateringCapabilityId: uuid('catering_capability_id').references(() => cateringCapabilities.id, {
    onDelete: 'restrict',
  }),
  fuelCapabilityId: uuid('fuel_capability_id').references(() => fuelCapabilities.id, {
    onDelete: 'restrict',
  }),
  hangarResourceId: uuid('hangar_resource_id').references(() => hangarResources.id, {
    onDelete: 'restrict',
  }),

  /** Rooms booked, gallons uplifted, covers catered. 1 for singular resources. */
  quantity: integer('quantity').notNull().default(1),

  startUtc: requiredInstant('start_utc'),
  endUtc: requiredInstant('end_utc'),

  /**
   * Released rows stay for the audit trail but stop blocking the resource — which is why
   * the exclusion constraints carry `where (... and released = false)`.
   */
  released: boolean('released').notNull().default(false),
  releasedAt: instant('released_at'),

  notes: prose('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const assignmentsRelations = relations(assignments, ({ one, many }) => ({
  serviceLine: one(requestServiceLines, {
    fields: [assignments.requestServiceLineId],
    references: [requestServiceLines.id],
  }),
  providerCompany: one(providerCompanies, {
    fields: [assignments.providerCompanyId],
    references: [providerCompanies.id],
  }),
  offer: one(providerOffers, {
    fields: [assignments.providerOfferId],
    references: [providerOffers.id],
  }),
  resources: many(assignmentResources),
}));

export const assignmentResourcesRelations = relations(assignmentResources, ({ one }) => ({
  assignment: one(assignments, {
    fields: [assignmentResources.assignmentId],
    references: [assignments.id],
  }),
  vehicle: one(vehicles, { fields: [assignmentResources.vehicleId], references: [vehicles.id] }),
  driver: one(drivers, { fields: [assignmentResources.driverId], references: [drivers.id] }),
  officer: one(securityOfficers, {
    fields: [assignmentResources.officerId],
    references: [securityOfficers.id],
  }),
  hotelRoomType: one(hotelRoomTypes, {
    fields: [assignmentResources.hotelRoomTypeId],
    references: [hotelRoomTypes.id],
  }),
  cateringCapability: one(cateringCapabilities, {
    fields: [assignmentResources.cateringCapabilityId],
    references: [cateringCapabilities.id],
  }),
  fuelCapability: one(fuelCapabilities, {
    fields: [assignmentResources.fuelCapabilityId],
    references: [fuelCapabilities.id],
  }),
  hangarResource: one(hangarResources, {
    fields: [assignmentResources.hangarResourceId],
    references: [hangarResources.id],
  }),
}));

export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;
export type AssignmentResource = typeof assignmentResources.$inferSelect;
export type NewAssignmentResource = typeof assignmentResources.$inferInsert;
