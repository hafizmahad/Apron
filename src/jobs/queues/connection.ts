import '@/lib/server-guard';
import { Redis, type RedisOptions } from 'ioredis';
import { getEnv } from '@/lib/config/env';
import { ApronError } from '@/lib/errors';
import { logger } from '@/lib/logging';

/**
 * Shared Redis connections for BullMQ (CLAUDE.md §3).
 *
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by blocking workers,
 * and forbids sharing one connection between a Worker's blocking commands and ordinary
 * queue commands — so producers and consumers get separate connections here.
 */

let producerConnection: Redis | undefined;
const consumerConnections: Redis[] = [];

function baseOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (attempt: number) => Math.min(attempt * 250, 5_000),
  };
}

function attachDiagnostics(connection: Redis, role: string): Redis {
  connection.on('error', (error: Error) => {
    logger().error({ err: error, role }, 'redis connection error');
  });
  connection.on('end', () => {
    logger().warn({ role }, 'redis connection closed');
  });
  return connection;
}

/** The connection queue producers and schedulers share. */
export function getQueueConnection(): Redis {
  if (producerConnection === undefined) {
    producerConnection = attachDiagnostics(
      new Redis(getEnv().REDIS_URL, baseOptions()),
      'queue-producer',
    );
  }
  return producerConnection;
}

/** A fresh connection for a BullMQ Worker's blocking commands. */
export function createWorkerConnection(name: string): Redis {
  const connection = attachDiagnostics(
    new Redis(getEnv().REDIS_URL, baseOptions()),
    `worker:${name}`,
  );
  consumerConnections.push(connection);
  return connection;
}

/** Liveness probe used by `/api/health` and the smoke script. */
export async function checkRedisHealth(): Promise<{ ok: true; latencyMs: number }> {
  const startedAt = Date.now();
  try {
    const pong = await getQueueConnection().ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected PING reply: ${pong}`);
    }
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApronError('queue_unavailable', `Redis is not reachable: ${detail}`, { cause: error });
  }
}

export async function closeRedisConnections(): Promise<void> {
  const closing = [...consumerConnections];
  consumerConnections.length = 0;
  if (producerConnection !== undefined) {
    closing.push(producerConnection);
    producerConnection = undefined;
  }
  await Promise.all(closing.map(async (connection) => connection.quit().catch(() => connection.disconnect())));
}
