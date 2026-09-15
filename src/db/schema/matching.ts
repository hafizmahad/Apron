import { relations } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId, prose, requiredInstant, updatedAt } from './_shared';
import { providerCompanies, users } from './identity';
import { requestServiceLines } from './requests';
import type { ConfidenceLevel, OfferStatus, SelectionSource } from './enums';

/**
 * Offers and the decision trace.
 *
 * Both tables are append-only in spirit: an expired or declined offer is never mutated
 * into the next one, and a re-match writes a new `matchAttempts` row. That is what lets
 * Operations answer "why was provider B rejected?" months later, after coverage and
 * capacity have changed (CLAUDE.md §6, §12).
 */

/**
 * One candidate as the engine saw it, frozen into the offer's snapshot.
 * Reason codes are the structured vocabulary from `src/domain/matching/reasons.ts`.
 */
export interface CandidateSnapshot {
  readonly providerCompanyId: string;
  readonly providerName: string;
  readonly rank: number;
  readonly eligible: boolean;
  readonly reasonCodes: readonly string[];
  readonly spareCapacity: number;
  readonly leadTimeMarginMinutes: number | null;
  readonly sameProviderOnOtherLines: number;
}

export const providerOffers = pgTable('provider_offers', {
  id: primaryId(),
  requestServiceLineId: uuid('request_service_line_id')
    .notNull()
    .references(() => requestServiceLines.id, { onDelete: 'cascade' }),
  providerCompanyId: uuid('provider_company_id')
    .notNull()
    .references(() => providerCompanies.id, { onDelete: 'restrict' }),
  attemptNumber: integer('attempt_number').notNull().default(1),
  rankAtSelection: integer('rank_at_selection').notNull(),

  /** The exact inputs behind this offer, so it can be explained long afterwards. */
  eligibilitySnapshot: jsonb('eligibility_snapshot')
    .$type<{ readonly candidates: readonly CandidateSnapshot[]; readonly engineVersion: string }>()
    .notNull(),
  selectionReason: prose('selection_reason'),
  selectionSource: text('selection_source')
    .$type<SelectionSource>()
    .notNull()
    .default('deterministic'),

  status: text('status').$type<OfferStatus>().notNull().default('sent'),
  sentAt: requiredInstant('sent_at').defaultNow(),
  expiresAt: requiredInstant('expires_at'),
  acknowledgedAt: instant('acknowledged_at'),
  acknowledgedByUserId: uuid('acknowledged_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  declinedAt: instant('declined_at'),
  declinedByUserId: uuid('declined_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  declineReason: text('decline_reason'),
  expiredAt: instant('expired_at'),
  withdrawnAt: instant('withdrawn_at'),
  withdrawnReason: text('withdrawn_reason'),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One row per evaluation of a line: every candidate considered, eligible and rejected,
 * each with its reason codes, plus whether the model was consulted and whether its answer
 * survived verification.
 */
export const matchAttempts = pgTable('match_attempts', {
  id: primaryId(),
  requestServiceLineId: uuid('request_service_line_id')
    .notNull()
    .references(() => requestServiceLines.id, { onDelete: 'cascade' }),
  attemptNumber: integer('attempt_number').notNull(),
  engineVersion: text('engine_version').notNull(),

  evaluatedAt: createdAt('evaluated_at'),
  /**
   * The instant the engine treated as "now". Supplied by the caller and stored, because
   * the pure functions never read the clock themselves (ADR-009).
   */
  evaluationNowUtc: requiredInstant('evaluation_now_utc'),

  eligibleCandidates: jsonb('eligible_candidates').$type<readonly CandidateSnapshot[]>().notNull(),
  rejectedCandidates: jsonb('rejected_candidates').$type<readonly CandidateSnapshot[]>().notNull(),
  /** Providers held out of this attempt — typically because they already declined. */
  excludedProviderIds: uuid('excluded_provider_ids').array().notNull().default([]),

  chosenProviderId: uuid('chosen_provider_id').references(() => providerCompanies.id, {
    onDelete: 'set null',
  }),
  /** What the deterministic ranker would have picked, recorded even when AI agreed. */
  deterministicTopId: uuid('deterministic_top_id').references(() => providerCompanies.id, {
    onDelete: 'set null',
  }),

  aiConsulted: boolean('ai_consulted').notNull().default(false),
  aiChosenProviderId: uuid('ai_chosen_provider_id').references(() => providerCompanies.id, {
    onDelete: 'set null',
  }),
  aiVerified: boolean('ai_verified'),
  aiReason: text('ai_reason'),
  aiConfidence: text('ai_confidence').$type<ConfidenceLevel>(),
  /** Required by a CHECK whenever the model was consulted and verification rejected it. */
  fallbackReason: text('fallback_reason'),

  createdAt: createdAt(),
});

export const providerOffersRelations = relations(providerOffers, ({ one }) => ({
  serviceLine: one(requestServiceLines, {
    fields: [providerOffers.requestServiceLineId],
    references: [requestServiceLines.id],
  }),
  providerCompany: one(providerCompanies, {
    fields: [providerOffers.providerCompanyId],
    references: [providerCompanies.id],
  }),
}));

export const matchAttemptsRelations = relations(matchAttempts, ({ one }) => ({
  serviceLine: one(requestServiceLines, {
    fields: [matchAttempts.requestServiceLineId],
    references: [requestServiceLines.id],
  }),
  chosenProvider: one(providerCompanies, {
    fields: [matchAttempts.chosenProviderId],
    references: [providerCompanies.id],
  }),
}));

export type ProviderOffer = typeof providerOffers.$inferSelect;
export type NewProviderOffer = typeof providerOffers.$inferInsert;
export type MatchAttempt = typeof matchAttempts.$inferSelect;
export type NewMatchAttempt = typeof matchAttempts.$inferInsert;
