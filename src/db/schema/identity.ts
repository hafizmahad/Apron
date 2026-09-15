import { relations } from 'drizzle-orm';
import { bigint, boolean, date, inet, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import {
  activeFlag,
  citext,
  createdAt,
  instant,
  primaryId,
  prose,
  requiredInstant,
  updatedAt,
} from './_shared';
import type { ProviderCompanyStatus, UserRole, UserStatus } from './enums';

/**
 * Tenancy and identity (CLAUDE.md §5).
 *
 * Two tenant axes exist, and they are mutually exclusive for any single user:
 * `providerCompanyId` scopes a provider user to their own company, and
 * `clientOrganizationId` scopes a client user to their own requests. Platform and
 * operations roles belong to neither. The pairing is enforced by CHECK constraints in
 * `0002_identity_and_audit.sql`, so no code path can create a provider user without a
 * company, or an operations user scoped to one.
 */

export const clientOrganizations = pgTable('client_organizations', {
  id: primaryId(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  primaryContactName: text('primary_contact_name'),
  primaryContactEmail: citext('primary_contact_email'),
  primaryContactPhone: text('primary_contact_phone'),
  billingEmail: citext('billing_email'),
  billingCurrency: text('billing_currency').notNull().default('USD'),
  notes: prose('notes'),
  active: activeFlag(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const providerCompanies = pgTable('provider_companies', {
  id: primaryId(),
  legalName: text('legal_name').notNull(),
  displayName: text('display_name').notNull(),
  slug: text('slug').notNull(),
  status: text('status').$type<ProviderCompanyStatus>().notNull().default('pending'),
  /**
   * The platform's own quality ordering, 1..1000, lower sorts first. Used as a
   * deterministic tie-break in the ranker (CLAUDE.md §9) — never as an eligibility gate.
   */
  rank: integer('rank').notNull().default(500),
  primaryContactName: text('primary_contact_name'),
  primaryContactEmail: citext('primary_contact_email'),
  primaryContactPhone: text('primary_contact_phone'),
  dispatchEmail: citext('dispatch_email'),
  dispatchPhone: text('dispatch_phone'),
  address: text('address'),
  website: text('website'),
  countryCode: text('country_code'),
  insuranceReference: text('insurance_reference'),
  insuranceExpiresAt: date('insurance_expires_at'),
  licenseReference: text('license_reference'),
  billingEmail: citext('billing_email'),
  billingCurrency: text('billing_currency').notNull().default('USD'),
  /** Real logos arrive through the provider media workflow; until then a placeholder. */
  logoStorageKey: text('logo_storage_key'),
  notes: prose('notes'),
  active: activeFlag(),
  approvedAt: instant('approved_at'),
  approvedByUserId: uuid('approved_by_user_id'),
  suspendedAt: instant('suspended_at'),
  suspensionReason: text('suspension_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable('users', {
  id: primaryId(),
  email: citext('email').notNull(),
  /** Argon2id (ADR-006). Never selected into anything that reaches a client component. */
  passwordHash: text('password_hash').notNull(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  role: text('role').$type<UserRole>().notNull(),
  providerCompanyId: uuid('provider_company_id').references(() => providerCompanies.id, {
    onDelete: 'restrict',
  }),
  clientOrganizationId: uuid('client_organization_id').references(() => clientOrganizations.id, {
    onDelete: 'restrict',
  }),
  status: text('status').$type<UserStatus>().notNull().default('active'),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  lastLoginAt: instant('last_login_at'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: instant('locked_until'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Server-side opaque sessions (ADR-006). The cookie carries a random 256-bit token; only
 * its SHA-256 hash is stored, so a database disclosure does not hand over live sessions.
 */
export const sessions = pgTable('sessions', {
  id: primaryId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  /** Per-session secret behind the double-submit CSRF token (CLAUDE.md §27). */
  csrfSecret: text('csrf_secret').notNull(),
  expiresAt: requiredInstant('expires_at'),
  createdAt: createdAt(),
  lastSeenAt: requiredInstant('last_seen_at').defaultNow(),
  revokedAt: instant('revoked_at'),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
});

/**
 * The audit trail. Every meaningful write lands here with actor, role, before/after and
 * the correlation id that ties it back to the HTTP request or job that caused it.
 * A database CHECK requires a reason on the actions that demand one (overrides,
 * cancellations, suspensions) — it is not left to the caller.
 */
export const auditEvents = pgTable('audit_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  occurredAt: createdAt('occurred_at'),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorRole: text('actor_role').$type<UserRole>(),
  actorLabel: text('actor_label').notNull().default('system'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  beforeState: jsonb('before_state'),
  afterState: jsonb('after_state'),
  reason: text('reason'),
  correlationId: text('correlation_id'),
  ipAddress: inet('ip_address'),
});

export const clientOrganizationsRelations = relations(clientOrganizations, ({ many }) => ({
  users: many(users),
}));

export const providerCompaniesRelations = relations(providerCompanies, ({ many }) => ({
  users: many(users),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  providerCompany: one(providerCompanies, {
    fields: [users.providerCompanyId],
    references: [providerCompanies.id],
  }),
  clientOrganization: one(clientOrganizations, {
    fields: [users.clientOrganizationId],
    references: [clientOrganizations.id],
  }),
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export type ClientOrganization = typeof clientOrganizations.$inferSelect;
export type NewClientOrganization = typeof clientOrganizations.$inferInsert;
export type ProviderCompany = typeof providerCompanies.$inferSelect;
export type NewProviderCompany = typeof providerCompanies.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
