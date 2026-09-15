import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { getDb, getPool } from '@/db/client';
import { runMigrations } from '@/db/migrate';

/**
 * Integration-test database helpers.
 *
 * `tests/setup/integration.ts` has already refused to run against a database whose name
 * does not contain "test", so everything here is safe by the time it executes.
 */

let migrated = false;

/** Applies migrations once per test process. Safe to call from every suite. */
export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await runMigrations();
  migrated = true;
}

/**
 * Empties every application table, leaving the schema and the migration ledger intact.
 *
 * `TRUNCATE ... RESTART IDENTITY CASCADE` in one statement is both faster than per-table
 * deletes and immune to foreign-key ordering, which matters because the graph here is
 * deep (request -> line -> offer -> assignment -> resource).
 */
export async function truncateAll(): Promise<void> {
  await ensureMigrated();
  const db = getDb();

  const result = await db.execute<{ tablename: string }>(sql`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> '_apron_migrations'
    order by tablename
  `);

  const tables = result.rows.map((row) => `public.${quoteIdentifier(row.tablename)}`);
  if (tables.length === 0) return;

  await db.execute(sql.raw(`truncate table ${tables.join(', ')} restart identity cascade`));
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Runs `fn` and resolves to the thrown error, failing if nothing was thrown. */
export async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected the operation to throw, but it resolved successfully');
}

/** The Postgres `SQLSTATE` of a driver error, or null when it is not a database error. */
export function sqlState(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** The constraint name a database error names, when it names one. */
export function violatedConstraint(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : null;
}

/** Direct pool access for tests that need two concurrent sessions. */
export async function withTwoSessions<T>(
  fn: (a: PoolClient, b: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    return await fn(first, second);
  } finally {
    second.release();
    first.release();
  }
}
