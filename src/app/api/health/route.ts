import { NextResponse } from 'next/server';
import { checkDatabaseHealth } from '@/db/client';
import { checkRedisHealth } from '@/jobs/queues/connection';
import { getEnv, isAiEnabled } from '@/lib/config/env';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Real liveness, not a static 200 (CLAUDE.md §28, §35).
 *
 * Reports the actual state of each dependency. `status` is `ok` only when every required
 * dependency answered; a degraded dependency produces 503 so a load balancer or the smoke
 * script fails loudly instead of routing traffic to a broken instance.
 *
 * Nothing secret is returned: no connection strings, no keys — only names, latencies and
 * a boolean for whether AI is configured.
 */

type DependencyReport =
  | { status: 'ok'; latencyMs: number }
  | { status: 'error'; error: string };

async function probe(check: () => Promise<{ latencyMs: number }>): Promise<DependencyReport> {
  try {
    const { latencyMs } = await check();
    return { status: 'ok', latencyMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { status: 'error', error: message };
  }
}

export async function GET(): Promise<NextResponse> {
  const correlationId = newCorrelationId();

  return withCorrelation({ correlationId, route: '/api/health' }, async () => {
    const env = getEnv();
    const [database, redis] = await Promise.all([
      probe(checkDatabaseHealth),
      probe(checkRedisHealth),
    ]);

    const healthy = database.status === 'ok' && redis.status === 'ok';
    if (!healthy) {
      logError('health check degraded', new Error('dependency unavailable'), { database, redis });
    }

    return NextResponse.json(
      {
        status: healthy ? 'ok' : 'degraded',
        service: 'apron-web',
        environment: env.APP_ENV,
        correlationId,
        checkedAt: new Date().toISOString(),
        dependencies: { database, redis },
        features: {
          aiEnabled: isAiEnabled(env),
          queueEnabled: env.QUEUE_ENABLED,
          rateLimitEnabled: env.RATE_LIMIT_ENABLED,
        },
      },
      {
        status: healthy ? 200 : 503,
        headers: { 'cache-control': 'no-store', 'x-correlation-id': correlationId },
      },
    );
  });
}
