import '@/lib/server-guard';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';
import { getEnv } from '@/lib/config/env';
import { isApronError } from '@/lib/errors';

/**
 * Structured logging with correlation IDs (CLAUDE.md §28).
 *
 * Every inbound request, server action and queue job runs inside a correlation context so
 * a single `correlationId` ties together the HTTP entry, the domain decisions, the AI
 * calls and the audit rows it produced.
 *
 * Redaction is configured centrally: no secret, token, cookie or password may reach a log
 * sink (§23 "Do not store secrets in logs").
 */

export interface CorrelationContext {
  readonly correlationId: string;
  readonly actorId?: string;
  readonly actorRole?: string;
  readonly providerCompanyId?: string;
  readonly requestId?: string;
  readonly route?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

const REDACTED_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'sessionToken',
  '*.sessionToken',
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'headers.authorization',
  'headers.cookie',
  'OPENAI_API_KEY',
  'SESSION_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'SMTP_PASSWORD',
];

let rootLogger: Logger | undefined;

function createRootLogger(): Logger {
  const env = getEnv();
  const base = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: { app: 'apron', env: env.APP_ENV },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  } as const;

  if (env.LOG_PRETTY) {
    // `pino-pretty` is a devDependency: it is a developer convenience, not something a
    // production image carries. Asking pino for it when the package is absent throws
    // "unable to determine transport target", and because `logger()` runs at the head of
    // every server action and job, that turned a log-formatting preference into a broken
    // application — the Docker image inherited LOG_PRETTY=true from .env and failed there
    // while working perfectly on a developer's machine.
    //
    // Structured JSON on stdout is the correct production behaviour anyway, so the absence
    // of the pretty printer degrades to it rather than taking the process down.
    try {
      return pino({
        ...base,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,app,env',
          },
        },
      });
    } catch {
      const plain = pino(base);
      plain.warn(
        'LOG_PRETTY is set but pino-pretty is not installed — falling back to JSON logs',
      );
      return plain;
    }
  }
  return pino(base);
}

/** The process-wide logger, enriched with the active correlation context. */
export function logger(): Logger {
  rootLogger ??= createRootLogger();
  const context = storage.getStore();
  return context === undefined ? rootLogger : rootLogger.child({ ...context });
}

export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

export function correlationId(): string {
  return storage.getStore()?.correlationId ?? 'uncorrelated';
}

export function newCorrelationId(): string {
  return randomUUID();
}

/** Runs `fn` inside a correlation context, creating an id when none is supplied. */
export function withCorrelation<T>(
  context: Partial<CorrelationContext> & { correlationId?: string },
  fn: () => T,
): T {
  const parent = storage.getStore();
  const merged: CorrelationContext = {
    ...parent,
    ...stripUndefined(context),
    correlationId: context.correlationId ?? parent?.correlationId ?? newCorrelationId(),
  };
  return storage.run(merged, fn);
}

/** Adds fields to the *current* context for the remainder of the async scope. */
export function enrichCorrelation(fields: Partial<Omit<CorrelationContext, 'correlationId'>>): void {
  const current = storage.getStore();
  if (current === undefined) return;
  Object.assign(current as unknown as Record<string, unknown>, stripUndefined(fields));
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result as Partial<T>;
}

/**
 * Logs a thrown value with its typed error code where available. Never swallows:
 * callers still decide whether to rethrow (CLAUDE.md §33 "no silent catches").
 */
export function logError(message: string, error: unknown, extra: Record<string, unknown> = {}): void {
  const fields: Record<string, unknown> = { ...extra };
  if (isApronError(error)) {
    fields['errorCode'] = error.code;
    fields['errorDetails'] = error.details;
  }
  logger().error({ ...fields, err: error }, message);
}

/** Test seam: drops the memoised logger so a new LOG_LEVEL takes effect. */
export function resetLoggerForTests(): void {
  rootLogger = undefined;
}
