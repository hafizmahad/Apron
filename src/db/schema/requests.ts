import { relations } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import {
  citext,
  createdAt,
  instant,
  primaryId,
  prose,
  updatedAt,
} from './_shared';
import { aircraft, airports, fbos } from './geography';
import { serviceCategories } from './catalogue';
import { clientOrganizations, users } from './identity';
import type {
  PersonType,
  RequestChannel,
  RequestLineStatus,
  RequestPriority,
  RequestStatus,
  SelectionSource,
} from './enums';

/**
 * Requests and their service lines.
 *
 * Each line is independent: its own status, its own offer, its own SLA and its own
 * assignment. A decline on one line must not disturb another (CLAUDE.md §11, Journey B),
 * and the derived request status is computed from the set of line states rather than
 * assigned directly.
 */

export const requests = pgTable('requests', {
  id: primaryId(),
  /** `RQ-XXXXXX`, unique, shown to clients and providers. */
  reference: text('reference').notNull(),
  clientOrganizationId: uuid('client_organization_id')
    .notNull()
    .references(() => clientOrganizations.id, { onDelete: 'restrict' }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdVia: text('created_via').$type<RequestChannel>().notNull().default('ops'),

  /**
   * The user's own words, stored verbatim and never rewritten. If intake fails the
   * operator is still left with exactly what the client said (CLAUDE.md §22).
   */
  sourceSentence: prose('source_sentence'),

  airportId: uuid('airport_id')
    .notNull()
    .references(() => airports.id, { onDelete: 'restrict' }),
  /** Constrained by trigger to belong to `airportId` — a CHECK cannot read another table. */
  fboId: uuid('fbo_id').references(() => fbos.id, { onDelete: 'restrict' }),
  aircraftId: uuid('aircraft_id').references(() => aircraft.id, { onDelete: 'set null' }),
  flightReference: text('flight_reference'),

  /** UTC instants. Local wall time is never stored (CLAUDE.md §7). */
  arrivalUtc: instant('arrival_utc'),
  departureUtc: instant('departure_utc'),

  passengerCount: integer('passenger_count').notNull().default(0),
  crewCount: integer('crew_count').notNull().default(0),

  status: text('status').$type<RequestStatus>().notNull().default('draft'),
  priority: text('priority').$type<RequestPriority>().notNull().default('normal'),
  operationalNotes: prose('operational_notes'),

  /** Guest requests carry their own contact; the link token is stored hashed only. */
  guestContactName: text('guest_contact_name'),
  guestContactEmail: citext('guest_contact_email'),
  guestContactPhone: text('guest_contact_phone'),
  guestTokenHash: text('guest_token_hash'),
  guestTokenExpiresAt: instant('guest_token_expires_at'),

  confirmedAt: instant('confirmed_at'),
  completedAt: instant('completed_at'),
  cancelledAt: instant('cancelled_at'),
  cancellationReason: text('cancellation_reason'),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const requestPassengers = pgTable('request_passengers', {
  id: primaryId(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => requests.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull(),
  personType: text('person_type').$type<PersonType>().notNull().default('passenger'),
  /**
   * Released according to line state and explicit policy. The gate lives in
   * `src/domain/permissions` and is covered by RBAC tests — the column itself is not the
   * control (CLAUDE.md §5).
   */
  phone: text('phone'),
  email: citext('email'),
  notes: prose('notes'),
  isPrimary: boolean('is_primary').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
});

export const requestServiceLines = pgTable('request_service_lines', {
  id: primaryId(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => requests.id, { onDelete: 'cascade' }),
  serviceCategoryId: uuid('service_category_id')
    .notNull()
    .references(() => serviceCategories.id, { onDelete: 'restrict' }),
  sequence: integer('sequence').notNull().default(1),
  /** "Two cars" is quantity 2 on one line, never two lines. */
  quantity: integer('quantity').notNull().default(1),

  /** Validated at runtime against the category's `configSchemaJson` (ADR-008). */
  requirementsJson: jsonb('requirements_json').$type<Record<string, unknown>>().notNull(),

  /**
   * The window the service occupies, which is not the flight window: a hotel spans
   * nights, a hangar spans an overnight, a car meets an arrival.
   */
  serviceStartUtc: instant('service_start_utc'),
  serviceEndUtc: instant('service_end_utc'),

  status: text('status').$type<RequestLineStatus>().notNull().default('draft'),

  modelExplanation: text('model_explanation'),
  /** False whenever the model's choice failed verification and code fell back. */
  modelVerified: boolean('model_verified'),
  selectionSource: text('selection_source').$type<SelectionSource>(),

  acknowledgementDeadlineUtc: instant('acknowledgement_deadline_utc'),
  rematchCount: integer('rematch_count').notNull().default(0),
  failureReason: text('failure_reason'),

  /** Set in migration 0004 after `provider_offers` exists; typed here for queries. */
  currentOfferId: uuid('current_offer_id'),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const requestsRelations = relations(requests, ({ one, many }) => ({
  clientOrganization: one(clientOrganizations, {
    fields: [requests.clientOrganizationId],
    references: [clientOrganizations.id],
  }),
  createdBy: one(users, { fields: [requests.createdByUserId], references: [users.id] }),
  airport: one(airports, { fields: [requests.airportId], references: [airports.id] }),
  fbo: one(fbos, { fields: [requests.fboId], references: [fbos.id] }),
  aircraft: one(aircraft, { fields: [requests.aircraftId], references: [aircraft.id] }),
  passengers: many(requestPassengers),
  serviceLines: many(requestServiceLines),
}));

export const requestPassengersRelations = relations(requestPassengers, ({ one }) => ({
  request: one(requests, { fields: [requestPassengers.requestId], references: [requests.id] }),
}));

export const requestServiceLinesRelations = relations(requestServiceLines, ({ one }) => ({
  request: one(requests, { fields: [requestServiceLines.requestId], references: [requests.id] }),
  serviceCategory: one(serviceCategories, {
    fields: [requestServiceLines.serviceCategoryId],
    references: [serviceCategories.id],
  }),
}));

export type Request = typeof requests.$inferSelect;
export type NewRequest = typeof requests.$inferInsert;
export type RequestPassenger = typeof requestPassengers.$inferSelect;
export type NewRequestPassenger = typeof requestPassengers.$inferInsert;
export type RequestServiceLine = typeof requestServiceLines.$inferSelect;
export type NewRequestServiceLine = typeof requestServiceLines.$inferInsert;
