import { beforeAll, afterAll } from 'vitest';
import { defaultEnv, setEnv } from './env';

/**
 * Integration/contract suite preconditions: a real PostgreSQL, and Redis for queue suites.
 *
 * `TEST_DATABASE_URL` points at a disposable database — the Compose `postgres` service is
 * the intended target locally (CLAUDE.md §3 "integration tests against disposable/local
 * PostgreSQL"). The suite refuses to run against a URL whose database name does not mark
 * it as a test database, so a mis-set variable can never truncate a real one.
 */

setEnv('NODE_ENV', 'test');
setEnv('APP_ENV', 'ci');
setEnv('AI_ENABLED', 'false');
setEnv('TZ', 'UTC');
// Notifications are delivered INLINE in integration tests rather than handed to BullMQ, so
// a test asserts on what the product actually did instead of on a job having been enqueued.
// The queue path has its own coverage through `handleNotification`.
setEnv('QUEUE_ENABLED', 'false');
// Captured, never sent. `useMemoryMailTransportForTests()` hands a suite the array.
setEnv('MAIL_TRANSPORT', 'memory');
defaultEnv('SESSION_SECRET', 'integration-session-secret-at-least-32-chars');
defaultEnv('LOG_LEVEL', 'silent');

const DEFAULT_TEST_DATABASE_URL = 'postgres://apron:apron_local_dev@localhost:55432/apron_test';
const DEFAULT_TEST_REDIS_URL = 'redis://localhost:56379/15';

const databaseUrl = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
const redisUrl = process.env['TEST_REDIS_URL'] ?? DEFAULT_TEST_REDIS_URL;

assertLooksLikeTestDatabase(databaseUrl);

setEnv('DATABASE_URL', databaseUrl);
setEnv('REDIS_URL', redisUrl);

function assertLooksLikeTestDatabase(url: string): void {
  let databaseName: string;
  try {
    databaseName = new URL(url).pathname.replace(/^\//, '');
  } catch (error) {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${String(error)}`);
  }

  if (!/test/i.test(databaseName)) {
    throw new Error(
      `Refusing to run destructive integration tests against database "${databaseName}". ` +
        'The database name must contain "test". Set TEST_DATABASE_URL accordingly.',
    );
  }
}

beforeAll(async () => {
  const { checkDatabaseHealth } = await import('@/db/client');
  try {
    await checkDatabaseHealth();
  } catch (error) {
    throw new Error(
      `Integration tests need PostgreSQL at ${redactCredentials(databaseUrl)}.\n` +
        'Start it with: docker compose up -d postgres\n' +
        'Then create the test database: ' +
        'docker compose exec postgres createdb -U apron apron_test\n' +
        `Underlying error: ${String(error)}`,
    );
  }
});

afterAll(async () => {
  const { closePool } = await import('@/db/client');
  const { closeRedisConnections } = await import('@/jobs/queues/connection');
  await closeRedisConnections();
  await closePool();
});

function redactCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    parsed.username = parsed.username === '' ? '' : '***';
    return parsed.toString();
  } catch {
    return '(unparseable URL)';
  }
}
