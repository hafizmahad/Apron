import '@/lib/server-guard';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { requestServiceLines } from '@/db/schema';
import { dispatchNextOffer } from '@/services/offers';
import { enqueueMatching, scheduleOfferExpiry } from '@/jobs/queues/definitions';
import { getEnv } from '@/lib/config/env';
import { currentCorrelation, logError, logger } from '@/lib/logging';

/**
 * Starting matching on a confirmed request (CLAUDE.md §8 step 4: "enqueue matching").
 *
 * This is the join between intake and the offer waterfall, and its absence was why a
 * confirmed request went nowhere: `createRequest` leaves every line in `matching`, and
 * until something dispatches, no offer exists, so no provider ever sees the work. The
 * request looked created and was, in operational terms, inert.
 *
 * Two paths, and both must work, because the product is used in both configurations:
 *
 *  - **queue on** — each line is enqueued and the worker dispatches. The HTTP request
 *    returns as soon as the jobs are accepted, so a slow match never holds up the person
 *    who pressed the button.
 *  - **queue off** — dispatch runs inline. A developer with no Redis, and the integration
 *    suite, still get a working end-to-end flow rather than a silently dead one.
 *
 * It never throws. The request is already committed by the time this runs; failing the
 * caller now would report an error for something that genuinely happened, and the periodic
 * sweep plus the operations "retry" control both exist to recover a line that did not get
 * its offer.
 */

export interface DispatchSummary {
  readonly lines: number;
  /** Lines that reached a real offer. Only meaningful on the inline path. */
  readonly offered: number;
  /** Lines nobody could cover. Only meaningful on the inline path. */
  readonly failed: number;
  readonly mode: 'queued' | 'inline';
}

export async function startMatchingForRequest(
  requestId: string,
  options: { readonly now?: Date; readonly actorUserId?: string | null } = {},
): Promise<DispatchSummary> {
  const now = options.now ?? new Date();
  const correlationId = currentCorrelation()?.correlationId ?? 'none';

  const lines = await getDb()
    .select({ id: requestServiceLines.id, status: requestServiceLines.status })
    .from(requestServiceLines)
    .where(eq(requestServiceLines.requestId, requestId))
    .orderBy(requestServiceLines.sequence);

  // Only lines actually awaiting a match. A line already offered or assigned must not be
  // dispatched a second time — that is how a provider ends up with two offers for one job.
  const pending = lines.filter((line) => line.status === 'matching' || line.status === 'draft');

  if (pending.length === 0) {
    return { lines: 0, offered: 0, failed: 0, mode: getEnv().QUEUE_ENABLED ? 'queued' : 'inline' };
  }

  if (getEnv().QUEUE_ENABLED) {
    let queued = 0;
    for (const line of pending) {
      try {
        await enqueueMatching({
          requestServiceLineId: line.id,
          correlationId,
          trigger: 'initial',
        });
        queued += 1;
      } catch (error) {
        // One line failing to enqueue must not stop the others: a five-service request
        // where the queue hiccuped on service three should still dispatch one, two, four
        // and five.
        logError('could not enqueue matching for a line', error, {
          requestId,
          requestServiceLineId: line.id,
        });
      }
    }

    logger().info({ requestId, queued, of: pending.length }, 'matching enqueued');
    return { lines: pending.length, offered: 0, failed: 0, mode: 'queued' };
  }

  // --- inline -------------------------------------------------------------
  let offered = 0;
  let failed = 0;

  for (const line of pending) {
    try {
      const result = await dispatchNextOffer(line.id, {
        evaluationNow: now,
        ...(options.actorUserId === undefined ? {} : { actorUserId: options.actorUserId }),
      });

      if (result.kind === 'offered' && result.offer !== null) {
        offered += 1;
        // The deadline is scheduled with the offer, so the SLA holds on this path too.
        // With the queue disabled this is a no-op, and the periodic sweep is what expires
        // the offer instead — which is exactly why the sweep exists.
        await scheduleOfferExpiry(
          { offerId: result.offer.id, requestServiceLineId: line.id, correlationId },
          result.offer.expiresAt,
          now,
        );
      } else {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      logError('inline dispatch failed for a line', error, {
        requestId,
        requestServiceLineId: line.id,
      });
    }
  }

  logger().info({ requestId, offered, failed }, 'matching dispatched inline');
  return { lines: pending.length, offered, failed, mode: 'inline' };
}
