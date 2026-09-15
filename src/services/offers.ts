import '@/lib/server-guard';
import { and, eq, sql } from 'drizzle-orm';
import { withAdvisoryLock, withTransaction, type Transaction } from '@/db/client';
import {
  platformSettings,
  providerOffers,
  requestServiceLines,
  requests,
  type ProviderOffer,
} from '@/db/schema';
import { recordAuditEvent } from '@/domain/audit';
import { deriveRequestStatus, transitionLine } from '@/domain/requests/state-machine';
import type { UserRole } from '@/db/schema/enums';
import { ApronError } from '@/lib/errors';
import { emitNotification } from '@/services/notifications';
import { postSystemMessage } from '@/services/messaging';
import { logger } from '@/lib/logging';
import { runMatching, type MatchDecision } from './matching';

/**
 * The offer lifecycle (CLAUDE.md §11, Phase 6).
 *
 * Every mutation here runs in a transaction guarded by a Postgres advisory lock keyed on
 * the service line. That lock is what makes the waterfall safe: the SLA worker expiring an
 * offer and a dispatcher acknowledging it can arrive in the same millisecond, and exactly
 * one of them wins. Without it both could proceed and the line would end up with two live
 * offers — which the partial unique index would then reject with an error neither user
 * caused (CLAUDE.md §30).
 */

/** Advisory-lock namespace, so these locks cannot collide with another subsystem's. */
const LINE_LOCK_NAMESPACE = 4201;

export interface DispatchResult {
  readonly kind: 'offered' | 'failed';
  readonly offer: ProviderOffer | null;
  readonly decision: MatchDecision;
  readonly attemptNumber: number;
  /** The request the line belongs to — read inside the transaction, not looked up again. */
  readonly requestId: string;
}

export interface DispatchOptions {
  readonly evaluationNow: Date;
  readonly actorUserId?: string | null;
  readonly forceDeterministic?: boolean;
}

/**
 * Matches a line and sends the offer to the chosen provider.
 *
 * Providers that already declined this line are excluded automatically — the exclusion is
 * read from the offer history rather than passed in, so a re-match can never accidentally
 * re-offer to someone who has already said no.
 */
export async function dispatchNextOffer(
  requestServiceLineId: string,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const excluded = await readDeclinedProviderIds(requestServiceLineId);

  const decision = await runMatching(requestServiceLineId, {
    evaluationNow: options.evaluationNow,
    excludedProviderIds: excluded,
    ...(options.actorUserId === undefined ? {} : { actorUserId: options.actorUserId }),
    ...(options.forceDeterministic === undefined
      ? {}
      : { forceDeterministic: options.forceDeterministic }),
  });

  const result = await withTransaction(async (tx) =>
    withAdvisoryLock(tx, LINE_LOCK_NAMESPACE, requestServiceLineId, async () => {
      const line = await loadLineForUpdate(requestServiceLineId, tx);

      if (decision.chosen === null) {
        const next = transitionLine(line.status, 'fail');
        await tx
          .update(requestServiceLines)
          .set({
            status: next,
            failureReason: describeNoProvider(decision),
            currentOfferId: null,
          })
          .where(eq(requestServiceLines.id, requestServiceLineId));

        await recordAuditEvent(
          {
            action: 'request_line.match_failed',
            entityType: 'request_service_line',
            entityId: requestServiceLineId,
            actorLabel: 'matching',
            afterState: {
              attemptNumber: decision.attemptNumber,
              rejected: decision.outcome.rejected.length,
            },
          },
          tx,
        );

        await refreshRequestStatus(line.requestId, tx);

        logger().warn(
          { requestServiceLineId, attempt: decision.attemptNumber },
          'no eligible provider — line failed',
        );

        return {
          kind: 'failed' as const,
          offer: null,
          decision,
          attemptNumber: decision.attemptNumber,
          requestId: line.requestId,
        };
      }

      const slaMinutes = await readAcknowledgementSla(line.priority, tx);
      const sentAt = options.evaluationNow;
      const expiresAt = new Date(sentAt.getTime() + slaMinutes * 60_000);

      const [offer] = await tx
        .insert(providerOffers)
        .values({
          requestServiceLineId,
          providerCompanyId: decision.chosen.providerCompanyId,
          attemptNumber: decision.attemptNumber,
          rankAtSelection: decision.chosen.rank,
          eligibilitySnapshot: {
            engineVersion: decision.outcome.engineVersion,
            candidates: [
              ...decision.outcome.eligible.map(snapshotOf),
              ...decision.outcome.rejected.map(snapshotOf),
            ],
          },
          selectionReason: decision.reason,
          selectionSource: decision.selectionSource,
          status: 'sent',
          sentAt,
          expiresAt,
        })
        .returning();

      if (offer === undefined) {
        throw new ApronError('internal', 'The offer could not be created');
      }

      const next = transitionLine(line.status, 'offer_sent');
      await tx
        .update(requestServiceLines)
        .set({
          status: next,
          currentOfferId: offer.id,
          acknowledgementDeadlineUtc: expiresAt,
          failureReason: null,
        })
        .where(eq(requestServiceLines.id, requestServiceLineId));

      await recordAuditEvent(
        {
          action: 'offer.sent',
          entityType: 'provider_offer',
          entityId: offer.id,
          actorLabel: 'matching',
          afterState: {
            providerCompanyId: offer.providerCompanyId,
            attemptNumber: offer.attemptNumber,
            expiresAt: offer.expiresAt,
            selectionSource: offer.selectionSource,
          },
        },
        tx,
      );

      await refreshRequestStatus(line.requestId, tx);

      logger().info(
        {
          requestServiceLineId,
          offerId: offer.id,
          providerCompanyId: offer.providerCompanyId,
          expiresAt: offer.expiresAt,
        },
        'offer sent',
      );

      return {
        kind: 'offered' as const,
        offer,
        decision,
        attemptNumber: decision.attemptNumber,
        requestId: line.requestId,
      };
    }),
  );

  // Notifications are emitted only once the transaction has COMMITTED. Emitting inside it
  // would tell a provider about an offer that a later constraint violation then rolled
  // back — and no retraction email exists.
  if (result.kind === 'offered' && result.offer !== null) {
    await emitNotification({ kind: 'offer.sent', offerId: result.offer.id });

    // Opening the thread here means the provider has somewhere to ask a question the
    // moment they see the offer, rather than after somebody remembers to start one.
    await postSystemMessage({
      requestId: result.requestId,
      scope: 'provider',
      providerCompanyId: result.offer.providerCompanyId,
      requestServiceLineId: requestServiceLineId,
      body: `Offer sent. Acknowledge by ${result.offer.expiresAt.toISOString()}.`,
    });
  } else if (result.kind === 'failed') {
    await emitNotification({
      kind: 'line.failed',
      requestServiceLineId,
      reason: describeMatchFailure(result.decision),
    });
  }

  return result;
}

/** Why nobody could cover it, in words operations can act on. */
function describeMatchFailure(decision: { outcome: { rejected: readonly unknown[] } }): string {
  const count = decision.outcome.rejected.length;
  return count === 0
    ? 'No provider covers this service at this airport.'
    : `All ${String(count)} candidate${count === 1 ? '' : 's'} were rejected — see the decision trace.`;
}

export interface AcknowledgeInput {
  readonly offerId: string;
  readonly actorUserId: string;
  readonly actorRole: UserRole;
  readonly actorLabel: string;
  /** The provider company the actor belongs to. Checked against the offer. */
  readonly providerCompanyId: string;
  readonly now: Date;
}

/**
 * A provider accepts the offer.
 *
 * Refuses — with distinct, honest errors — when the offer has already expired, has been
 * withdrawn, belongs to another company, or has already been answered. "Expired" in
 * particular must not read as a generic failure: the provider did nothing wrong and needs
 * to know the work has moved on.
 */
export async function acknowledgeOffer(input: AcknowledgeInput): Promise<ProviderOffer> {
  const acknowledged = await withTransaction(async (tx) => {
    const offer = await loadOfferForUpdate(input.offerId, tx);

    if (offer.providerCompanyId !== input.providerCompanyId) {
      // Belongs to another company. The permission layer should already have refused this.
      logger().warn(
        {
          offerId: offer.id,
          actorProviderCompanyId: input.providerCompanyId,
          offerProviderCompanyId: offer.providerCompanyId,
        },
        'tenant isolation violated: acknowledge',
      );
      throw new ApronError('tenant_mismatch', 'That offer belongs to another company');
    }

    return withAdvisoryLock(tx, LINE_LOCK_NAMESPACE, offer.requestServiceLineId, async () => {
      // Re-read under the lock: the SLA worker may have expired it since we loaded it.
      const current = await loadOfferForUpdate(input.offerId, tx);

      if (current.status === 'acknowledged') return current;

      if (current.status !== 'sent') {
        throw new ApronError(
          'offer_expired',
          current.status === 'expired'
            ? 'This offer expired and the request has moved to another provider.'
            : `This offer can no longer be accepted (${current.status}).`,
          { details: { offerId: current.id, status: current.status } },
        );
      }

      if (current.expiresAt.getTime() <= input.now.getTime()) {
        throw new ApronError(
          'offer_expired',
          'This offer expired and the request has moved to another provider.',
          { details: { offerId: current.id, expiresAt: current.expiresAt } },
        );
      }

      const line = await loadLineForUpdate(current.requestServiceLineId, tx);
      const next = transitionLine(line.status, 'acknowledge');

      const [updated] = await tx
        .update(providerOffers)
        .set({
          status: 'acknowledged',
          acknowledgedAt: input.now,
          acknowledgedByUserId: input.actorUserId,
        })
        .where(eq(providerOffers.id, current.id))
        .returning();

      if (updated === undefined) throw new ApronError('internal', 'The offer could not be updated');

      await tx
        .update(requestServiceLines)
        .set({ status: next, acknowledgementDeadlineUtc: null })
        .where(eq(requestServiceLines.id, current.requestServiceLineId));

      await recordAuditEvent(
        {
          action: 'offer.acknowledge',
          entityType: 'provider_offer',
          entityId: current.id,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          actorLabel: input.actorLabel,
          beforeState: { status: current.status },
          afterState: { status: 'acknowledged', lineStatus: next },
        },
        tx,
      );

      await refreshRequestStatus(line.requestId, tx);

      logger().info(
        { offerId: current.id, providerCompanyId: current.providerCompanyId },
        'offer acknowledged',
      );

      return updated;
    });
  });

  await emitNotification({ kind: 'offer.acknowledged', offerId: input.offerId });
  return acknowledged;
}

export interface DeclineInput extends AcknowledgeInput {
  readonly reason: string;
}

/**
 * A provider declines.
 *
 * The reason is mandatory — the database enforces it too — because it is what operations
 * reads when deciding whether to re-match or to intervene. The line moves to `declined`
 * and the re-match is enqueued separately, so a slow re-match cannot hold up the
 * provider's response.
 */
export async function declineOffer(input: DeclineInput): Promise<ProviderOffer> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new ApronError('reason_required', 'Tell us briefly why you cannot cover this');
  }

  const declined = await withTransaction(async (tx) => {
    const offer = await loadOfferForUpdate(input.offerId, tx);

    if (offer.providerCompanyId !== input.providerCompanyId) {
      throw new ApronError('tenant_mismatch', 'That offer belongs to another company');
    }

    return withAdvisoryLock(tx, LINE_LOCK_NAMESPACE, offer.requestServiceLineId, async () => {
      const current = await loadOfferForUpdate(input.offerId, tx);

      if (current.status === 'declined') return current;
      if (current.status !== 'sent') {
        throw new ApronError(
          'offer_expired',
          `This offer can no longer be declined (${current.status}).`,
        );
      }

      const line = await loadLineForUpdate(current.requestServiceLineId, tx);
      const next = transitionLine(line.status, 'decline');

      const [updated] = await tx
        .update(providerOffers)
        .set({
          status: 'declined',
          declinedAt: input.now,
          declinedByUserId: input.actorUserId,
          declineReason: reason,
        })
        .where(eq(providerOffers.id, current.id))
        .returning();

      if (updated === undefined) throw new ApronError('internal', 'The offer could not be updated');

      await tx
        .update(requestServiceLines)
        .set({ status: next, currentOfferId: null, acknowledgementDeadlineUtc: null })
        .where(eq(requestServiceLines.id, current.requestServiceLineId));

      await recordAuditEvent(
        {
          action: 'offer.decline',
          entityType: 'provider_offer',
          entityId: current.id,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          actorLabel: input.actorLabel,
          reason,
          beforeState: { status: current.status },
          afterState: { status: 'declined', lineStatus: next },
        },
        tx,
      );

      await refreshRequestStatus(line.requestId, tx);

      logger().info(
        { offerId: current.id, providerCompanyId: current.providerCompanyId },
        'offer declined',
      );

      return updated;
    });
  });

  await emitNotification({ kind: 'offer.declined', offerId: input.offerId, reason });
  return declined;
}

/**
 * Expires one offer whose deadline has passed.
 *
 * **Idempotent** (CLAUDE.md §3): re-running it on an offer that was already expired, or
 * that a provider acknowledged in the meantime, changes nothing and reports that. The
 * worker relies on this, because a job may be delivered more than once.
 */
export async function expireOffer(
  offerId: string,
  now: Date,
): Promise<{ readonly expired: boolean; readonly reason: string }> {
  const result = await withTransaction(async (tx) => {
    const offer = await loadOfferForUpdate(offerId, tx);

    return withAdvisoryLock(tx, LINE_LOCK_NAMESPACE, offer.requestServiceLineId, async () => {
      const current = await loadOfferForUpdate(offerId, tx);

      if (current.status === 'expired') {
        return { expired: false, reason: 'already expired' };
      }
      if (current.status !== 'sent') {
        // The provider answered first. That is the correct outcome, not a race we lost.
        return { expired: false, reason: `already ${current.status}` };
      }
      if (current.expiresAt.getTime() > now.getTime()) {
        return { expired: false, reason: 'not yet due' };
      }

      const line = await loadLineForUpdate(current.requestServiceLineId, tx);
      const next = transitionLine(line.status, 'expire');

      await tx
        .update(providerOffers)
        .set({ status: 'expired', expiredAt: now })
        .where(eq(providerOffers.id, current.id));

      await tx
        .update(requestServiceLines)
        .set({
          status: next,
          currentOfferId: null,
          acknowledgementDeadlineUtc: null,
          rematchCount: sql`${requestServiceLines.rematchCount} + 1`,
        })
        .where(eq(requestServiceLines.id, current.requestServiceLineId));

      await recordAuditEvent(
        {
          action: 'offer.expire',
          entityType: 'provider_offer',
          entityId: current.id,
          actorLabel: 'sla-worker',
          beforeState: { status: 'sent', expiresAt: current.expiresAt },
          afterState: { status: 'expired', lineStatus: next },
        },
        tx,
      );

      await refreshRequestStatus(line.requestId, tx);

      logger().warn(
        {
          offerId: current.id,
          providerCompanyId: current.providerCompanyId,
          requestServiceLineId: current.requestServiceLineId,
        },
        'offer expired without acknowledgement',
      );

      return { expired: true, reason: 'expired' };
    });
  });

  // Only a real expiry notifies. Re-running the job on an offer that was already expired,
  // or that the provider answered first, must not produce a second escalation email
  // (CLAUDE.md §18: never send duplicate notifications on job retries).
  if (result.expired) {
    await emitNotification({ kind: 'offer.expired', offerId });
  }

  return result;
}

/** Offers past their deadline and still awaiting a response. Drives the SLA sweep. */
export async function findExpiredOffers(
  now: Date,
  limit = 100,
): Promise<{ readonly id: string; readonly requestServiceLineId: string }[]> {
  const { getDb } = await import('@/db/client');
  const rows = await getDb()
    .select({ id: providerOffers.id, requestServiceLineId: providerOffers.requestServiceLineId })
    .from(providerOffers)
    .where(and(eq(providerOffers.status, 'sent'), sql`${providerOffers.expiresAt} <= ${now}`))
    .orderBy(providerOffers.expiresAt, providerOffers.id)
    .limit(limit);

  return rows;
}

/**
 * Re-matches a line after a decline or an expiry, up to the configured ceiling.
 *
 * The ceiling matters: without one, a line with two providers who both decline would
 * offer back and forth forever. At the ceiling the line fails and operations is told.
 */
export async function rematchLine(
  requestServiceLineId: string,
  options: DispatchOptions,
): Promise<DispatchResult | { readonly kind: 'ceiling_reached' }> {
  const { getDb } = await import('@/db/client');
  const db = getDb();

  const [line] = await db
    .select({
      status: requestServiceLines.status,
      rematchCount: requestServiceLines.rematchCount,
      requestId: requestServiceLines.requestId,
    })
    .from(requestServiceLines)
    .where(eq(requestServiceLines.id, requestServiceLineId))
    .limit(1);

  if (line === undefined) {
    throw new ApronError('not_found', 'That service line does not exist');
  }

  const ceiling = await readMaxRematchAttempts();
  if (line.rematchCount >= ceiling) {
    await withTransaction(async (tx) => {
      const current = await loadLineForUpdate(requestServiceLineId, tx);
      const next = transitionLine(current.status, 'fail');
      await tx
        .update(requestServiceLines)
        .set({
          status: next,
          failureReason: `No provider accepted after ${current.rematchCount} attempts.`,
        })
        .where(eq(requestServiceLines.id, requestServiceLineId));

      await recordAuditEvent(
        {
          action: 'request_line.rematch_ceiling',
          entityType: 'request_service_line',
          entityId: requestServiceLineId,
          actorLabel: 'sla-worker',
          afterState: { rematchCount: current.rematchCount, status: next },
        },
        tx,
      );

      await refreshRequestStatus(current.requestId, tx);
    });

    logger().warn({ requestServiceLineId, ceiling }, 're-match ceiling reached — line failed');
    return { kind: 'ceiling_reached' };
  }

  // Move the line back into matching before dispatching the next offer.
  await withTransaction(async (tx) => {
    const current = await loadLineForUpdate(requestServiceLineId, tx);
    if (current.status === 'declined' || current.status === 'rematching' || current.status === 'failed') {
      const next = transitionLine(current.status, 'rematch');
      await tx
        .update(requestServiceLines)
        .set({ status: next })
        .where(eq(requestServiceLines.id, requestServiceLineId));
    }
  });

  return dispatchNextOffer(requestServiceLineId, options);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Recomputes the request's status from its lines.
 *
 * Called after every line change so the request never disagrees with its own parts
 * (CLAUDE.md §29).
 */
export async function refreshRequestStatus(requestId: string, tx: Transaction): Promise<void> {
  const lines = await tx
    .select({ status: requestServiceLines.status })
    .from(requestServiceLines)
    .where(eq(requestServiceLines.requestId, requestId));

  const [request] = await tx
    .select({ status: requests.status })
    .from(requests)
    .where(eq(requests.id, requestId))
    .limit(1);

  if (request === undefined) return;

  const derived = deriveRequestStatus(
    request.status,
    lines.map((line) => line.status),
  );

  if (derived === request.status) return;

  await tx
    .update(requests)
    .set({
      status: derived,
      ...(derived === 'completed' ? { completedAt: new Date() } : {}),
    })
    .where(eq(requests.id, requestId));

  logger().info({ requestId, from: request.status, to: derived }, 'request status derived');
}

async function loadLineForUpdate(requestServiceLineId: string, tx: Transaction) {
  const rows = await tx
    .select({
      id: requestServiceLines.id,
      requestId: requestServiceLines.requestId,
      status: requestServiceLines.status,
      rematchCount: requestServiceLines.rematchCount,
      priority: requests.priority,
    })
    .from(requestServiceLines)
    .innerJoin(requests, eq(requests.id, requestServiceLines.requestId))
    .where(eq(requestServiceLines.id, requestServiceLineId))
    .for('update')
    .limit(1);

  const line = rows[0];
  if (line === undefined) {
    throw new ApronError('not_found', 'That service line does not exist');
  }
  return line;
}

async function loadOfferForUpdate(offerId: string, tx: Transaction): Promise<ProviderOffer> {
  const rows = await tx
    .select()
    .from(providerOffers)
    .where(eq(providerOffers.id, offerId))
    .for('update')
    .limit(1);

  const offer = rows[0];
  if (offer === undefined) {
    throw new ApronError('not_found', 'That offer does not exist');
  }
  return offer;
}

async function readDeclinedProviderIds(requestServiceLineId: string): Promise<string[]> {
  const { getDb } = await import('@/db/client');
  const rows = await getDb()
    .select({ providerCompanyId: providerOffers.providerCompanyId })
    .from(providerOffers)
    .where(
      and(
        eq(providerOffers.requestServiceLineId, requestServiceLineId),
        sql`${providerOffers.status} in ('declined', 'expired')`,
      ),
    );

  return [...new Set(rows.map((row) => row.providerCompanyId))];
}

async function readAcknowledgementSla(priority: string, tx: Transaction): Promise<number> {
  const key =
    priority === 'urgent' ? 'sla.acknowledgement_minutes.urgent' : 'sla.acknowledgement_minutes.default';

  const [row] = await tx
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, key))
    .limit(1);

  const value = row?.value;
  return typeof value === 'number' && value > 0 ? value : 45;
}

async function readMaxRematchAttempts(): Promise<number> {
  const { getDb } = await import('@/db/client');
  const [row] = await getDb()
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, 'matching.max_rematch_attempts'))
    .limit(1);

  const value = row?.value;
  return typeof value === 'number' && value > 0 ? value : 4;
}

function describeNoProvider(decision: MatchDecision): string {
  const rejected = decision.outcome.rejected.length;
  if (rejected === 0) return 'No provider covers this service at this airport.';

  // The most common reason among the rejections is the useful headline for operations.
  const counts = new Map<string, number>();
  for (const candidate of decision.outcome.rejected) {
    for (const code of candidate.reasonCodes) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top === undefined
    ? `All ${rejected} providers were rejected.`
    : `All ${rejected} providers were rejected; most commonly: ${top[0].replace(/_/g, ' ')}.`;
}

function snapshotOf(candidate: {
  providerCompanyId: string;
  displayName: string;
  eligible: boolean;
  reasonCodes: readonly string[];
  spareCapacity: number;
  leadTimeMarginMinutes: number | null;
}) {
  return {
    providerCompanyId: candidate.providerCompanyId,
    providerName: candidate.displayName,
    rank: 'rank' in candidate ? (candidate as { rank: number }).rank : 0,
    eligible: candidate.eligible,
    reasonCodes: [...candidate.reasonCodes],
    spareCapacity: candidate.spareCapacity,
    leadTimeMarginMinutes: candidate.leadTimeMarginMinutes,
    sameProviderOnOtherLines:
      'sameProviderOnOtherLines' in candidate
        ? (candidate as { sameProviderOnOtherLines: number }).sameProviderOnOtherLines
        : 0,
  };
}
