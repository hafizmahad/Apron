import { defaultEnv, setEnv } from './env';

/**
 * Eval suite preconditions.
 *
 * Evals run offline by default against the scripted AI adapter, so the suite is part of
 * the ordinary quality gate (CLAUDE.md §26 "Offline test mode must use scripted AI
 * outputs"). Setting AI_ENABLED=true with a real key runs the same cases against OpenAI.
 */
setEnv('NODE_ENV', 'test');
setEnv('APP_ENV', 'ci');
setEnv('QUEUE_ENABLED', 'false');
setEnv('LOG_LEVEL', 'silent');
setEnv('TZ', 'UTC');

defaultEnv('AI_ENABLED', 'false');
defaultEnv('DATABASE_URL', 'postgres://evals:evals@127.0.0.1:1/evals-never-connect');
defaultEnv('REDIS_URL', 'redis://127.0.0.1:1');
defaultEnv('SESSION_SECRET', 'eval-test-session-secret-at-least-32-chars-long');
