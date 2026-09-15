import { relations } from 'drizzle-orm';
import { bigint, boolean, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId, prose, updatedAt } from './_shared';
import { providerCompanies, users } from './identity';
import { requests, requestServiceLines } from './requests';
import type {
  AiOutcome,
  AiStage,
  AiValidationStatus,
  AiVerificationStatus,
  DeliveryChannel,
  DeliveryStatus,
  DocumentContentType,
  DocumentKind,
  NotificationSeverity,
  StorageDriver,
  ThreadScope,
} from './enums';

/**
 * Messaging, notifications, documents and AI call records.
 */

/**
 * A thread is scoped to a request and optionally to one provider company, which makes
 * "provider A must not see provider B's thread" a single checkable predicate rather than
 * a join the permission layer could forget.
 */
export const messageThreads = pgTable('message_threads', {
  id: primaryId(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => requests.id, { onDelete: 'cascade' }),
  requestServiceLineId: uuid('request_service_line_id').references(() => requestServiceLines.id, {
    onDelete: 'cascade',
  }),
  providerCompanyId: uuid('provider_company_id').references(() => providerCompanies.id, {
    onDelete: 'cascade',
  }),
  scope: text('scope').$type<ThreadScope>().notNull(),
  subject: prose('subject'),
  closedAt: instant('closed_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const messages = pgTable('messages', {
  id: primaryId(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => messageThreads.id, { onDelete: 'cascade' }),
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  authorLabel: text('author_label').notNull().default('system'),
  body: text('body').notNull(),
  /** Lifecycle entries ("offer expired, re-matching") rendered differently from prose. */
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: createdAt(),
});

export const notifications = pgTable('notifications', {
  id: primaryId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: prose('body'),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  severity: text('severity').$type<NotificationSeverity>().notNull().default('info'),
  readAt: instant('read_at'),
  createdAt: createdAt(),
});

/**
 * Outbound delivery attempts. `idempotencyKey` is what makes a job retry safe: re-running
 * a handler cannot produce a second email (CLAUDE.md §18 "never send duplicate
 * notifications on job retries").
 */
export const notificationDeliveries = pgTable('notification_deliveries', {
  id: primaryId(),
  idempotencyKey: text('idempotency_key').notNull(),
  channel: text('channel').$type<DeliveryChannel>().notNull(),
  recipient: text('recipient').notNull(),
  subject: text('subject'),
  body: prose('body'),
  status: text('status').$type<DeliveryStatus>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  sentAt: instant('sent_at'),
  notificationId: uuid('notification_id').references(() => notifications.id, {
    onDelete: 'set null',
  }),
  correlationId: text('correlation_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const documents = pgTable('documents', {
  id: primaryId(),
  requestId: uuid('request_id').references(() => requests.id, { onDelete: 'cascade' }),
  requestServiceLineId: uuid('request_service_line_id').references(() => requestServiceLines.id, {
    onDelete: 'cascade',
  }),
  providerCompanyId: uuid('provider_company_id').references(() => providerCompanies.id, {
    onDelete: 'cascade',
  }),
  kind: text('kind').$type<DocumentKind>().notNull(),
  title: text('title').notNull(),
  storageDriver: text('storage_driver').$type<StorageDriver>().notNull().default('filesystem'),
  storageKey: text('storage_key').notNull(),
  /** Constrained to an allow-list, so an arbitrary type cannot be stored then served. */
  contentType: text('content_type').$type<DocumentContentType>().notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  checksumSha256: text('checksum_sha256'),
  generatedByUserId: uuid('generated_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: createdAt(),
});

/**
 * AI call records — reliability only (ADR-015).
 *
 * There are deliberately no token-count and no cost columns anywhere in this table.
 * What is recorded is what is needed to diagnose a failure and to populate the Admin
 * console: stage, prompt version, model, latency, and the validation/verification
 * outcome, with a required error category on every non-success row so the UI never has
 * to show a bare "something went wrong" (CLAUDE.md §28).
 */
export const aiCalls = pgTable('ai_calls', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  occurredAt: createdAt('occurred_at'),

  stage: text('stage').$type<AiStage>().notNull(),
  promptId: text('prompt_id').notNull(),
  promptVersion: text('prompt_version').notNull(),
  provider: text('provider').notNull().default('openai'),
  model: text('model').notNull(),

  latencyMs: integer('latency_ms').notNull(),
  attempt: integer('attempt').notNull().default(1),

  outcome: text('outcome').$type<AiOutcome>().notNull(),
  validationStatus: text('validation_status').$type<AiValidationStatus>().notNull(),
  verificationStatus: text('verification_status').$type<AiVerificationStatus>(),
  errorCategory: text('error_category'),
  errorDetail: text('error_detail'),

  requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
  requestServiceLineId: uuid('request_service_line_id').references(() => requestServiceLines.id, {
    onDelete: 'set null',
  }),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  correlationId: text('correlation_id'),

  /** Retained only when `AI_STORE_PROMPT_BODIES` is on; may contain client/passenger data. */
  promptBody: text('prompt_body'),
  responseBody: text('response_body'),
});

export const messageThreadsRelations = relations(messageThreads, ({ one, many }) => ({
  request: one(requests, { fields: [messageThreads.requestId], references: [requests.id] }),
  serviceLine: one(requestServiceLines, {
    fields: [messageThreads.requestServiceLineId],
    references: [requestServiceLines.id],
  }),
  providerCompany: one(providerCompanies, {
    fields: [messageThreads.providerCompanyId],
    references: [providerCompanies.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  thread: one(messageThreads, { fields: [messages.threadId], references: [messageThreads.id] }),
  author: one(users, { fields: [messages.authorUserId], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  request: one(requests, { fields: [documents.requestId], references: [requests.id] }),
}));

export type MessageThread = typeof messageThreads.$inferSelect;
export type NewMessageThread = typeof messageThreads.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDelivery = typeof notificationDeliveries.$inferInsert;
export type DocumentRecord = typeof documents.$inferSelect;
export type NewDocumentRecord = typeof documents.$inferInsert;
export type AiCall = typeof aiCalls.$inferSelect;
export type NewAiCall = typeof aiCalls.$inferInsert;
