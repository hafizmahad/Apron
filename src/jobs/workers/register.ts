import '@/lib/server-guard';
import { Worker, type Job } from 'bullmq';
import { getEnv } from '@/lib/config/env';
import { logError, logger, withCorrelation } from '@/lib/logging';
import { createWorkerConnection } from '@/jobs/queues/connection';
import {
  QUEUE_NAMES,
  closeQueues,
  enqueueMatching,
  scheduleOfferExpiry,
  type ExpireOfferJob,
  type MatchLineJob,
  type NotificationJob,
} from '@/jobs/queues/definitions';
import { dispatchNextOffer, expireOffer, findExpiredOffers, rematchLine } from '@/services/offers';
import { notify, parseNotificationJob, retryFailedDeliveries } from '@/services/notifications';

/**
 * Worker registration (CLAUDE.md §3, Phase 6).
 *
 * Three workers and one sweep:
 *
 *  - **offer-sla** expires a specific offer at its deadline;
 *  - **matching** matches a line and dispatches the next offer;
 *  - **notifications** records the in-app entry and sends the email;
 *  - a periodic **sweep** catches any offer whose delayed job was lost — a worker restart,
 *    a Redis flush, a deploy — and retries failed email deliveries. The sweep is what makes
 *    the SLA a guarantee rather than a hope: nothing depends on a single delayed message
 *    surviving.
 *
 * Every handler is idempotent (§3) and every handler's work is transactional, so a job
 * delivered twice is harmless and a job that fails mid-way leaves nothing half-done.
 */

export interface RegisteredWorkers {
  readonly queueNames: readonly string[];
  readonly close: () => Promise<void>;
}

/** How often the safety-net sweep runs. */
const SWEEP_INTERVAL_MS = 60_000;

export async function registerWorkers(): Promise<RegisteredWorkers> {
  const env = getEnv();

  if (!env.QUEUE_ENABLED) {
    logger().warn('QUEUE_ENABLED is false — no workers registered');
    return { queueNames: [], close: async () => {} };
  }

  const workers: Worker[] = [];
  const queueNames: string[] = [];

  // --- offer SLA expiry ---------------------------------------------------
  const slaWorker = new Worker<ExpireOfferJob>(
    QUEUE_NAMES.offerSla,
    async (job: Job<ExpireOfferJob>) => handleExpireOffer(job.data),
    { connection: createWorkerConnection('offer-sla'), concurrency: env.WORKER_CONCURRENCY },
  );
  attachDiagnostics(slaWorker, QUEUE_NAMES.offerSla);
  workers.push(slaWorker);
  queueNames.push(QUEUE_NAMES.offerSla);

  // --- matching and re-match ---------------------------------------------
  const matchingWorker = new Worker<MatchLineJob>(
    QUEUE_NAMES.matching,
    async (job: Job<MatchLineJob>) => handleMatchLine(job.data),
    { connection: createWorkerConnection('matching'), concurrency: env.WORKER_CONCURRENCY },
  );
  attachDiagnostics(matchingWorker, QUEUE_NAMES.matching);
  workers.push(matchingWorker);
  queueNames.push(QUEUE_NAMES.matching);

  // --- notifications ------------------------------------------------------
  const notificationWorker = new Worker<NotificationJob>(
    QUEUE_NAMES.notifications,
    async (job: Job<NotificationJob>) => handleNotification(job.data),
    { connection: createWorkerConnection('notifications'), concurrency: env.WORKER_CONCURRENCY },
  );
  attachDiagnostics(notificationWorker, QUEUE_NAMES.notifications);
  workers.push(notificationWorker);
  queueNames.push(QUEUE_NAMES.notifications);

  // --- safety-net sweep ---------------------------------------------------
  const sweep = setInterval(() => {
    void runExpirySweep().catch((error: unknown) => {
      logError('offer expiry sweep failed', error);
    });
    void retryFailedDeliveries().catch((error: unknown) => {
      logError('notification delivery retry failed', error);
    });
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open for a sweep.
  sweep.unref?.();

  return {
    queueNames,
    close: async () => {
      clearInterval(sweep);
      await Promise.all(workers.map(async (worker) => worker.close()));
      await closeQueues();
    },
  };
}

/**
 * Expires one offer and enqueues the re-match.
 *
 * Idempotent: `expireOffer` reports `expired: false` when the offer was already expired or
 * was answered first, and in that case nothing further is enqueued. That is what stops a
 * redelivered job from producing a second offer or a duplicate notification (§18).
 */
export async function handleExpireOffer(data: ExpireOfferJob, now = new Date()): Promise<void> {
  await withCorrelation({ correlationId: data.correlationId, route: 'worker/offer-sla' }, async () => {
    // The instant is a parameter, not a clock read: the sweep decides what is due as of a
    // specific moment and the handler must judge the same offer against that same moment.
    // Reading the clock here made the two disagree.
    const result = await expireOffer(data.offerId, now);

    if (!result.expired) {
      logger().debug(
        { offerId: data.offerId, reason: result.reason },
        'offer expiry skipped — nothing to do',
      );
      return;
    }

    await enqueueMatching({
      requestServiceLineId: data.requestServiceLineId,
      correlationId: data.correlationId,
      trigger: 'rematch',
    });
  });
}

/**
 * Matches a line and dispatches the resulting offer, then schedules that offer's expiry.
 *
 * The expiry is scheduled from inside the handler rather than by the caller so there is
 * exactly one place where an offer and its deadline are created together.
 */
export async function handleMatchLine(data: MatchLineJob): Promise<void> {
  await withCorrelation({ correlationId: data.correlationId, route: 'worker/matching' }, async () => {
    const now = new Date();

    const result =
      data.trigger === 'rematch'
        ? await rematchLine(data.requestServiceLineId, { evaluationNow: now })
        : await dispatchNextOffer(data.requestServiceLineId, { evaluationNow: now });

    if ('kind' in result && result.kind === 'ceiling_reached') {
      logger().warn(
        { requestServiceLineId: data.requestServiceLineId },
        're-match ceiling reached — operations must intervene',
      );
      return;
    }

    if (result.kind === 'failed') {
      logger().warn(
        { requestServiceLineId: data.requestServiceLineId },
        'no eligible provider — line failed',
      );
      return;
    }

    if (result.offer !== null) {
      await scheduleOfferExpiry(
        {
          offerId: result.offer.id,
          requestServiceLineId: data.requestServiceLineId,
          correlationId: data.correlationId,
        },
        result.offer.expiresAt,
        now,
      );
    }
  });
}

/**
 * Delivers one notification.
 *
 * The payload is re-parsed rather than trusted: a job sitting in Redis from a previous
 * deployment may name an event this version no longer has. An unrecognised job is dropped
 * with a warning instead of crashing the worker and blocking the queue behind it.
 */
export async function handleNotification(data: NotificationJob): Promise<void> {
  await withCorrelation(
    { correlationId: data.correlationId, route: 'worker/notifications' },
    async () => {
      const event = parseNotificationJob(data.payload);

      if (event === null) {
        logger().warn({ kind: data.kind }, 'unrecognised notification job — dropped');
        return;
      }

      const result = await notify(event);
      logger().debug({ kind: event.kind, delivered: result.delivered }, 'notification handled');
    },
  );
}

/**
 * The safety net: finds offers past their deadline that no delayed job expired.
 *
 * Exported so an operator — or a test — can run it directly.
 */
export async function runExpirySweep(now: Date = new Date()): Promise<number> {
  const due = await findExpiredOffers(now);
  if (due.length === 0) return 0;

  logger().warn({ count: due.length }, 'expiry sweep found offers past their deadline');

  let expired = 0;
  for (const offer of due) {
    const correlationId = `sweep-${offer.id}`;
    await handleExpireOffer(
      {
        offerId: offer.id,
        requestServiceLineId: offer.requestServiceLineId,
        correlationId,
      },
      now,
    );
    expired += 1;
  }
  return expired;
}

function attachDiagnostics(worker: Worker, queueName: string): void {
  worker.on('completed', (job) => {
    logger().debug({ queue: queueName, jobId: job.id }, 'job completed');
  });

  worker.on('failed', (job, error) => {
    // A bounded retry is normal; the final failure is what matters (§3, §28).
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts.attempts ?? 1;
    const exhausted = attemptsMade >= maxAttempts;

    logger()[exhausted ? 'error' : 'warn'](
      { queue: queueName, jobId: job?.id, attemptsMade, maxAttempts, err: error },
      exhausted ? 'job failed permanently' : 'job attempt failed, will retry',
    );
  });

  worker.on('error', (error) => {
    logger().error({ queue: queueName, err: error }, 'worker error');
  });
}
