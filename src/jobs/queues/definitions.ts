import '@/lib/server-guard';
import { Queue, type JobsOptions } from 'bullmq';
import { getQueueConnection } from './connection';
import { getEnv } from '@/lib/config/env';
import { logger } from '@/lib/logging';

/**
 * Queue definitions (CLAUDE.md §3).
 *
 * Every job carries a `correlationId` so the work a background handler does can be traced
 * back to the HTTP request that caused it, and an explicit idempotency key where the
 * effect is externally visible.
 *
 * Job ids use `-` as a separator, never `:` — BullMQ namespaces its Redis keys with colons
 * and rejects a custom id containing one.
 *
 * Retries are bounded and observable: three attempts with exponential backoff, failures
 * retained so the Admin console can show them rather than losing them to a silent drop.
 */

export const QUEUE_NAMES = Object.freeze({
  offerSla: 'apron.offer-sla',
  matching: 'apron.matching',
  notifications: 'apron.notifications',
});

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Shared job policy. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  // Completed jobs are trimmed; failures are kept so they can be inspected.
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

export interface ExpireOfferJob {
  readonly offerId: string;
  readonly requestServiceLineId: string;
  readonly correlationId: string;
}

export interface MatchLineJob {
  readonly requestServiceLineId: string;
  readonly correlationId: string;
  /** `initial` never re-matches; `rematch` respects the attempt ceiling. */
  readonly trigger: 'initial' | 'rematch';
}

export interface NotificationJob {
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

let offerSlaQueue: Queue<ExpireOfferJob> | undefined;
let matchingQueue: Queue<MatchLineJob> | undefined;
let notificationQueue: Queue<NotificationJob> | undefined;

export function getOfferSlaQueue(): Queue<ExpireOfferJob> {
  offerSlaQueue ??= new Queue<ExpireOfferJob>(QUEUE_NAMES.offerSla, {
    connection: getQueueConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return offerSlaQueue;
}

export function getMatchingQueue(): Queue<MatchLineJob> {
  matchingQueue ??= new Queue<MatchLineJob>(QUEUE_NAMES.matching, {
    connection: getQueueConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return matchingQueue;
}

export function getNotificationQueue(): Queue<NotificationJob> {
  notificationQueue ??= new Queue<NotificationJob>(QUEUE_NAMES.notifications, {
    connection: getQueueConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return notificationQueue;
}

/**
 * Schedules an offer to be checked at its deadline.
 *
 * The job id is the offer id, so BullMQ itself deduplicates: scheduling the same offer
 * twice cannot produce two expiries. The handler is idempotent regardless — belt and
 * braces, because a delayed job can still be delivered more than once.
 */
export async function scheduleOfferExpiry(
  job: ExpireOfferJob,
  expiresAt: Date,
  now: Date,
): Promise<void> {
  if (!getEnv().QUEUE_ENABLED) {
    logger().debug({ offerId: job.offerId }, 'queue disabled — expiry not scheduled');
    return;
  }

  const delay = Math.max(0, expiresAt.getTime() - now.getTime());

  await getOfferSlaQueue().add('expire-offer', job, {
    ...DEFAULT_JOB_OPTIONS,
    delay,
    jobId: `expire-${job.offerId}`,
  });

  logger().debug({ offerId: job.offerId, delayMs: delay }, 'offer expiry scheduled');
}

/** Enqueues a line for matching. */
export async function enqueueMatching(job: MatchLineJob): Promise<void> {
  if (!getEnv().QUEUE_ENABLED) {
    logger().debug({ requestServiceLineId: job.requestServiceLineId }, 'queue disabled — matching not enqueued');
    return;
  }

  await getMatchingQueue().add('match-line', job, {
    ...DEFAULT_JOB_OPTIONS,
    // A line can legitimately be matched several times, so the id includes the trigger
    // and a timestamp rather than deduplicating on the line alone.
    jobId: `match-${job.requestServiceLineId}-${job.trigger}-${Date.now()}`,
  });
}

/** Enqueues a notification. The idempotency key is the job id, so retries cannot duplicate. */
export async function enqueueNotification(job: NotificationJob): Promise<void> {
  if (!getEnv().QUEUE_ENABLED) return;

  await getNotificationQueue().add('notify', job, {
    ...DEFAULT_JOB_OPTIONS,
    jobId: `notify-${job.idempotencyKey}`,
  });
}

export async function closeQueues(): Promise<void> {
  await Promise.all(
    [offerSlaQueue, matchingQueue, notificationQueue].map(async (queue) => queue?.close()),
  );
  offerSlaQueue = undefined;
  matchingQueue = undefined;
  notificationQueue = undefined;
}
