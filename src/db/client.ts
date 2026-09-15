import '@/lib/server-guard';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getEnv } from '@/lib/config/env';
import { ApronError } from '@/lib/errors';
import { logger } from '@/lib/logging';
import * as schema from './schema';

/**
 * One pool per process (ADR-004). The web process and the worker each own one; both
 * import this module, so neither can open a second, unmanaged connection path.
 */

let pool: Pool | undefined;
let database: NodePgDatabase<typeof schema> | undefined;

function poolConfig(): PoolConfig {
  const env = getEnv();
  return {
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Statement timeout keeps a pathological query from pinning a connection forever.
    statement_timeout: 30_000,
    application_name: 'apron',
    ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

export function getPool(): Pool {
  if (pool === undefined) {
    pool = new Pool(poolConfig());
    pool.on('error', (error) => {
      // An idle client erroring is not fatal for the process, but it must never be silent.
      logger().error({ err: error }, 'postgres idle client error');
    });
  }
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  database ??= drizzle(getPool(), { schema, casing: 'snake_case' });
  return database;
}

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything a query helper can run against: the pool-backed db or an open transaction. */
export type Executor = Database | Transaction;

/**
 * Runs `fn` in a single transaction. Every mutation that must be atomic (acknowledgement,
 * assignment, offer expiry, re-match, cancellation, override — CLAUDE.md §30) goes
 * through this.
 */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => fn(tx));
}

/**
 * Serialises a critical section across processes using a Postgres advisory lock held for
 * the life of the transaction. Used where two workers could otherwise race on the same
 * request line (offer expiry vs. a provider acknowledging).
 */
export async function withAdvisoryLock<T>(
  tx: Transaction,
  namespace: number,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const hashed = hashKeyToInt(key);
  await tx.execute(sql`select pg_advisory_xact_lock(${namespace}, ${hashed})`);
  return fn();
}

/** Stable 32-bit signed hash, so the same key always maps to the same lock slot. */
export function hashKeyToInt(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) | 0;
  }
  return hash;
}

/** Liveness probe used by `/api/health` and the smoke script. */
export async function checkDatabaseHealth(): Promise<{ ok: true; latencyMs: number }> {
  const startedAt = Date.now();
  let client: PoolClient | undefined;
  try {
    client = await getPool().connect();
    await client.query('select 1');
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    // Carry the driver's own message. A health check that says only 'not reachable'
    // when the real fault is a bad password or a missing database is actively
    // misleading (CLAUDE.md §28: no generic 'something went wrong').
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApronError('database_unavailable', `PostgreSQL is not reachable: ${detail}`, {
      cause: error,
    });
  } finally {
    client?.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool === undefined) return;
  const closing = pool;
  pool = undefined;
  database = undefined;
  await closing.end();
}
