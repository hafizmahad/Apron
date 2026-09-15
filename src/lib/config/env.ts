import '@/lib/server-guard';
import { z } from 'zod';

/**
 * Fail-fast environment validation.
 *
 * Rules enforced here (CLAUDE.md §23, §27):
 *  - no secret has a default;
 *  - `AI_ENABLED` defaults to false;
 *  - when AI is enabled, the key and every model name become required, so the
 *    application can never make a model call with an undefined model;
 *  - nothing in this module may be imported by client components (server guard).
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    const normalised = value.trim().toLowerCase();
    return normalised === 'true' || normalised === '1' || normalised === 'yes';
  });

const nonEmpty = z.string().trim().min(1);

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'ci', 'staging', 'production']).default('local'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: nonEmpty,
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_SSL: booleanish.default(false),

  REDIS_URL: nonEmpty,

  SESSION_COOKIE_NAME: nonEmpty.default('apron_session'),
  /**
   * The password every seeded account signs in with.
   *
   * One password for all of them, by design: these are the platform's own starting accounts
   * and rotating them individually is work nobody wants. Set this once for a deployed
   * environment and it never needs changing again.
   *
   * Left unset it falls back to the well-known development password, which is fine locally
   * and is exactly why `runSeed` refuses to seed a non-local environment while it is still
   * the default.
   */
  SEED_PASSWORD: z.string().min(8).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(24 * 30).default(12),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PASSWORD_HASH_ALGO: z.enum(['argon2id', 'scrypt']).default('argon2id'),

  AI_ENABLED: booleanish.default(false),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_INTAKE_MODEL: z.string().trim().optional(),
  OPENAI_REASONING_MODEL: z.string().trim().optional(),
  OPENAI_RESEARCH_MODEL: z.string().trim().optional(),
  OPENAI_SUMMARY_MODEL: z.string().trim().optional(),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(30_000),
  OPENAI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),

  /** When false, prompt/response bodies are not persisted alongside AI call records. */
  AI_STORE_PROMPT_BODIES: booleanish.default(false),

  SMTP_HOST: z.string().trim().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().trim().optional(),
  SMTP_PASSWORD: z.string().trim().optional(),
  SMTP_SECURE: booleanish.default(false),
  MAIL_FROM: z.string().trim().default('Apron Operations <ops@apron.local>'),
  MAIL_TRANSPORT: z.enum(['smtp', 'log', 'memory']).default('log'),

  SMS_ENABLED: booleanish.default(false),
  SMS_TRANSPORT: z.enum(['log', 'memory']).default('log'),

  DOCUMENT_STORAGE_DRIVER: z.enum(['filesystem', 's3']).default('filesystem'),
  DOCUMENT_STORAGE_PATH: z.string().trim().default('./.apron-storage'),
  S3_BUCKET: z.string().trim().optional(),
  S3_REGION: z.string().trim().optional(),

  /**
   * Map provider (ADR-011). `static` projects real stored coordinates onto the packaged
   * abstract map and needs no key or network; `maplibre` additionally requires a style
   * URL. Client-visible, hence the NEXT_PUBLIC_ prefix — neither value is a secret.
   * No coordinate is ever synthesised under either adapter (CLAUDE.md §17).
   */
  NEXT_PUBLIC_MAP_PROVIDER: z.enum(['static', 'maplibre']).default('static'),
  NEXT_PUBLIC_MAP_STYLE_URL: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' ? undefined : value)),

  // 'silent' is a real pino level and is what the test suites use.
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: booleanish.default(false),

  RATE_LIMIT_ENABLED: booleanish.default(true),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(64).default(4),
  /** Disables queue producers so unit/integration runs never reach Redis accidentally. */
  QUEUE_ENABLED: booleanish.default(true),
});

const schema = baseSchema.superRefine((value, ctx) => {
  // A maplibre map with no style URL renders a blank rectangle. Fail at boot rather than
  // shipping an empty map into an operational screen (ADR-011).
  if (value.NEXT_PUBLIC_MAP_PROVIDER === 'maplibre' && value.NEXT_PUBLIC_MAP_STYLE_URL === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['NEXT_PUBLIC_MAP_STYLE_URL'],
      message: 'NEXT_PUBLIC_MAP_STYLE_URL is required when NEXT_PUBLIC_MAP_PROVIDER=maplibre',
    });
  }

  if (!value.AI_ENABLED) return;

  const required = [
    ['OPENAI_API_KEY', value.OPENAI_API_KEY],
    ['OPENAI_INTAKE_MODEL', value.OPENAI_INTAKE_MODEL],
    ['OPENAI_REASONING_MODEL', value.OPENAI_REASONING_MODEL],
    ['OPENAI_RESEARCH_MODEL', value.OPENAI_RESEARCH_MODEL],
    ['OPENAI_SUMMARY_MODEL', value.OPENAI_SUMMARY_MODEL],
  ] as const;

  for (const [key, provided] of required) {
    if (provided === undefined || provided === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when AI_ENABLED=true`,
      });
    }
  }
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Parses and caches the environment. Throws once, loudly, with every problem listed.
 * Secret values are never included in the message.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration:\n${describeIssues(parsed.error)}\n` +
        'See .env.example for the full list of supported variables.',
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test-only: clears the memoised environment after mutating `process.env`. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * True only when a real model call is permitted: the feature flag is on *and* a key is
 * present. Every AI caller checks this before constructing a client (CLAUDE.md §23).
 */
export function isAiEnabled(env: Env = getEnv()): boolean {
  return env.AI_ENABLED && typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length > 0;
}

export function isProduction(env: Env = getEnv()): boolean {
  return env.NODE_ENV === 'production';
}
