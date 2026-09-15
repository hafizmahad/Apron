import '@/lib/server-guard';
import { getDb, type Executor } from '@/db/client';
import { auditEvents } from '@/db/schema';
import type { UserRole } from '@/db/schema/enums';
import { ApronError } from '@/lib/errors';
import { correlationId } from '@/lib/logging';
import { requiresReason } from '@/domain/permissions';

/**
 * The audit trail (CLAUDE.md §5).
 *
 * Every meaningful write records actor, role, action, entity, before/after and the
 * correlation id that ties it back to the HTTP request or job that caused it.
 *
 * Audit rows are written inside the same transaction as the change they describe. That is
 * the whole point: a committed change with no audit row, or an audit row for a change that
 * rolled back, would both be lies. Passing `executor` is therefore not optional in
 * practice — every caller hands in its transaction.
 */

export interface AuditInput {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorUserId?: string | null;
  readonly actorRole?: UserRole | null;
  /** Email or 'system'/'worker' — readable in the audit explorer without a join. */
  readonly actorLabel?: string;
  readonly beforeState?: unknown;
  readonly afterState?: unknown;
  readonly reason?: string | null;
  readonly ipAddress?: string | null;
}

/**
 * Writes one audit event.
 *
 * The database independently enforces that overrides, cancellations and suspensions carry
 * a reason. This function checks the same rule first so the caller gets a typed domain
 * error naming the action, rather than a raw constraint violation — the constraint stays
 * as the real guarantee (CLAUDE.md §30).
 */
export async function recordAuditEvent(
  input: AuditInput,
  executor: Executor = getDb(),
): Promise<void> {
  const reason = input.reason ?? null;

  if (requiresReason(input.action) && (reason === null || reason.trim().length < 3)) {
    throw new ApronError('reason_required', `The action "${input.action}" requires a reason`, {
      details: { action: input.action },
    });
  }

  await executor.insert(auditEvents).values({
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    actorUserId: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
    actorLabel: input.actorLabel ?? 'system',
    beforeState: input.beforeState === undefined ? null : sanitise(input.beforeState),
    afterState: input.afterState === undefined ? null : sanitise(input.afterState),
    reason,
    correlationId: correlationId(),
    ipAddress: input.ipAddress ?? null,
  });
}

/**
 * Keys never written to the audit trail. The trail is long-lived and widely readable
 * inside the organisation; a password hash or session token in a `before`/`after` blob
 * would outlive the secret itself (CLAUDE.md §23, §27).
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'tokenhash',
  'token_hash',
  'csrfsecret',
  'csrf_secret',
  'sessiontoken',
  'apikey',
  'api_key',
  'secret',
  'authorization',
  'cookie',
  'guesttokenhash',
  'guest_token_hash',
]);

function sanitise(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth limit]';
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitise(item, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : sanitise(item, depth + 1);
  }
  return result;
}

/**
 * Computes a minimal before/after pair, so the trail records what actually changed rather
 * than two copies of an entire row. Unchanged fields are omitted from both sides.
 */
export function diffStates<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const [key, nextValue] of Object.entries(after)) {
    const previousValue = before[key];
    if (!sameValue(previousValue, nextValue)) {
      changedBefore[key] = previousValue;
      changedAfter[key] = nextValue;
    }
  }

  return { before: changedBefore, after: changedAfter };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
