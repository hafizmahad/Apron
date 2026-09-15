import '@/lib/server-guard';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, withTransaction, type Executor } from '@/db/client';
import {
  messageThreads,
  messages,
  providerCompanies,
  requestServiceLines,
  requests,
  serviceCategories,
  users,
} from '@/db/schema';
import type { ThreadScope, UserRole } from '@/db/schema/enums';
import { recordAuditEvent } from '@/domain/audit';
import { ApronError } from '@/lib/errors';
import { logger } from '@/lib/logging';

/**
 * Request-scoped message threads (CLAUDE.md §18).
 *
 * The scoping rule is the whole design: a thread belongs to a request, and a *provider*
 * thread additionally names exactly one provider company. The database enforces the pairing
 * (`message_threads_scope_consistent`), so "provider A reads provider B's thread" is not a
 * join this code could forget — the row either names your company or it does not.
 *
 * Three scopes:
 *
 *  - `internal` — operations and admin only. Providers and clients never see these.
 *  - `provider` — operations and the one named provider company.
 *  - `client`   — operations and the client organisation that owns the request.
 *
 * Every read goes through {@link visibleThreadFilter}, so there is one place where
 * visibility is decided rather than one per query.
 */

export interface ThreadActor {
  readonly userId: string;
  readonly role: UserRole;
  readonly label: string;
  readonly providerCompanyId: string | null;
  readonly clientOrganizationId: string | null;
}

const OPERATIONS_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'platform_admin',
  'operations_manager',
  'operations_agent',
]);

function isOperationsActor(actor: ThreadActor): boolean {
  return OPERATIONS_ROLES.has(actor.role);
}

/**
 * The SQL predicate describing every thread this actor may read.
 *
 * Operations and admin see all of them. A provider user sees only `provider` threads naming
 * their own company. A client sees only `client` threads on their own organisation's
 * requests. Anyone else sees nothing — the predicate is `false`, not an empty filter.
 */
function visibleThreadFilter(actor: ThreadActor) {
  if (isOperationsActor(actor)) return sql`true`;

  if (actor.providerCompanyId !== null) {
    return and(
      eq(messageThreads.scope, 'provider'),
      eq(messageThreads.providerCompanyId, actor.providerCompanyId),
    );
  }

  if (actor.clientOrganizationId !== null) {
    return and(
      eq(messageThreads.scope, 'client'),
      eq(requests.clientOrganizationId, actor.clientOrganizationId),
    );
  }

  // No tenancy and not operations: this actor has no threads at all.
  return sql`false`;
}

/** Whether this actor may post into a thread, as opposed to merely read it. */
function canPostTo(actor: ThreadActor, thread: { scope: ThreadScope; providerCompanyId: string | null }): boolean {
  if (isOperationsActor(actor)) return true;

  if (thread.scope === 'provider') {
    return (
      actor.providerCompanyId !== null && actor.providerCompanyId === thread.providerCompanyId
    );
  }

  return false;
}

// ---------------------------------------------------------------------------
// threads
// ---------------------------------------------------------------------------

export interface ThreadSummary {
  readonly id: string;
  readonly requestId: string;
  readonly reference: string;
  readonly scope: ThreadScope;
  readonly subject: string;
  readonly providerName: string | null;
  readonly serviceName: string | null;
  readonly messageCount: number;
  readonly lastMessageAt: Date | null;
  readonly lastMessagePreview: string | null;
  readonly closedAt: Date | null;
}

/** Every thread this actor may read, newest activity first. */
export async function loadThreads(
  actor: ThreadActor,
  options: { readonly requestId?: string; readonly limit?: number } = {},
  executor: Executor = getDb(),
): Promise<readonly ThreadSummary[]> {
  const filters = [visibleThreadFilter(actor)];
  if (options.requestId !== undefined) {
    filters.push(eq(messageThreads.requestId, options.requestId));
  }

  const rows = await executor
    .select({
      id: messageThreads.id,
      requestId: messageThreads.requestId,
      reference: requests.reference,
      scope: messageThreads.scope,
      subject: messageThreads.subject,
      providerName: providerCompanies.displayName,
      serviceName: serviceCategories.name,
      closedAt: messageThreads.closedAt,
      messageCount: sql<number>`(
        select count(*)::int from messages m where m.thread_id = message_threads.id
      )`,
      lastMessageAt: sql<Date | null>`(
        select max(m.created_at) from messages m where m.thread_id = message_threads.id
      )`,
      lastMessagePreview: sql<string | null>`(
        select left(m.body, 160) from messages m
        where m.thread_id = message_threads.id
        order by m.created_at desc, m.id desc limit 1
      )`,
    })
    .from(messageThreads)
    .innerJoin(requests, eq(requests.id, messageThreads.requestId))
    .leftJoin(providerCompanies, eq(providerCompanies.id, messageThreads.providerCompanyId))
    .leftJoin(
      requestServiceLines,
      eq(requestServiceLines.id, messageThreads.requestServiceLineId),
    )
    .leftJoin(serviceCategories, eq(serviceCategories.id, requestServiceLines.serviceCategoryId))
    .where(and(...filters))
    .orderBy(desc(messageThreads.updatedAt), desc(messageThreads.id))
    .limit(options.limit ?? 100);

  return rows.map((row) => ({
    id: row.id,
    requestId: row.requestId,
    reference: row.reference,
    scope: row.scope,
    subject: row.subject,
    providerName: row.providerName,
    serviceName: row.serviceName,
    messageCount: row.messageCount,
    // A raw SQL aggregate comes back as a string from the driver; parse it rather than
    // lying about the type and throwing on `.getTime()` later.
    lastMessageAt: parseInstant(row.lastMessageAt),
    lastMessagePreview: row.lastMessagePreview,
    closedAt: row.closedAt,
  }));
}

function parseInstant(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface ThreadMessage {
  readonly id: string;
  readonly body: string;
  readonly isSystem: boolean;
  readonly authorLabel: string;
  readonly authorName: string | null;
  readonly authorRole: UserRole | null;
  readonly createdAt: Date;
}

export interface ThreadDetail extends ThreadSummary {
  readonly canPost: boolean;
  readonly messages: readonly ThreadMessage[];
}

/**
 * One thread with its messages, or null when this actor may not read it.
 *
 * Null rather than a thrown error, so a caller renders "not found" and a probing request
 * learns nothing about whether the id exists.
 */
export async function loadThread(
  threadId: string,
  actor: ThreadActor,
  executor: Executor = getDb(),
): Promise<ThreadDetail | null> {
  const [summary] = await executor
    .select({
      id: messageThreads.id,
      requestId: messageThreads.requestId,
      reference: requests.reference,
      scope: messageThreads.scope,
      subject: messageThreads.subject,
      providerCompanyId: messageThreads.providerCompanyId,
      providerName: providerCompanies.displayName,
      serviceName: serviceCategories.name,
      closedAt: messageThreads.closedAt,
    })
    .from(messageThreads)
    .innerJoin(requests, eq(requests.id, messageThreads.requestId))
    .leftJoin(providerCompanies, eq(providerCompanies.id, messageThreads.providerCompanyId))
    .leftJoin(
      requestServiceLines,
      eq(requestServiceLines.id, messageThreads.requestServiceLineId),
    )
    .leftJoin(serviceCategories, eq(serviceCategories.id, requestServiceLines.serviceCategoryId))
    .where(and(eq(messageThreads.id, threadId), visibleThreadFilter(actor)))
    .limit(1);

  if (summary === undefined) return null;

  const rows = await executor
    .select({
      id: messages.id,
      body: messages.body,
      isSystem: messages.isSystem,
      authorLabel: messages.authorLabel,
      authorName: users.fullName,
      authorRole: users.role,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  const last = rows[rows.length - 1];

  return {
    ...summary,
    messageCount: rows.length,
    lastMessageAt: last?.createdAt ?? null,
    lastMessagePreview: last?.body.slice(0, 160) ?? null,
    canPost: summary.closedAt === null && canPostTo(actor, summary),
    messages: rows,
  };
}

/**
 * Finds or creates the thread for a (request, scope, provider) triple.
 *
 * Provider threads are keyed on the service line as well, because a provider covering two
 * services on one request genuinely has two conversations. The unique index
 * `message_threads_provider_line_key` is what makes this safe under concurrency; the
 * `on conflict` clause defers to it rather than racing a select.
 */
export async function ensureThread(
  input: {
    readonly requestId: string;
    readonly scope: ThreadScope;
    readonly providerCompanyId?: string | null;
    readonly requestServiceLineId?: string | null;
    readonly subject?: string;
  },
  executor: Executor = getDb(),
): Promise<string> {
  const providerCompanyId = input.scope === 'provider' ? (input.providerCompanyId ?? null) : null;
  const lineId = input.requestServiceLineId ?? null;

  if (input.scope === 'provider' && providerCompanyId === null) {
    throw new ApronError('validation_failed', 'A provider thread must name its provider company');
  }

  const existing = await executor
    .select({ id: messageThreads.id })
    .from(messageThreads)
    .where(
      and(
        eq(messageThreads.requestId, input.requestId),
        eq(messageThreads.scope, input.scope),
        providerCompanyId === null
          ? isNull(messageThreads.providerCompanyId)
          : eq(messageThreads.providerCompanyId, providerCompanyId),
        lineId === null
          ? isNull(messageThreads.requestServiceLineId)
          : eq(messageThreads.requestServiceLineId, lineId),
      ),
    )
    .limit(1);

  const found = existing[0]?.id;
  if (found !== undefined) return found;

  const [created] = await executor
    .insert(messageThreads)
    .values({
      requestId: input.requestId,
      scope: input.scope,
      providerCompanyId,
      requestServiceLineId: lineId,
      subject: input.subject ?? '',
    })
    .returning({ id: messageThreads.id });

  if (created === undefined) throw new ApronError('internal', 'The thread could not be created');
  return created.id;
}

// ---------------------------------------------------------------------------
// posting
// ---------------------------------------------------------------------------

/**
 * Posts a message, re-checking visibility and posting rights inside the transaction.
 *
 * The check is not "did the UI show a box" — a provider posting into another company's
 * thread is refused here, server-side, and the attempt is logged (Journey G).
 */
export async function postMessage(
  input: { readonly threadId: string; readonly body: string },
  actor: ThreadActor,
): Promise<{ readonly messageId: string }> {
  const body = input.body.trim();
  if (body.length === 0) {
    throw new ApronError('validation_failed', 'Write something first');
  }
  if (body.length > 4000) {
    throw new ApronError('validation_failed', 'That message is too long — 4000 characters maximum');
  }

  return withTransaction(async (tx) => {
    const [thread] = await tx
      .select({
        id: messageThreads.id,
        requestId: messageThreads.requestId,
        scope: messageThreads.scope,
        providerCompanyId: messageThreads.providerCompanyId,
        closedAt: messageThreads.closedAt,
        clientOrganizationId: requests.clientOrganizationId,
      })
      .from(messageThreads)
      .innerJoin(requests, eq(requests.id, messageThreads.requestId))
      .where(and(eq(messageThreads.id, input.threadId), visibleThreadFilter(actor)))
      .limit(1);

    if (thread === undefined) {
      logger().warn(
        { threadId: input.threadId, actor: actor.label, role: actor.role },
        'message post refused — thread not visible to this actor',
      );
      throw new ApronError('not_found', 'That conversation does not exist');
    }

    if (thread.closedAt !== null) {
      throw new ApronError('precondition_failed', 'That conversation is closed');
    }

    if (!canPostTo(actor, thread)) {
      logger().warn(
        { threadId: input.threadId, actor: actor.label, role: actor.role },
        'message post refused — actor may read this thread but not post to it',
      );
      throw new ApronError('forbidden', 'You can read this conversation but not post to it');
    }

    const [created] = await tx
      .insert(messages)
      .values({
        threadId: input.threadId,
        authorUserId: actor.userId,
        authorLabel: actor.label,
        body,
        isSystem: false,
      })
      .returning({ id: messages.id });

    if (created === undefined) throw new ApronError('internal', 'The message could not be posted');

    // Touch the thread so the list orders by real activity.
    await tx
      .update(messageThreads)
      .set({ updatedAt: new Date() })
      .where(eq(messageThreads.id, input.threadId));

    await recordAuditEvent(
      {
        action: 'message.post',
        entityType: 'message_thread',
        entityId: input.threadId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        afterState: { scope: thread.scope, length: body.length },
      },
      tx,
    );

    return { messageId: created.id };
  });
}

/**
 * Appends a system entry — "offer expired, re-matching", "operations overrode the choice".
 *
 * Distinct from a posted message by `isSystem`, so the UI renders it as a lifecycle event
 * rather than as something a person said. Never fails the caller: a missing narration entry
 * is not a reason to roll back the operation it was narrating.
 */
export async function postSystemMessage(
  input: {
    readonly requestId: string;
    readonly scope: ThreadScope;
    readonly providerCompanyId?: string | null;
    readonly requestServiceLineId?: string | null;
    readonly body: string;
  },
  executor: Executor = getDb(),
): Promise<void> {
  try {
    const threadId = await ensureThread(
      {
        requestId: input.requestId,
        scope: input.scope,
        providerCompanyId: input.providerCompanyId ?? null,
        requestServiceLineId: input.requestServiceLineId ?? null,
      },
      executor,
    );

    await executor.insert(messages).values({
      threadId,
      authorUserId: null,
      authorLabel: 'Apron',
      body: input.body,
      isSystem: true,
    });

    await executor
      .update(messageThreads)
      .set({ updatedAt: new Date() })
      .where(eq(messageThreads.id, threadId));
  } catch (error) {
    logger().warn(
      { requestId: input.requestId, error: error instanceof Error ? error.message : 'unknown' },
      'could not record a system message',
    );
  }
}

/** Threads on one request that this actor may read — used by the request detail page. */
export async function loadThreadsForRequest(
  requestId: string,
  actor: ThreadActor,
  executor: Executor = getDb(),
): Promise<readonly ThreadSummary[]> {
  return loadThreads(actor, { requestId }, executor);
}

/** Provider companies holding work on a request, for opening a thread with one of them. */
export async function threadTargetsForRequest(
  requestId: string,
  executor: Executor = getDb(),
): Promise<readonly { readonly providerCompanyId: string; readonly displayName: string }[]> {
  const rows = await executor.execute<{ provider_company_id: string; display_name: string }>(sql`
    select distinct p.id as provider_company_id, p.display_name
    from provider_offers o
    join request_service_lines l on l.id = o.request_service_line_id
    join provider_companies p on p.id = o.provider_company_id
    where l.request_id = ${requestId}::uuid
      and o.status in ('sent', 'acknowledged')
    order by p.display_name
  `);

  return rows.rows.map((row) => ({
    providerCompanyId: row.provider_company_id,
    displayName: row.display_name,
  }));
}
