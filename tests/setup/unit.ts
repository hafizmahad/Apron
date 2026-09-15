import { defaultEnv, setEnv } from './env';

/**
 * Unit suite preconditions: hermetic.
 *
 * A deterministic, complete environment is injected so `getEnv()` succeeds without a
 * `.env` file and without ever pointing at a real service. Unit tests must not open a
 * socket; the DATABASE_URL and REDIS_URL below exist only to satisfy validation and
 * point at a closed port so an accidental connection attempt fails instantly and loudly.
 */
setEnv('NODE_ENV', 'test');
setEnv('APP_ENV', 'ci');
setEnv('AI_ENABLED', 'false');
setEnv('QUEUE_ENABLED', 'false');
setEnv('LOG_LEVEL', 'silent');
setEnv('LOG_PRETTY', 'false');
setEnv('TZ', 'UTC');

defaultEnv('DATABASE_URL', 'postgres://unit:unit@127.0.0.1:1/unit-tests-never-connect');
defaultEnv('REDIS_URL', 'redis://127.0.0.1:1');
defaultEnv('SESSION_SECRET', 'unit-test-session-secret-at-least-32-chars-long');
