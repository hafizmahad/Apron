import '@/lib/server-guard';
import { getQueueConnection } from '@/jobs/queues/connection';
import { getEnv } from '@/lib/config/env';
import { logger } from '@/lib/logging';

/**
 * Fixed-window rate limiting backed by Redis (CLAUDE.md §27).
 *
 * A fixed window rather than a sliding log: one `INCR` plus one `EXPIRE`, no per-request
 * set to trim, and the burst tolerance at a window edge is irrelevant for the things this
 * actually guards — sign-in attempts, guest request creation, AI-backed endpoints.
 *
 * **Fails open, loudly.** If Redis is unreachable the request is allowed and the failure
 * is logged at error level. Rate limiting is a protection, not a correctness invariant;
 * making the whole product unusable because a cache is down would be the worse failure.
 * Anything that must be refused when Redis is down is guarded by a database constraint
 * instead.
 */

export interface RateLimitRequest {
  /** Stable identifier for the thing being limited: `login:<ip>:<email>`. */
  readonly key: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export async function checkRateLimit(request: RateLimitRequest): Promise<RateLimitResult> {
  const env = getEnv();

  if (!env.RATE_LIMIT_ENABLED) {
    return { allowed: true, remaining: request.limit, retryAfterSeconds: 0 };
  }

  const redisKey = `apron:ratelimit:${request.key}`;

  try {
    const connection = getQueueConnection();

    // One round trip. EXPIRE is set only on the first increment, so the window starts at
    // the first attempt rather than sliding forward with every subsequent one.
    const [countResult, ttlResult] = await connection
      .multi()
      .incr(redisKey)
      .ttl(redisKey)
      .exec()
      .then((replies) => replies ?? []);

    const count = readNumber(countResult);
    const ttl = readNumber(ttlResult);

    if (count === null) {
      return failOpen(request, 'malformed INCR reply');
    }

    if (count === 1 || ttl === null || ttl < 0) {
      await connection.expire(redisKey, request.windowSeconds);
    }

    const remaining = Math.max(0, request.limit - count);
    const allowed = count <= request.limit;

    return {
      allowed,
      remaining,
      retryAfterSeconds: allowed ? 0 : ttl !== null && ttl > 0 ? ttl : request.windowSeconds,
    };
  } catch (error) {
    return failOpen(request, error);
  }
}

/** Clears a limiter — used after a successful sign-in so one typo does not linger. */
export async function resetRateLimit(key: string): Promise<void> {
  if (!getEnv().RATE_LIMIT_ENABLED) return;
  try {
    await getQueueConnection().del(`apron:ratelimit:${key}`);
  } catch (error) {
    logger().warn({ err: error, key }, 'rate limit reset failed');
  }
}

function failOpen(request: RateLimitRequest, cause: unknown): RateLimitResult {
  logger().error(
    { err: cause, key: request.key },
    'rate limiter unavailable — allowing the request (fail-open)',
  );
  return { allowed: true, remaining: request.limit, retryAfterSeconds: 0 };
}

/** ioredis `multi().exec()` yields `[error, value]` tuples. */
function readNumber(reply: unknown): number | null {
  if (!Array.isArray(reply)) return null;
  const [error, value] = reply as [unknown, unknown];
  if (error !== null && error !== undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
