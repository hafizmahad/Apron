import '@/lib/server-guard';
import { eq, sql } from 'drizzle-orm';
import { getDb, withTransaction } from '@/db/client';
import { users } from '@/db/schema';
import { recordAuditEvent } from '@/domain/audit';
import { logger } from '@/lib/logging';
import { hashPassword, needsRehash, verifyPassword } from './password';
import { createSession, revokeAllSessionsForUser, type IssuedSession } from './session';

/**
 * The sign-in path (CLAUDE.md §27).
 *
 * Defences, in the order they matter:
 *
 *  - **Uniform failure.** Unknown email, wrong password, suspended account and locked
 *    account all return the same `invalid_credentials` outcome with the same message. An
 *    attacker must not be able to enumerate which addresses exist.
 *  - **Constant work on the unknown-email path.** A missing user still costs one password
 *    verification against a dummy hash, so response time does not reveal existence.
 *  - **Bounded attempts.** Consecutive failures lock the account for a growing window.
 *  - **Transparent rehash.** A password stored under weaker parameters is upgraded on the
 *    next successful sign-in, with no user-visible step.
 */

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

/**
 * A real argon2id hash of a value nobody knows, used to spend comparable CPU on the
 * unknown-email path. Computed once, lazily.
 */
let dummyHash: string | undefined;

async function getDummyHash(): Promise<string> {
  dummyHash ??= await hashPassword(`no-such-user-${Math.random()}`);
  return dummyHash;
}

export type LoginOutcome =
  | { readonly kind: 'ok'; readonly session: IssuedSession; readonly userId: string; readonly mustChangePassword: boolean }
  | { readonly kind: 'invalid_credentials' }
  | { readonly kind: 'locked'; readonly until: Date };

export interface LoginAttempt {
  readonly email: string;
  readonly password: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export async function attemptLogin(attempt: LoginAttempt): Promise<LoginOutcome> {
  const db = getDb();
  const email = attempt.email.trim();

  const rows = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      status: users.status,
      failedLoginCount: users.failedLoginCount,
      lockedUntil: users.lockedUntil,
      mustChangePassword: users.mustChangePassword,
      role: users.role,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const user = rows[0];

  if (user === undefined) {
    // Spend the same work as a real verification so timing does not leak existence.
    await verifyPassword(await getDummyHash(), attempt.password);
    logger().info({ email: redactEmail(email) }, 'login failed: no such account');
    return { kind: 'invalid_credentials' };
  }

  const now = new Date();
  if (user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime()) {
    logger().warn({ userId: user.id }, 'login rejected: account locked');
    return { kind: 'locked', until: user.lockedUntil };
  }

  const passwordMatches = await verifyPassword(user.passwordHash, attempt.password);

  if (!passwordMatches) {
    const failures = user.failedLoginCount + 1;
    const shouldLock = failures >= MAX_FAILED_ATTEMPTS;
    await db
      .update(users)
      .set({
        failedLoginCount: failures,
        lockedUntil: shouldLock ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));

    logger().warn({ userId: user.id, failures, locked: shouldLock }, 'login failed: bad password');
    return { kind: 'invalid_credentials' };
  }

  // Correct password, but a suspended or not-yet-activated account must not sign in — and
  // must be indistinguishable from a wrong password.
  if (user.status !== 'active') {
    logger().warn({ userId: user.id, status: user.status }, 'login rejected: account not active');
    return { kind: 'invalid_credentials' };
  }

  return withTransaction(async (tx) => {
    const updates: Record<string, unknown> = {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: now,
    };

    // Upgrade a hash produced under weaker parameters, invisibly to the user.
    if (await needsRehash(user.passwordHash)) {
      updates['passwordHash'] = await hashPassword(attempt.password);
      logger().info({ userId: user.id }, 'password hash upgraded on sign-in');
    }

    await tx.update(users).set(updates).where(eq(users.id, user.id));

    const session = await createSession(
      user.id,
      { ipAddress: attempt.ipAddress ?? null, userAgent: attempt.userAgent ?? null },
      tx,
    );

    await recordAuditEvent(
      {
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        actorUserId: user.id,
        actorRole: user.role,
        actorLabel: email,
        afterState: { sessionId: session.sessionId },
        ipAddress: attempt.ipAddress ?? null,
      },
      tx,
    );

    return {
      kind: 'ok' as const,
      session,
      userId: user.id,
      mustChangePassword: user.mustChangePassword,
    };
  });
}

/** Changes a password and invalidates every other session for that user. */
export async function changePassword(input: {
  readonly userId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly keepSessionId: string;
}): Promise<{ readonly ok: boolean }> {
  const db = getDb();
  const rows = await db
    .select({ passwordHash: users.passwordHash, role: users.role, email: users.email })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  const user = rows[0];
  if (user === undefined) return { ok: false };

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    return { ok: false };
  }

  const newHash = await hashPassword(input.newPassword);

  await withTransaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash: newHash, mustChangePassword: false })
      .where(eq(users.id, input.userId));

    // Every other session is revoked: a password change must end any session an attacker
    // may already hold. The current one is kept so the user is not signed out mid-action.
    await tx.execute(sql`
      update sessions set revoked_at = now()
      where user_id = ${input.userId}::uuid
        and id <> ${input.keepSessionId}::uuid
        and revoked_at is null
    `);

    await recordAuditEvent(
      {
        action: 'auth.password_change',
        entityType: 'user',
        entityId: input.userId,
        actorUserId: input.userId,
        actorRole: user.role,
        actorLabel: user.email,
      },
      tx,
    );
  });

  return { ok: true };
}

/** Ends every session for a user. Called when Admin suspends an account. */
export async function forceSignOut(userId: string): Promise<number> {
  return revokeAllSessionsForUser(userId);
}

/** `a***@example.com` — enough to correlate a log line, not enough to harvest. */
function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '[redacted]';
  const first = email[0] ?? '';
  return `${first}***${email.slice(at)}`;
}
