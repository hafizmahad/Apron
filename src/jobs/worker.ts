import '@/lib/server-guard';
import { checkDatabaseHealth, closePool } from '@/db/client';
import { checkRedisHealth, closeRedisConnections } from '@/jobs/queues/connection';
import { getEnv } from '@/lib/config/env';
import { logger, withCorrelation, newCorrelationId } from '@/lib/logging';

/**
 * Worker process entrypoint (ADR-001).
 *
 * Responsibilities, added phase by phase:
 *  - Phase 6: acknowledgement SLA expiry, re-match on decline/timeout, offer dispatch;
 *  - Phase 10: notification delivery and document generation.
 *
 * Every handler is idempotent and every retry is bounded and observable (CLAUDE.md §3).
 * The process verifies both dependencies before registering any worker, so a
 * misconfigured container fails immediately and visibly rather than silently consuming
 * jobs it cannot complete.
 */

type Shutdown = () => Promise<void>;

const shutdownHooks: Shutdown[] = [];

async function main(): Promise<void> {
  const env = getEnv();
  const log = logger();

  log.info(
    { concurrency: env.WORKER_CONCURRENCY, environment: env.APP_ENV },
    'apron worker starting',
  );

  const [database, redis] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);
  log.info(
    { databaseLatencyMs: database.latencyMs, redisLatencyMs: redis.latencyMs },
    'worker dependencies reachable',
  );

  const { registerWorkers } = await import('./workers/register');
  const registered = await registerWorkers();
  shutdownHooks.push(registered.close);

  log.info({ queues: registered.queueNames }, 'apron worker ready');
}

async function shutdown(signal: string): Promise<void> {
  await withCorrelation({ correlationId: newCorrelationId() }, async () => {
    logger().info({ signal }, 'apron worker shutting down');
    for (const hook of shutdownHooks.reverse()) {
      try {
        await hook();
      } catch (error) {
        logger().error({ err: error }, 'shutdown hook failed');
      }
    }
    await closeRedisConnections();
    await closePool();
    logger().info('apron worker stopped');
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

process.on('unhandledRejection', (reason) => {
  logger().fatal({ err: reason }, 'unhandled rejection in worker');
  process.exitCode = 1;
});

await withCorrelation({ correlationId: newCorrelationId() }, main).catch(async (error: unknown) => {
  logger().fatal({ err: error }, 'apron worker failed to start');
  await closeRedisConnections();
  await closePool();
  process.exit(1);
});
