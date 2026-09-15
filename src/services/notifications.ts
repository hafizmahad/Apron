import '@/lib/server-guard';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, withTransaction, type Executor } from '@/db/client';
import {
  notificationDeliveries,
  notifications,
  providerOffers,
  requestServiceLines,
  requests,
  users,
} from '@/db/schema';
import type { NotificationSeverity } from '@/db/schema/enums';
import { getMailTransport } from '@/lib/mail';
import { getEnv } from '@/lib/config/env';
import { currentCorrelation, logError, logger } from '@/lib/logging';
import { formatOperational } from '@/lib/time';

/**
 * Notifications (CLAUDE.md §18).
 *
 * The rule that shapes everything here: **a retried job must not send a second email.**
 * Two mechanisms enforce it, and the second is the one that actually holds.
 *
 *  1. The queue deduplicates on the job id, which is the idempotency key.
 *  2. `notification_deliveries.idempotency_key` carries a UNIQUE index. Inserting the
 *     delivery row is therefore the claim on sending it: if the insert does nothing, this
 *     message has already been claimed and we return without contacting the transport.
 *
 * Only the second survives a Redis flush, a worker restart or a deploy mid-job, so the
 * code treats the insert — not the queue — as the authority.
 *
 * In-app notification rows are separate from delivery rows on purpose. A person should see
 * the notification in the product whether or not their email ever left the building.
 */

// ---------------------------------------------------------------------------
// the event catalogue
// ---------------------------------------------------------------------------

/**
 * Every notifiable event, exactly as CLAUDE.md §18 lists them.
 *
 * Each carries the ids it needs and nothing else; the text is built here, from the
 * database, at send time — so a notification can never contradict the record.
 */
export type NotificationEvent =
  | { readonly kind: 'offer.sent'; readonly offerId: string }
  | { readonly kind: 'offer.acknowledged'; readonly offerId: string }
  | { readonly kind: 'offer.declined'; readonly offerId: string; readonly reason: string }
  | { readonly kind: 'offer.expired'; readonly offerId: string }
  | { readonly kind: 'assignment.completed'; readonly requestServiceLineId: string }
  | {
      readonly kind: 'request.override';
      readonly requestServiceLineId: string;
      readonly reason: string;
    }
  | { readonly kind: 'request.confirmed'; readonly requestId: string }
  | {
      readonly kind: 'request.cancelled';
      readonly requestId: string;
      readonly reason: string;
      /**
       * Provider companies that were holding live work when the cancellation ran.
       *
       * Captured by the caller INSIDE its transaction, before the offers are withdrawn.
       * Reading it afterwards finds nothing — the withdrawal has already happened — which
       * is exactly how the providers silently stopped being told.
       */
      readonly notifyProviderCompanyIds: readonly string[];
    }
  | {
      readonly kind: 'line.failed';
      readonly requestServiceLineId: string;
      readonly reason: string;
    };

/** Who a notification is addressed to, and by which route. */
interface Recipient {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
}

interface Composed {
  readonly title: string;
  readonly body: string;
  readonly severity: NotificationSeverity;
  readonly entityType: string;
  readonly entityId: string;
  readonly recipients: readonly Recipient[];
  /** Distinguishes two notifications about the same entity, e.g. a re-offer. */
  readonly discriminator: string;
  /** Set when the event should also go out by email. */
  readonly email: { readonly subject: string; readonly text: string } | null;
}

/**
 * The stable idempotency key for one (event, recipient) pair.
 *
 * It must be derived only from facts that do not change between a job and its retry —
 * never from a timestamp or a random value, or the retry would look like a new message.
 */
export function deliveryKey(
  eventKind: string,
  discriminator: string,
  userId: string,
  channel: 'email' | 'sms' = 'email',
): string {
  return `${eventKind}-${discriminator}-${userId}-${channel}`;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/**
 * Records a notification and, where the event warrants it, queues an email.
 *
 * Safe to call twice with the same event: in-app rows are keyed by the same discriminator
 * and delivery rows by the unique idempotency key, so the second call is a no-op.
 */
export async function notify(event: NotificationEvent): Promise<{ readonly delivered: number }> {
  const composed = await compose(event);
  if (composed === null || composed.recipients.length === 0) {
    logger().debug({ kind: event.kind }, 'notification has no recipients');
    return { delivered: 0 };
  }

  let delivered = 0;

  for (const recipient of composed.recipients) {
    const key = deliveryKey(event.kind, composed.discriminator, recipient.userId);

    // One transaction per recipient: one person's bad address must not stop the rest.
    try {
      const claimed = await withTransaction(async (tx) => {
        // The in-app row. Deduplicated on the same key so a retry does not stack up
        // three identical entries in someone's notification centre.
        const existing = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, recipient.userId),
              eq(notifications.kind, event.kind),
              eq(notifications.entityId, composed.entityId),
              sql`${notifications.body} = ${composed.body}`,
            ),
          )
          .limit(1);

        let notificationId = existing[0]?.id ?? null;

        if (notificationId === null) {
          const [inserted] = await tx
            .insert(notifications)
            .values({
              userId: recipient.userId,
              kind: event.kind,
              title: composed.title,
              body: composed.body,
              severity: composed.severity,
              entityType: composed.entityType,
              entityId: composed.entityId,
            })
            .returning({ id: notifications.id });
          notificationId = inserted?.id ?? null;
        }

        if (composed.email === null) return null;

        // The claim. `on conflict do nothing` against the unique index means the second
        // caller inserts nothing and gets no row back — which is exactly the signal that
        // someone else already owns sending this message.
        const [claim] = await tx
          .insert(notificationDeliveries)
          .values({
            idempotencyKey: key,
            channel: 'email',
            recipient: recipient.email,
            subject: composed.email.subject,
            body: composed.email.text,
            status: 'pending',
            notificationId,
            correlationId: currentCorrelation()?.correlationId ?? null,
          })
          .onConflictDoNothing({ target: notificationDeliveries.idempotencyKey })
          .returning({ id: notificationDeliveries.id });

        return claim?.id ?? null;
      });

      if (claimed === null) continue;

      await sendClaimedDelivery(claimed, {
        to: recipient.email,
        subject: composed.email!.subject,
        text: composed.email!.text,
      });
      delivered += 1;
    } catch (error) {
      // One recipient failing is not a reason to abandon the others, and it is certainly
      // not a reason to fail the business operation that triggered this.
      logError('notification delivery failed', error, {
        kind: event.kind,
        userId: recipient.userId,
      });
    }
  }

  return { delivered };
}

/**
 * Sends a delivery that this process has already claimed, and records the outcome.
 *
 * A transport failure marks the row `failed` with the reason rather than throwing: the
 * business operation that caused the notification has already committed, and unwinding it
 * because a mail server was briefly unreachable would be far worse than a missing email.
 * The row is left for the Admin console to show and for a retry to pick up.
 */
async function sendClaimedDelivery(
  deliveryId: string,
  message: { readonly to: string; readonly subject: string; readonly text: string },
): Promise<void> {
  const db = getDb();

  try {
    await db
      .update(notificationDeliveries)
      .set({ attempts: sql`${notificationDeliveries.attempts} + 1` })
      .where(eq(notificationDeliveries.id, deliveryId));

    await getMailTransport().send(message);

    await db
      .update(notificationDeliveries)
      .set({ status: 'sent', sentAt: new Date(), lastError: null })
      .where(eq(notificationDeliveries.id, deliveryId));
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown transport error';
    await db
      .update(notificationDeliveries)
      .set({ status: 'failed', lastError: detail.slice(0, 500) })
      .where(eq(notificationDeliveries.id, deliveryId));

    logError('email transport rejected a message', error, { deliveryId });
  }
}

/**
 * Retries deliveries that failed, bounded by attempts.
 *
 * Called by the periodic sweep. It re-sends rather than re-composing, because the body was
 * stored when the event happened and that is the message the recipient should receive —
 * not a re-render of a world that has since moved on.
 */
export async function retryFailedDeliveries(
  options: { readonly maxAttempts?: number; readonly limit?: number } = {},
): Promise<{ readonly retried: number }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const limit = options.limit ?? 25;

  const rows = await getDb()
    .select({
      id: notificationDeliveries.id,
      recipient: notificationDeliveries.recipient,
      subject: notificationDeliveries.subject,
      body: notificationDeliveries.body,
    })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.status, 'failed'),
        sql`${notificationDeliveries.attempts} < ${maxAttempts}`,
      ),
    )
    .orderBy(notificationDeliveries.createdAt, notificationDeliveries.id)
    .limit(limit);

  for (const row of rows) {
    await sendClaimedDelivery(row.id, {
      to: row.recipient,
      subject: row.subject ?? 'Apron notification',
      text: row.body,
    });
  }

  return { retried: rows.length };
}

// ---------------------------------------------------------------------------
// composition — text is built from the database, never passed in
// ---------------------------------------------------------------------------

async function compose(event: NotificationEvent): Promise<Composed | null> {
  switch (event.kind) {
    case 'offer.sent':
    case 'offer.acknowledged':
    case 'offer.declined':
    case 'offer.expired':
      return composeOfferEvent(event);
    case 'assignment.completed':
    case 'request.override':
    case 'line.failed':
      return composeLineEvent(event);
    case 'request.confirmed':
    case 'request.cancelled':
      return composeRequestEvent(event);
  }
}

interface OfferContext {
  readonly offerId: string;
  readonly providerCompanyId: string;
  readonly providerName: string;
  readonly attemptNumber: number;
  readonly expiresAt: Date;
  readonly requestId: string;
  readonly reference: string;
  readonly serviceName: string;
  readonly quantity: number;
  readonly unitLabel: string;
  readonly airportLabel: string;
  readonly timezone: string;
  readonly serviceStartUtc: Date | null;
}

async function offerContext(offerId: string): Promise<OfferContext | null> {
  const result = await getDb().execute<{
    provider_company_id: string;
    provider_name: string;
    attempt_number: number;
    expires_at: Date;
    request_id: string;
    reference: string;
    service_name: string;
    quantity: number;
    unit_label: string;
    airport_label: string;
    timezone: string;
    service_start_utc: Date | null;
  }>(sql`
    select
      o.provider_company_id,
      p.display_name                              as provider_name,
      o.attempt_number,
      o.expires_at,
      r.id                                        as request_id,
      r.reference,
      s.name                                      as service_name,
      l.quantity,
      s.unit_label,
      coalesce(a.icao, a.iata, a.name)            as airport_label,
      a.timezone_iana                             as timezone,
      l.service_start_utc
    from provider_offers o
    join provider_companies p on p.id = o.provider_company_id
    join request_service_lines l on l.id = o.request_service_line_id
    join service_categories s on s.id = l.service_category_id
    join requests r on r.id = l.request_id
    join airports a on a.id = r.airport_id
    where o.id = ${offerId}::uuid
  `);

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    offerId,
    providerCompanyId: row.provider_company_id,
    providerName: row.provider_name,
    attemptNumber: row.attempt_number,
    expiresAt: row.expires_at,
    requestId: row.request_id,
    reference: row.reference,
    serviceName: row.service_name,
    quantity: row.quantity,
    unitLabel: row.unit_label,
    airportLabel: row.airport_label,
    timezone: row.timezone,
    serviceStartUtc: row.service_start_utc,
  };
}

function serviceLabel(context: {
  quantity: number;
  unitLabel: string;
  serviceName: string;
}): string {
  const plural = context.quantity === 1 ? '' : 's';
  return `${String(context.quantity)} ${context.unitLabel}${plural} · ${context.serviceName}`;
}

async function composeOfferEvent(
  event: Extract<NotificationEvent, { kind: `offer.${string}` }>,
): Promise<Composed | null> {
  const context = await offerContext(event.offerId);
  if (context === null) return null;

  const when =
    context.serviceStartUtc === null
      ? 'time to be confirmed'
      : `${formatOperational(context.serviceStartUtc, context.timezone)} local`;
  const what = serviceLabel(context);
  const link = `${getEnv().APP_URL}/ops/requests/${context.requestId}`;

  // An offer notification goes to the provider; everything after it goes to operations,
  // because that is who acts on the answer.
  if (event.kind === 'offer.sent') {
    const deadline = formatOperational(context.expiresAt, context.timezone);
    return {
      title: `New request — ${what}`,
      body: `${context.reference} at ${context.airportLabel}, ${when}. Acknowledge by ${deadline} local.`,
      severity: 'info',
      entityType: 'provider_offer',
      entityId: event.offerId,
      discriminator: `${event.offerId}-${String(context.attemptNumber)}`,
      recipients: await providerRecipients(context.providerCompanyId),
      email: {
        subject: `[Apron] ${context.reference} — ${what} at ${context.airportLabel}`,
        text: [
          `You have a new service request on Apron.`,
          ``,
          `Reference:   ${context.reference}`,
          `Service:     ${what}`,
          `Airport:     ${context.airportLabel}`,
          `Service at:  ${when}`,
          `Acknowledge by: ${deadline} local`,
          ``,
          `Open the request queue in the Apron provider portal to acknowledge or decline.`,
          `${getEnv().APP_URL}/provider/queue`,
          ``,
          `Passenger contact details become visible once you acknowledge.`,
        ].join('\n'),
      },
    };
  }

  const severity: NotificationSeverity =
    event.kind === 'offer.acknowledged' ? 'success' : event.kind === 'offer.expired' ? 'danger' : 'warning';

  const headline =
    event.kind === 'offer.acknowledged'
      ? `${context.providerName} accepted ${what}`
      : event.kind === 'offer.declined'
        ? `${context.providerName} declined ${what}`
        : `${context.providerName} did not respond in time — ${what}`;

  const detail =
    event.kind === 'offer.declined'
      ? `${context.reference} · reason: ${event.reason}. The service is being re-matched.`
      : event.kind === 'offer.expired'
        ? `${context.reference} · the acknowledgement deadline passed. The service is being re-matched.`
        : `${context.reference} at ${context.airportLabel}, ${when}. Awaiting resource assignment.`;

  return {
    title: headline,
    body: detail,
    severity,
    entityType: 'provider_offer',
    entityId: event.offerId,
    discriminator: `${event.offerId}-${String(context.attemptNumber)}`,
    recipients: await operationsRecipients(),
    email:
      // Only the exceptions are worth an email; an acknowledgement is visible in the
      // product and does not need to interrupt anyone's inbox.
      event.kind === 'offer.acknowledged'
        ? null
        : {
            subject: `[Apron] ${context.reference} — ${headline}`,
            text: [headline, '', detail, '', link].join('\n'),
          },
  };
}

interface LineContext {
  readonly requestId: string;
  readonly reference: string;
  readonly serviceName: string;
  readonly quantity: number;
  readonly unitLabel: string;
  readonly airportLabel: string;
  readonly providerName: string | null;
}

async function lineContext(requestServiceLineId: string): Promise<LineContext | null> {
  const result = await getDb().execute<{
    request_id: string;
    reference: string;
    service_name: string;
    quantity: number;
    unit_label: string;
    airport_label: string;
    provider_name: string | null;
  }>(sql`
    select
      r.id                             as request_id,
      r.reference,
      s.name                           as service_name,
      l.quantity,
      s.unit_label,
      coalesce(a.icao, a.iata, a.name) as airport_label,
      p.display_name                   as provider_name
    from request_service_lines l
    join service_categories s on s.id = l.service_category_id
    join requests r on r.id = l.request_id
    join airports a on a.id = r.airport_id
    left join provider_offers o on o.id = l.current_offer_id
    left join provider_companies p on p.id = o.provider_company_id
    where l.id = ${requestServiceLineId}::uuid
  `);

  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    requestId: row.request_id,
    reference: row.reference,
    serviceName: row.service_name,
    quantity: row.quantity,
    unitLabel: row.unit_label,
    airportLabel: row.airport_label,
    providerName: row.provider_name,
  };
}

async function composeLineEvent(
  event: Extract<
    NotificationEvent,
    { kind: 'assignment.completed' | 'request.override' | 'line.failed' }
  >,
): Promise<Composed | null> {
  const context = await lineContext(event.requestServiceLineId);
  if (context === null) return null;

  const what = serviceLabel(context);
  const link = `${getEnv().APP_URL}/ops/requests/${context.requestId}`;

  if (event.kind === 'assignment.completed') {
    return {
      title: `Resources committed — ${what}`,
      body: `${context.reference} · ${context.providerName ?? 'the provider'} has assigned the vehicles, drivers or officers for this service.`,
      severity: 'success',
      entityType: 'request_service_line',
      entityId: event.requestServiceLineId,
      discriminator: event.requestServiceLineId,
      recipients: await operationsRecipients(),
      email: null,
    };
  }

  if (event.kind === 'request.override') {
    return {
      title: `Operations overrode the provider — ${what}`,
      body: `${context.reference} · sent to ${context.providerName ?? 'a chosen provider'}. Reason: ${event.reason}`,
      severity: 'warning',
      entityType: 'request_service_line',
      entityId: event.requestServiceLineId,
      discriminator: `${event.requestServiceLineId}-override-${event.reason.slice(0, 40)}`,
      recipients: await operationsRecipients(),
      email: null,
    };
  }

  return {
    title: `Could not cover ${what}`,
    body: `${context.reference} at ${context.airportLabel} · ${event.reason}. This needs a person.`,
    severity: 'danger',
    entityType: 'request_service_line',
    entityId: event.requestServiceLineId,
    discriminator: event.requestServiceLineId,
    recipients: await operationsRecipients(),
    email: {
      subject: `[Apron] ${context.reference} — no provider could cover ${context.serviceName}`,
      text: [
        `Apron could not find a provider for this service.`,
        ``,
        `Reference: ${context.reference}`,
        `Service:   ${what}`,
        `Airport:   ${context.airportLabel}`,
        `Reason:    ${event.reason}`,
        ``,
        `Nothing further happens automatically. Open the request to intervene:`,
        link,
      ].join('\n'),
    },
  };
}

async function composeRequestEvent(
  event: Extract<NotificationEvent, { kind: 'request.confirmed' | 'request.cancelled' }>,
): Promise<Composed | null> {
  const [row] = await getDb()
    .select({
      reference: requests.reference,
      clientOrganizationId: requests.clientOrganizationId,
    })
    .from(requests)
    .where(eq(requests.id, event.requestId))
    .limit(1);

  if (row === undefined) return null;

  const link = `${getEnv().APP_URL}/ops/requests/${event.requestId}`;

  if (event.kind === 'request.confirmed') {
    return {
      title: `${row.reference} is fully covered`,
      body: 'Every service on this request has a provider and committed resources.',
      severity: 'success',
      entityType: 'request',
      entityId: event.requestId,
      discriminator: event.requestId,
      recipients: [
        ...(await operationsRecipients()),
        ...(await clientRecipients(row.clientOrganizationId)),
      ],
      email: null,
    };
  }

  return {
    title: `${row.reference} was cancelled`,
    body: `Reason: ${event.reason}. Live offers were withdrawn and committed resources released.`,
    severity: 'warning',
    entityType: 'request',
    entityId: event.requestId,
    discriminator: event.requestId,
    recipients: [
      ...(await operationsRecipients()),
      ...(await providerRecipientsFor(event.notifyProviderCompanyIds)),
    ],
    email: {
      subject: `[Apron] ${row.reference} cancelled`,
      text: [
        `${row.reference} has been cancelled.`,
        ``,
        `Reason: ${event.reason}`,
        ``,
        `Any service you were holding for this request is released. Nothing further is required.`,
        link,
      ].join('\n'),
    },
  };
}

// ---------------------------------------------------------------------------
// recipients
// ---------------------------------------------------------------------------

/** Only an active account is notified: a suspended one must not keep receiving work. */
const ACTIVE = eq(users.status, 'active');

/** Provider users who can act on an offer — dispatchers and admins, not staff. */
async function providerRecipients(providerCompanyId: string): Promise<Recipient[]> {
  return getDb()
    .select({ userId: users.id, email: users.email, fullName: users.fullName })
    .from(users)
    .where(
      and(
        eq(users.providerCompanyId, providerCompanyId),
        inArray(users.role, ['provider_admin', 'provider_dispatcher']),
        ACTIVE,
      ),
    )
    .orderBy(users.email);
}

/** Operations. Managers and agents both act on exceptions. */
async function operationsRecipients(): Promise<Recipient[]> {
  return getDb()
    .select({ userId: users.id, email: users.email, fullName: users.fullName })
    .from(users)
    .where(and(inArray(users.role, ['operations_manager', 'operations_agent']), ACTIVE))
    .orderBy(users.email);
}

async function clientRecipients(clientOrganizationId: string): Promise<Recipient[]> {
  return getDb()
    .select({ userId: users.id, email: users.email, fullName: users.fullName })
    .from(users)
    .where(
      and(
        eq(users.clientOrganizationId, clientOrganizationId),
        eq(users.role, 'client'),
        ACTIVE,
      ),
    )
    .orderBy(users.email);
}

/** Provider users at each of the named companies, de-duplicated. */
async function providerRecipientsFor(
  providerCompanyIds: readonly string[],
): Promise<Recipient[]> {
  if (providerCompanyIds.length === 0) return [];

  const lists = await Promise.all(providerCompanyIds.map(async (id) => providerRecipients(id)));
  const byUserId = new Map<string, Recipient>();
  for (const recipient of lists.flat()) byUserId.set(recipient.userId, recipient);
  return [...byUserId.values()];
}

/** Provider companies currently holding live work on a request. */
export async function providersHoldingWork(
  requestId: string,
  executor: Executor = getDb(),
): Promise<string[]> {
  const rows = await executor
    .selectDistinct({ id: providerOffers.providerCompanyId })
    .from(providerOffers)
    .innerJoin(
      requestServiceLines,
      eq(requestServiceLines.id, providerOffers.requestServiceLineId),
    )
    .where(
      and(
        eq(requestServiceLines.requestId, requestId),
        inArray(providerOffers.status, ['sent', 'acknowledged']),
      ),
    );

  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// reading the notification centre
// ---------------------------------------------------------------------------

export interface NotificationRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly severity: NotificationSeverity;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export async function loadNotifications(
  userId: string,
  options: { readonly limit?: number; readonly unreadOnly?: boolean } = {},
  executor: Executor = getDb(),
): Promise<readonly NotificationRow[]> {
  const where = options.unreadOnly === true
    ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
    : eq(notifications.userId, userId);

  return executor
    .select({
      id: notifications.id,
      kind: notifications.kind,
      title: notifications.title,
      body: notifications.body,
      severity: notifications.severity,
      entityType: notifications.entityType,
      entityId: notifications.entityId,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(where)
    .orderBy(sql`${notifications.createdAt} desc`, sql`${notifications.id} desc`)
    .limit(options.limit ?? 50);
}

export async function countUnread(userId: string, executor: Executor = getDb()): Promise<number> {
  const result = await executor.execute<{ n: number }>(
    sql`select count(*)::int as n from notifications where user_id = ${userId}::uuid and read_at is null`,
  );
  return result.rows[0]?.n ?? 0;
}

/** Marks one notification read. Scoped to the owner — another user's id changes nothing. */
export async function markNotificationRead(
  notificationId: string,
  userId: string,
): Promise<boolean> {
  const updated = await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });

  return updated.length > 0;
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const updated = await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });

  return updated.length;
}

// ---------------------------------------------------------------------------
// emission
// ---------------------------------------------------------------------------

/**
 * The call sites use this, not {@link notify}.
 *
 * With the queue running, the event is handed to the worker so a slow mail server cannot
 * delay a provider's acknowledgement. With the queue off — a test, a bare dev checkout —
 * it is delivered inline, so the product behaves the same way rather than silently
 * dropping every notification.
 *
 * Either path is safe to reach twice: the unique idempotency key is what prevents a
 * duplicate, not the choice of path.
 *
 * This never throws. A notification is a consequence of a business operation that has
 * already committed; failing the caller now would roll back something that genuinely
 * happened in exchange for an email that did not.
 */
export async function emitNotification(event: NotificationEvent): Promise<void> {
  try {
    if (!getEnv().QUEUE_ENABLED) {
      await notify(event);
      return;
    }

    const { enqueueNotification } = await import('@/jobs/queues/definitions');
    await enqueueNotification({
      idempotencyKey: `${event.kind}-${eventSubject(event)}`,
      kind: event.kind,
      correlationId: currentCorrelation()?.correlationId ?? 'none',
      payload: { ...event },
    });
  } catch (error) {
    logError('could not emit notification', error, { kind: event.kind });
  }
}

/** The entity id an event is about — used only to build the queue job id. */
function eventSubject(event: NotificationEvent): string {
  if ('offerId' in event) return event.offerId;
  if ('requestServiceLineId' in event) return event.requestServiceLineId;
  return event.requestId;
}

/**
 * Rebuilds an event from a queued job payload.
 *
 * Returns null rather than throwing for an unrecognised kind: a job left in Redis by a
 * previous version of the code should be dropped with a log line, not crash the worker.
 */
export function parseNotificationJob(payload: Record<string, unknown>): NotificationEvent | null {
  const kind = payload['kind'];
  if (typeof kind !== 'string') return null;

  const offerId = typeof payload['offerId'] === 'string' ? payload['offerId'] : null;
  const lineId =
    typeof payload['requestServiceLineId'] === 'string' ? payload['requestServiceLineId'] : null;
  const requestId = typeof payload['requestId'] === 'string' ? payload['requestId'] : null;
  const reason = typeof payload['reason'] === 'string' ? payload['reason'] : '';

  switch (kind) {
    case 'offer.sent':
    case 'offer.acknowledged':
    case 'offer.expired':
      return offerId === null ? null : { kind, offerId };
    case 'offer.declined':
      return offerId === null ? null : { kind, offerId, reason };
    case 'assignment.completed':
      return lineId === null ? null : { kind, requestServiceLineId: lineId };
    case 'request.override':
    case 'line.failed':
      return lineId === null ? null : { kind, requestServiceLineId: lineId, reason };
    case 'request.confirmed':
      return requestId === null ? null : { kind, requestId };
    case 'request.cancelled': {
      const ids = payload['notifyProviderCompanyIds'];
      return requestId === null
        ? null
        : {
            kind,
            requestId,
            reason,
            notifyProviderCompanyIds: Array.isArray(ids)
              ? ids.filter((id): id is string => typeof id === 'string')
              : [],
          };
    }
    default:
      return null;
  }
}
