import { relations } from 'drizzle-orm';
import { bigint, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import {
  activeFlag,
  closeMinute,
  createdAt,
  instant,
  openMinute,
  primaryId,
  requiredInstant,
  updatedAt,
} from './_shared';
import { airports } from './geography';
import { serviceCategories } from './catalogue';
import { providerCompanies, users } from './identity';
import { requests, requestServiceLines } from './requests';
import type { QuoteStatus, RateCardItemKind } from './enums';

/**
 * The commercial layer (CLAUDE.md §20).
 *
 * Modelled cleanly but kept off the fulfilment critical path: a request can be matched,
 * offered, acknowledged and assigned with no rate card present at all, and nothing in the
 * matching engine reads these tables.
 *
 * Every amount is an integer in minor units with an ISO-4217 code (ADR-010). There is no
 * float money anywhere; `src/lib/money` owns all arithmetic. The LLM may explain a quote
 * but never computes one — and the database independently checks that the totals add up.
 */

export const rateCards = pgTable('rate_cards', {
  id: primaryId(),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'cascade' }),
  serviceCategoryId: uuid('service_category_id')
    .notNull()
    .references(() => serviceCategories.id, { onDelete: 'restrict' }),
  /** Null means the provider's default card for this service across their coverage. */
  airportId: uuid('airport_id').references(() => airports.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('USD'),
  version: integer('version').notNull().default(1),
  effectiveFrom: requiredInstant('effective_from').defaultNow(),
  effectiveTo: instant('effective_to'),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const rateCardItems = pgTable('rate_card_items', {
  id: primaryId(),
  rateCardId: uuid('rate_card_id')
    .notNull()
    .references(() => rateCards.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  label: text('label').notNull(),
  kind: text('kind').$type<RateCardItemKind>().notNull(),
  unitAmountMinor: bigint('unit_amount_minor', { mode: 'number' }).notNull(),
  minimumAmountMinor: bigint('minimum_amount_minor', { mode: 'number' }),
  /** Basis points, so a 7.5% markup is exactly 750 and never a float. */
  percentageBps: integer('percentage_bps'),
  /** After-hours fees carry the local window they apply to; a CHECK requires both. */
  appliesFromMinute: openMinute('applies_from_minute'),
  appliesToMinute: closeMinute('applies_to_minute'),
  sortOrder: integer('sort_order').notNull().default(100),
});

/**
 * Versioned and immutable once issued: a new version is a new row, so a client
 * confirmation always refers to exactly the figures they were shown.
 */
export const quotes = pgTable('quotes', {
  id: primaryId(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => requests.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  currency: text('currency').notNull().default('USD'),
  subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
  platformFeeMinor: bigint('platform_fee_minor', { mode: 'number' }).notNull().default(0),
  /** A CHECK enforces `total = subtotal + platformFee`; bad arithmetic cannot persist. */
  totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
  status: text('status').$type<QuoteStatus>().notNull().default('draft'),
  issuedAt: instant('issued_at'),
  acceptedAt: instant('accepted_at'),
  voidedAt: instant('voided_at'),
  voidReason: text('void_reason'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const quoteLines = pgTable('quote_lines', {
  id: primaryId(),
  quoteId: uuid('quote_id')
    .notNull()
    .references(() => quotes.id, { onDelete: 'cascade' }),
  requestServiceLineId: uuid('request_service_line_id').references(() => requestServiceLines.id, {
    onDelete: 'set null',
  }),
  providerCompanyId: uuid('provider_company_id').references(() => providerCompanies.id, {
    onDelete: 'set null',
  }),
  rateCardItemId: uuid('rate_card_item_id').references(() => rateCardItems.id, {
    onDelete: 'set null',
  }),
  label: text('label').notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitAmountMinor: bigint('unit_amount_minor', { mode: 'number' }).notNull(),
  /** A CHECK enforces `amount = unit x quantity`. */
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  sortOrder: integer('sort_order').notNull().default(100),
});

export const rateCardsRelations = relations(rateCards, ({ one, many }) => ({
  providerCompany: one(providerCompanies, {
    fields: [rateCards.providerCompanyId],
    references: [providerCompanies.id],
  }),
  serviceCategory: one(serviceCategories, {
    fields: [rateCards.serviceCategoryId],
    references: [serviceCategories.id],
  }),
  items: many(rateCardItems),
}));

export const rateCardItemsRelations = relations(rateCardItems, ({ one }) => ({
  rateCard: one(rateCards, { fields: [rateCardItems.rateCardId], references: [rateCards.id] }),
}));

export const quotesRelations = relations(quotes, ({ one, many }) => ({
  request: one(requests, { fields: [quotes.requestId], references: [requests.id] }),
  lines: many(quoteLines),
}));

export const quoteLinesRelations = relations(quoteLines, ({ one }) => ({
  quote: one(quotes, { fields: [quoteLines.quoteId], references: [quotes.id] }),
  serviceLine: one(requestServiceLines, {
    fields: [quoteLines.requestServiceLineId],
    references: [requestServiceLines.id],
  }),
}));

export type RateCard = typeof rateCards.$inferSelect;
export type NewRateCard = typeof rateCards.$inferInsert;
export type RateCardItem = typeof rateCardItems.$inferSelect;
export type NewRateCardItem = typeof rateCardItems.$inferInsert;
export type Quote = typeof quotes.$inferSelect;
export type NewQuote = typeof quotes.$inferInsert;
export type QuoteLine = typeof quoteLines.$inferSelect;
export type NewQuoteLine = typeof quoteLines.$inferInsert;
