import '@/lib/server-guard';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getPool } from './client';

/**
 * Deterministic SQL migration runner (ADR-003).
 *
 * Migrations are plain `.sql` files named `NNNN_description.sql`, applied in filename
 * order, each inside its own transaction, recorded in `_apron_migrations` with the
 * checksum of the file that was applied. Re-running is a no-op. An already-applied file
 * whose contents have changed is a hard error — an edited migration means the database
 * and the repository disagree about history, which must never be papered over.
 */

const MIGRATIONS_DIR = resolveMigrationsDir();

function resolveMigrationsDir(): string {
  // Works both from `src/db/migrate.ts` under tsx and from the bundled `dist-worker/`.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'migrations'),
    join(here, '../src/db/migrations'),
    join(process.cwd(), 'src/db/migrations'),
  ];
  for (const candidate of candidates) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`Could not locate the migrations directory. Tried:\n  ${candidates.join('\n  ')}`);
}

interface MigrationFile {
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      return {
        filename,
        sql,
        // Normalise line endings so a Windows checkout and a Linux container agree.
        checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
      };
    });
}

const LEDGER_SQL = `
  create table if not exists _apron_migrations (
    filename    text        primary key,
    checksum    text        not null,
    applied_at  timestamptz not null default now()
  )
`;

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export async function runMigrations(options: { log?: (message: string) => void } = {}): Promise<MigrationResult> {
  const log = options.log ?? (() => {});
  const pool = getPool();
  const client = await pool.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query(LEDGER_SQL);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'select filename, checksum from _apron_migrations',
    );
    const previous = new Map(rows.map((row) => [row.filename, row.checksum]));

    for (const migration of loadMigrations()) {
      const recorded = previous.get(migration.filename);

      if (recorded !== undefined) {
        if (recorded !== migration.checksum) {
          throw new Error(
            `Migration ${migration.filename} has been modified after it was applied.\n` +
              `  recorded checksum: ${recorded}\n` +
              `  file checksum:     ${migration.checksum}\n` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        skipped.push(migration.filename);
        continue;
      }

      log(`applying ${migration.filename}`);
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query('insert into _apron_migrations (filename, checksum) values ($1, $2)', [
          migration.filename,
          migration.checksum,
        ]);
        await client.query('commit');
        applied.push(migration.filename);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`Migration ${migration.filename} failed: ${String(error)}`, { cause: error });
      }
    }

    return { applied, skipped };
  } finally {
    client.release();
  }
}

/** Direct execution: `npm run db:migrate` or `node dist-worker/migrate.js`. */
const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'));

if (isDirectRun) {
  try {
    const result = await runMigrations({ log: (message) => console.log(`[migrate] ${message}`) });
    console.log(
      `[migrate] done — ${result.applied.length} applied, ${result.skipped.length} already present`,
    );
    await closePool();
    process.exit(0);
  } catch (error) {
    console.error('[migrate] failed');
    console.error(error);
    await closePool();
    process.exit(1);
  }
}
