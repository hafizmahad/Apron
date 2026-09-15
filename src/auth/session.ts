import '@/lib/server-guard';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb, type Executor } from '@/db/client';
import { sessions, users, type User } from '@/db/schema';
import { getEnv } from '@/lib/config/env';
import { ApronError } from '@/lib/errors';
import type { Actor } from '@/domain/permissions';

/**
 * Server-side opaque sessions (ADR-006, CLAUDE.md §27).
 *
 * The cookie carries 32 random bytes, base64url-encoded. Only the SHA-256 hash is stored,
 * so a database disclosure does not hand an attacker live sessions. There is no JWT and
 * no self-contained token, which means revocation is immediate and unconditional: delete
 * or revoke the row and the next request is unauthenticated.
 *
 * SHA-256 rather than argon2 here is deliberate and not a weakening: the token is 256 bits
 * of CSPRNG output, not a human-chosen password, so it has no guessable structure to
 * protect against offline search. What matters is that the stored value cannot be replayed.
 */

const TOKEN_BYTES = 32;
const CSRF_BYTES = 32;

export interface SessionUser extends Actor {
  readonly email: string;
  readonly fullName: string;
  readonly mustChangePassword: boolean;
}

export interface IssuedSession {
  /** The value to put in the cookie. Never stored, never logged. */
  readonly token: string;
  readonly csrfSecret: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export interface SessionContext {
  readonly sessionId: string;
  readonly user: SessionUser;
  readonly csrfSecret: string;
  readonly expiresAt: Date;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Issues a session for an already-authenticated user. */
export async function createSession(
  userId: string,
  metadata: { readonly ipAddress?: string | null; readonly userAgent?: string | null } = {},
  executor: Executor = getDb(),
): Promise<IssuedSession> {
  const env = getEnv();
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const csrfSecret = randomBytes(CSRF_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);

  const [row] = await executor
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashSessionToken(token),
      csrfSecret,
      expiresAt,
      ipAddress: metadata.ipAddress ?? null,
      userAgent: metadata.userAgent ?? null,
    })
    .returning({ id: sessions.id });

  if (row === undefined) {
    throw new ApronError('internal', 'Session could not be created');
  }

  return { token, csrfSecret, sessionId: row.id, expiresAt };
}

/**
 * Resolves a cookie value to a live session, or null.
 *
 * Returns null — never throws — for every "not signed in" case: absent token, unknown
 * token, expired, revoked, or a user who has since been suspended or deleted. The caller
 * cannot distinguish them, which is the point.
 */
export async function resolveSession(
  token: string | undefined,
  executor: Executor = getDb(),
): Promise<SessionContext | null> {
  if (token === undefined || token.length === 0) return null;

  const tokenHash = hashSessionToken(token);
  const now = new Date();

  const rows = await executor
    .select({
      sessionId: sessions.id,
      csrfSecret: sessions.csrfSecret,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;

  // A suspended or invited account holds no session, even if the row is still live.
  if (row.user.status !== 'active') return null;

  return {
    sessionId: row.sessionId,
    csrfSecret: row.csrfSecret,
    expiresAt: row.expiresAt,
    user: toSessionUser(row.user),
  };
}

/** Records activity so an idle-timeout policy has something to read. Best effort. */
export async function touchSession(sessionId: string, executor: Executor = getDb()): Promise<void> {
  await executor
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

export async function revokeSession(
  sessionId: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Revokes every live session for a user — used on password change and on suspension. */
export async function revokeAllSessionsForUser(
  userId: string,
  executor: Executor = getDb(),
): Promise<number> {
  const revoked = await executor
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length;
}

/**
 * Deletes sessions that are expired or were revoked more than a day ago. Run from the
 * worker; keeping recently-revoked rows briefly makes "you were signed out" diagnosable.
 */
export async function pruneExpiredSessions(executor: Executor = getDb()): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3_600_000);
  const deleted = await executor
    .delete(sessions)
    .where(
      or(
        lt(sessions.expiresAt, new Date()),
        and(sql`${sessions.revokedAt} is not null`, lt(sessions.revokedAt, cutoff)),
      ),
    )
    .returning({ id: sessions.id });
  return deleted.length;
}

function toSessionUser(user: User): SessionUser {
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    providerCompanyId: user.providerCompanyId,
    clientOrganizationId: user.clientOrganizationId,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
  };
}

// ---------------------------------------------------------------------------
// CSRF
//
// Double-submit with a per-session secret (CLAUDE.md §27). The secret lives only in the
// session row — never in a readable cookie — and the token sent with a form is compared
// against it in constant time. `SameSite=Lax` on the session cookie is the first line of
// defence; this is the second, because Lax alone does not cover every navigation case.
// ---------------------------------------------------------------------------

export function issueCsrfToken(csrfSecret: string): string {
  return csrfSecret;
}

export function verifyCsrfToken(csrfSecret: string, submitted: string | undefined): boolean {
  if (submitted === undefined || submitted.length === 0) return false;

  const expected = Buffer.from(csrfSecret, 'utf8');
  const actual = Buffer.from(submitted, 'utf8');
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// cookie shape
// ---------------------------------------------------------------------------

export interface SessionCookieOptions {
  readonly name: string;
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly path: '/';
  readonly maxAge: number;
}

export function sessionCookieOptions(): SessionCookieOptions {
  const env = getEnv();
  return {
    name: env.SESSION_COOKIE_NAME,
    httpOnly: true,
    sameSite: 'lax',
    // Secure everywhere except plain-HTTP local development, where it would stop the
    // cookie being set at all.
    secure: env.APP_ENV !== 'local',
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 3600,
  };
}
