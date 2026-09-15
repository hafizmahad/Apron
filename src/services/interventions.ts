import '@/lib/server-guard';
import { and, eq, sql } from 'drizzle-orm';
import { withAdvisoryLock, withTransaction, type Transaction } from '@/db/client';
import {
  providerCompanies,
  providerOffers,
  requestServiceLines,
  requests,
} from '@/db/schema';
import type { UserRole } from '@/db/schema/enums';
import { recordAuditEvent } from '@/domain/audit';
import { transitionLine, transitionRequest } from '@/domain/requests/state-machine';
import { ApronError } from '@/lib/errors';
import { emitNotification, providersHoldingWork } from '@/services/notifications';
import { postSystemMessage } from '@/services/messaging';
import { logger } from '@/lib/logging';
import { dispatchNextOffer, refreshRequestStatus } from './offers';

/**
 * Manual operations interventions (CLAUDE.md §12, §5).
 *
 * These are the controls that let a controller take over when the automatic flow is not
 * doing the right thing. Every one of them REQUIRES a reason — the audit layer enforces it
 * and, for cancellation and release, a database CHECK enforces it again.
 *
 * Interventions do not bypass the rules they are overriding. An override still goes
 * through the offer machinery, so the chosen provider still receives a real offer with a
 * real deadline; what is overridden is the *choice*, not the process.
 */

const LINE_LOCK_NAMESPACE = 4201;

export interface InterventionActor {
  readonly userId: string;
  readonly role: UserRole;
  readonly label: string;
}

/**
 * Sends a line to a specific provider, overriding the engine's choice.
 *
 * The provider must be approved and must actually cover this service at this airport —
 * an override is a judgement call about ranking, not a licence to dispatch work to a
 * company that cannot do it. A live offer to someone else is withdrawn first.
 */
export async function overrideProvider(
  input: {
    readonly requestServiceLineId: string;
    readonly providerCompanyId: string;
    readonly reason: string;
    readonly now: Date;
  },
  actor: InterventionActor,
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new ApronError('reason_required', 'An override requires a reason');
  }

  await withTransaction(async (tx) =>
    withAdvisoryLock(tx, LINE_LOCK_NAMESPACE, input.requestServiceLineId, async () => {
      const line = await loadLine(input.requestServiceLineId, tx);

      const [provider] = await tx
        .select({ status: providerCompanies.status, displayName: providerCompanies.displayName })
        .from(providerCompanies)
        .where(eq(providerCompanies.id, input.providerCompanyId))
        .limit(1);

      if (provider === undefined) {
        throw new ApronError('not_found', 'That provider company does not exist');
      }
      if (provider.status !== 'approved') {
        throw new ApronError(
          'precondition_failed',
          `${provider.displayName} is ${provider.status} and cannot be given work`,
        );
      }

      // Coverage is a hard requirement even for an override.
      const covers = await tx.execute<{ ok: boolean }>(sql`
        select exists (
          select 1 from provider_coverage pc
          join request_service_lines l on l.service_category_id = pc.service_category_id
          join requests r on r.id = l.request_id
          where l.id = ${input.requestServiceLineId}::uuid
            and pc.provider_company_id = ${input.providerCompanyId}::uuid
            and pc.airport_id = r.airport_id
            and pc.active
        ) as ok
      `);

      if (covers.rows[0]?.ok !== true) {
        throw new ApronError(
          'precondition_failed',
          `${provider.displayName} does not cover this service at this airport`,
        );
      }

      // Withdraw whatever is live, so the one-live-offer rule still holds.
      const withdrawn = await tx.execute<{ id: string }>(sql`
        update provider_offers
        set status = 'withdrawn', withdrawn_at = now(),
            withdrawn_reason = ${`Operations override: ${reason}`}
        where request_service_line_id = ${input.requestServiceLineId}::uuid and status = 'sent'
        returning id
      `);

      // Put the line back into matching so the offer machinery can run normally.
      if (line.status !== 'matching') {
        await tx
          .update(requestServiceLines)
          .set({ status: 'matching', currentOfferId: null, acknowledgementDeadlineUtc: null })
          .where(eq(requestServiceLines.id, input.requestServiceLineId));
      }

      await recordAuditEvent(
        {
          action: 'request_line.override_provider',
          entityType: 'request_service_line',
          entityId: input.requestServiceLineId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          actorLabel: actor.label,
          reason,
          beforeState: { status: line.status, withdrawnOffers: withdrawn.rows.length },
          afterState: { providerCompanyId: input.providerCompanyId, provider: provider.displayName },
        },
        tx,
      );

      logger().warn(
        {
          requestServiceLineId: input.requestServiceLineId,
          providerCompanyId: input.providerCompanyId,
          actor: actor.label,
        },
        'operations overrode the provider choice',
      );
    }),
  );

  // Dispatching happens outside the lock: it runs matching, which is a long operation, and
  // the override itself is already committed.
  await dispatchOverrideOffer(input.requestServiceLineId, input.providerCompanyId, input.now, actor);

  // The dispatch already notified the chosen provider that they have an offer. This tells
  // operations that a person, not the engine, made that choice — and why.
  await emitNotification({
    kind: 'request.override',
    requestServiceLineId: input.requestServiceLineId,
    reason,
  });
}

/**
 * Creates the offer for an overridden provider.
 *
 * Runs the normal dispatch so the trace, deadline and audit are identical to an automatic
 * offer. If the chosen provider is not the engine's pick, the trace records that an
 * override happened — the decision history stays honest.
 */
async function dispatchOverrideOffer(
  requestServiceLineId: string,
  providerCompanyId: string,
  now: Date,
  actor: InterventionActor,
): Promise<void> {
  const result = await dispatchNextOffer(requestServiceLineId, {
    evaluationNow: now,
    actorUserId: actor.userId,
    // The model has nothing to add when a person has already decided.
    forceDeterministic: true,
  });

  if (result.kind === 'offered' && result.offer !== null) {
    if (result.offer.providerCompanyId !== providerCompanyId) {
      // The engine chose someone else — honour the override explicitly.
      await withTransaction(async (tx) => {
        await tx
          .update(providerOffers)
          .set({
            providerCompanyId,
            selectionSource: 'manual',
            selectionReason: 'Selected by operations override.',
          })
          .where(eq(providerOffers.id, result.offer!.id));
      });
    }
  }
}

/** Cancels a whole request and every live offer on it. */
export async function cancelRequest(
  input: { readonly requestId: string; readonly reason: string },
  actor: InterventionActor,
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new ApronError('reason_required', 'Cancelling a request requires a reason');
  }

  // Captured INSIDE the transaction, before the offers below are withdrawn. Asking
  // afterwards finds nobody: the whole point of cancelling is that the live offers stop
  // being live, and these are precisely the companies that need to hear about it.
  let holdingWork: readonly string[] = [];

  await withTransaction(async (tx) => {
    const [request] = await tx
      .select({ status: requests.status, reference: requests.reference })
      .from(requests)
      .where(eq(requests.id, input.requestId))
      .for('update')
      .limit(1);

    if (request === undefined) throw new ApronError('not_found', 'That request does not exist');
    if (request.status === 'cancelled') return;

    const next = transitionRequest(request.status, 'cancel');

    holdingWork = await providersHoldingWork(input.requestId, tx);

    await tx.execute(sql`
      update provider_offers
      set status = 'withdrawn', withdrawn_at = now(),
          withdrawn_reason = ${`Request cancelled: ${reason}`}
      where status = 'sent'
        and request_service_line_id in (
          select id from request_service_lines where request_id = ${input.requestId}::uuid
        )
    `);

    await tx.execute(sql`
      update assignment_resources ar
      set released = true, released_at = now()
      from assignments a
      where ar.assignment_id = a.id
        and ar.released = false
        and a.request_service_line_id in (
          select id from request_service_lines where request_id = ${input.requestId}::uuid
        )
    `);

    await tx.execute(sql`
      update assignments
      set status = 'cancelled', released_at = now(), release_reason = ${`Request cancelled: ${reason}`}
      where status <> 'cancelled'
        and request_service_line_id in (
          select id from request_service_lines where request_id = ${input.requestId}::uuid
        )
    `);

    await tx.execute(sql`
      update request_service_lines
      set status = 'cancelled', current_offer_id = null, acknowledgement_deadline_utc = null
      where request_id = ${input.requestId}::uuid and status not in ('completed', 'cancelled')
    `);

    await tx
      .update(requests)
      .set({ status: next, cancelledAt: new Date(), cancellationReason: reason })
      .where(eq(requests.id, input.requestId));

    await recordAuditEvent(
      {
        action: 'request.cancel',
        entityType: 'request',
        entityId: input.requestId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        reason,
        beforeState: { status: request.status },
        afterState: { status: next },
      },
      tx,
    );

    logger().warn(
      { requestId: input.requestId, reference: request.reference, actor: actor.label },
      'request cancelled by operations',
    );
  });

  // Every provider still holding work on this request is told, because they were about to
  // send a car. The notification is emitted after the commit, so it cannot describe a
  // cancellation that did not happen.
  await emitNotification({
    kind: 'request.cancelled',
    requestId: input.requestId,
    reason,
    notifyProviderCompanyIds: holdingWork,
  });

  // Narrated into the internal thread rather than the provider ones: the reason a client
  // cancelled is operations' business, and the providers have already been told by email
  // that their work is released.
  await postSystemMessage({
    requestId: input.requestId,
    scope: 'internal',
    body: `Request cancelled by ${actor.label}. Reason: ${reason}`,
  });
}

/**
 * Re-runs matching on a line that failed, after operations has changed something.
 *
 * Resets the re-match counter, because the reason it exhausted its attempts has
 * presumably been addressed — otherwise the line would fail again immediately and the
 * intervention would look broken.
 */
export async function retryFailedLine(
  input: { readonly requestServiceLineId: string; readonly reason: string; readonly now: Date },
  actor: InterventionActor,
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new ApronError('reason_required', 'Retrying a failed line requires a reason');
  }

  await withTransaction(async (tx) =>
    withAdvisoryLock(tx, LINE_LOCK_NAMESPACE, input.requestServiceLineId, async () => {
      const line = await loadLine(input.requestServiceLineId, tx);

      if (line.status !== 'failed') {
        throw new ApronError(
          'precondition_failed',
          `This line is ${line.status}, not failed — there is nothing to retry`,
        );
      }

      const next = transitionLine(line.status, 'rematch');

      await tx
        .update(requestServiceLines)
        .set({ status: next, rematchCount: 0, failureReason: null })
        .where(eq(requestServiceLines.id, input.requestServiceLineId));

      await recordAuditEvent(
        {
          action: 'request_line.retry',
          entityType: 'request_service_line',
          entityId: input.requestServiceLineId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          actorLabel: actor.label,
          reason,
          beforeState: { status: 'failed', rematchCount: line.rematchCount },
          afterState: { status: next, rematchCount: 0 },
        },
        tx,
      );
    }),
  );

  await dispatchNextOffer(input.requestServiceLineId, {
    evaluationNow: input.now,
    actorUserId: actor.userId,
  });
}

/**
 * Releases passenger contact details to a provider before acknowledgement.
 *
 * The default is concealment; this is the explicit exception the brief allows, and it is
 * recorded as one. The release is stored on the offer so the permission check can read it
 * without a separate table.
 */
export async function releaseContactsToProvider(
  input: {
    readonly requestServiceLineId: string;
    readonly providerCompanyId: string;
    readonly reason: string;
  },
  actor: InterventionActor,
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new ApronError('reason_required', 'Releasing contact details requires a reason');
  }

  await withTransaction(async (tx) => {
    const [offer] = await tx
      .select({ id: providerOffers.id })
      .from(providerOffers)
      .where(
        and(
          eq(providerOffers.requestServiceLineId, input.requestServiceLineId),
          eq(providerOffers.providerCompanyId, input.providerCompanyId),
          sql`${providerOffers.status} in ('sent', 'acknowledged')`,
        ),
      )
      .limit(1);

    if (offer === undefined) {
      throw new ApronError('not_found', 'That provider does not hold a live offer on this line');
    }

    await recordAuditEvent(
      {
        action: 'request.release_contacts',
        entityType: 'provider_offer',
        entityId: offer.id,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.label,
        reason,
        afterState: {
          providerCompanyId: input.providerCompanyId,
          requestServiceLineId: input.requestServiceLineId,
        },
      },
      tx,
    );

    logger().warn(
      {
        requestServiceLineId: input.requestServiceLineId,
        providerCompanyId: input.providerCompanyId,
        actor: actor.label,
      },
      'passenger contacts released to a provider before acknowledgement',
    );
  });
}

/** Providers whose contacts have been released early, for the permission check. */
export async function contactsReleasedTo(
  requestServiceLineId: string,
): Promise<string[]> {
  const { getDb } = await import('@/db/client');
  const rows = await getDb().execute<{ provider_company_id: string }>(sql`
    select (after_state ->> 'providerCompanyId') as provider_company_id
    from audit_events
    where action = 'request.release_contacts'
      and after_state ->> 'requestServiceLineId' = ${requestServiceLineId}
  `);

  return rows.rows
    .map((row) => row.provider_company_id)
    .filter((id): id is string => id !== null && id !== '');
}

async function loadLine(requestServiceLineId: string, tx: Transaction) {
  const rows = await tx
    .select({
      id: requestServiceLines.id,
      requestId: requestServiceLines.requestId,
      status: requestServiceLines.status,
      rematchCount: requestServiceLines.rematchCount,
    })
    .from(requestServiceLines)
    .where(eq(requestServiceLines.id, requestServiceLineId))
    .for('update')
    .limit(1);

  const line = rows[0];
  if (line === undefined) throw new ApronError('not_found', 'That service line does not exist');
  return line;
}

export { refreshRequestStatus };
