/**
 * Typed domain errors (CLAUDE.md §33: "Use typed domain errors", "No silent catches").
 *
 * Every error carries a stable machine-readable `code` used by route handlers to choose
 * an HTTP status, by the UI to render a specific message, and by the observability layer
 * to aggregate failures. Nothing here contains secrets; `details` is safe to serialise.
 */

export type ApronErrorCode =
  // configuration / infrastructure
  | 'internal'
  | 'config_invalid'
  | 'database_unavailable'
  | 'queue_unavailable'
  // authentication / authorization
  | 'unauthenticated'
  | 'forbidden'
  | 'tenant_mismatch'
  | 'csrf_failed'
  | 'rate_limited'
  // validation
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  // domain
  | 'invalid_transition'
  | 'resource_conflict'
  | 'ambiguous_resolution'
  | 'unresolvable_reference'
  | 'ambiguous_local_time'
  | 'nonexistent_local_time'
  | 'no_eligible_provider'
  | 'offer_expired'
  | 'reason_required'
  // ai
  | 'ai_disabled'
  | 'ai_unavailable'
  | 'ai_schema_invalid'
  | 'ai_verification_failed'
  | 'ai_refused';

const STATUS_BY_CODE: Record<ApronErrorCode, number> = {
  internal: 500,
  config_invalid: 500,
  database_unavailable: 503,
  queue_unavailable: 503,

  unauthenticated: 401,
  forbidden: 403,
  tenant_mismatch: 403,
  csrf_failed: 403,
  rate_limited: 429,

  validation_failed: 422,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,

  invalid_transition: 409,
  resource_conflict: 409,
  ambiguous_resolution: 409,
  unresolvable_reference: 422,
  ambiguous_local_time: 409,
  nonexistent_local_time: 409,
  no_eligible_provider: 409,
  offer_expired: 409,
  reason_required: 422,

  ai_disabled: 503,
  ai_unavailable: 503,
  ai_schema_invalid: 502,
  ai_verification_failed: 502,
  ai_refused: 502,
};

export type ErrorDetails = Readonly<Record<string, unknown>>;

export class ApronError extends Error {
  readonly code: ApronErrorCode;
  readonly status: number;
  readonly details: ErrorDetails;
  /** Safe to show to an end user as-is. Internal detail stays in `message`. */
  readonly publicMessage: string;

  constructor(
    code: ApronErrorCode,
    message: string,
    options?: { details?: ErrorDetails; publicMessage?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApronError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options?.details ?? {};
    this.publicMessage = options?.publicMessage ?? message;
  }

  toJSON(): { code: ApronErrorCode; message: string; details: ErrorDetails } {
    return { code: this.code, message: this.publicMessage, details: this.details };
  }
}

export function isApronError(value: unknown): value is ApronError {
  return value instanceof ApronError;
}

export const errors = {
  unauthenticated: (message = 'Sign in to continue.') => new ApronError('unauthenticated', message),

  forbidden: (message = 'You do not have permission to do that.', details?: ErrorDetails) =>
    new ApronError('forbidden', message, details === undefined ? undefined : { details }),

  tenantMismatch: (details?: ErrorDetails) =>
    new ApronError('tenant_mismatch', 'This record belongs to another organisation.', {
      ...(details === undefined ? {} : { details }),
      publicMessage: 'Not found.',
    }),

  notFound: (entity: string, id?: string) =>
    new ApronError('not_found', `${entity} not found`, {
      details: id === undefined ? { entity } : { entity, id },
      publicMessage: `${entity} not found.`,
    }),

  validation: (message: string, details?: ErrorDetails) =>
    new ApronError('validation_failed', message, details === undefined ? undefined : { details }),

  conflict: (message: string, details?: ErrorDetails) =>
    new ApronError('conflict', message, details === undefined ? undefined : { details }),

  invalidTransition: (from: string, event: string, entity: string) =>
    new ApronError(
      'invalid_transition',
      `${entity} cannot handle "${event}" while in "${from}"`,
      { details: { entity, from, event } },
    ),

  resourceConflict: (details: ErrorDetails) =>
    new ApronError(
      'resource_conflict',
      'That resource is already committed to an overlapping assignment.',
      { details },
    ),

  reasonRequired: (action: string) =>
    new ApronError('reason_required', `A reason is required to ${action}.`, {
      details: { action },
    }),

  rateLimited: (retryAfterSeconds: number) =>
    new ApronError('rate_limited', 'Too many requests. Try again shortly.', {
      details: { retryAfterSeconds },
    }),

  aiDisabled: () =>
    new ApronError('ai_disabled', 'AI assistance is disabled for this environment.'),

  aiUnavailable: (stage: string, cause?: unknown) =>
    new ApronError('ai_unavailable', `AI stage "${stage}" is unavailable.`, {
      details: { stage },
      ...(cause === undefined ? {} : { cause }),
    }),

  aiSchemaInvalid: (stage: string, issues: readonly string[]) =>
    new ApronError('ai_schema_invalid', `AI stage "${stage}" returned an invalid payload.`, {
      details: { stage, issues },
    }),
} as const;

/** Normalises any thrown value into an ApronError without swallowing the original. */
export function toApronError(value: unknown, fallbackMessage = 'Unexpected error'): ApronError {
  if (isApronError(value)) return value;
  if (value instanceof Error) {
    return new ApronError('internal', value.message || fallbackMessage, {
      cause: value,
      publicMessage: fallbackMessage,
    });
  }
  return new ApronError('internal', fallbackMessage, { details: { thrown: String(value) } });
}

/**
 * The Postgres `SQLSTATE` a failure carries, following the `cause` chain to find it.
 *
 * Drizzle wraps driver errors, so the `code` the database set is not always on the error
 * that reaches a catch block — it can sit one or more `cause` links down. Reading only the
 * top-level property silently stopped recognising constraint violations when the ORM
 * changed how it reports them, which turned a handled `resource_conflict` into an
 * unhandled failure. Walking the chain is version-independent: it finds the code whether
 * the driver error is thrown directly or wrapped.
 */
export function sqlState(error: unknown): string | null {
  return findOnCauseChain(error, 'code');
}

/** The constraint a failure names, following the `cause` chain. See {@link sqlState}. */
export function violatedConstraint(error: unknown): string | null {
  return findOnCauseChain(error, 'constraint');
}

/**
 * The message the database itself produced, from the deepest link of the `cause` chain.
 *
 * Drizzle prefixes what it throws with `Failed query: ...`, so the text a check constraint
 * or a trigger actually raised — the part that says *why* — is no longer the top-level
 * message. This reaches past the wrapper to it.
 */
export function databaseMessage(error: unknown): string {
  let current: unknown = error;
  let deepest = '';

  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) break;
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') deepest = message;
    current = (current as { cause?: unknown }).cause;
  }

  return deepest === '' ? String(error) : deepest;
}

/** Bounded so a self-referential `cause` cannot spin. */
function findOnCauseChain(error: unknown, property: 'code' | 'constraint'): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const value = (current as Record<string, unknown>)[property];
    if (typeof value === 'string') return value;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
