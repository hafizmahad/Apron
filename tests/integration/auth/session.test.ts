import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { auditEvents, providerCompanies, sessions, users } from '@/db/schema';
import { hashPassword, needsRehash, verifyPassword } from '@/auth/password';
import { attemptLogin, changePassword, forceSignOut } from '@/auth/login';
import {
  createSession,
  hashSessionToken,
  pruneExpiredSessions,
  resolveSession,
  revokeAllSessionsForUser,
  revokeSession,
  verifyCsrfToken,
} from '@/auth/session';
import { ensureMigrated, truncateAll } from '../../helpers/database';

/**
 * Authentication against the real database (CLAUDE.md §27, Phase 3 exit criteria).
 *
 * Everything here goes through the real tables. The point is to prove the properties that
 * only show up against a live store: that a token is never recoverable from what is
 * persisted, that revocation is immediate, and that a suspended account cannot keep using
 * a session it already held.
 */

const PASSWORD = 'Correct-Horse-Battery-2026';

interface Fixture {
  readonly userId: string;
  readonly email: string;
  readonly providerCompanyId: string;
}

let fixture: Fixture;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fixture = await buildFixture();
});

describe('password hashing', () => {
  it('produces a verifiable hash that does not contain the password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(hash.startsWith('$argon2id$') || hash.startsWith('$scrypt$')).toBe(true);
    expect(await verifyPassword(hash, PASSWORD)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(hash, 'not-the-password')).toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, PASSWORD)).toBe(true);
    expect(await verifyPassword(second, PASSWORD)).toBe(true);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    for (const malformed of ['', 'not-a-hash', '$argon2id$garbage', '$scrypt$broken']) {
      expect(await verifyPassword(malformed, PASSWORD)).toBe(false);
    }
  });

  it('does not ask for a rehash of a hash it just produced', async () => {
    expect(await needsRehash(await hashPassword(PASSWORD))).toBe(false);
  });

  it('asks for a rehash of a hash from the other algorithm', async () => {
    // The seeded default is argon2id; a scrypt-shaped hash must be flagged for upgrade.
    expect(await needsRehash('$scrypt$N=16384,r=8,p=1$c2FsdA==$aGFzaA==')).toBe(true);
  });
});

describe('sessions', () => {
  it('stores only a hash — the token itself is never persisted', async () => {
    const issued = await createSession(fixture.userId);

    const rows = await getDb()
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.userId, fixture.userId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashSessionToken(issued.token));
    expect(rows[0]?.tokenHash).not.toBe(issued.token);

    // The raw token appears nowhere in the table.
    const scan = await getDb().execute<{ hit: string }>(sql`
      select count(*)::text as hit from sessions where token_hash = ${issued.token}
    `);
    expect(Number(scan.rows[0]?.hit)).toBe(0);
  });

  it('issues tokens with enough entropy to be unguessable', async () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const issued = await createSession(fixture.userId);
      expect(issued.token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
      tokens.add(issued.token);
    }
    expect(tokens.size).toBe(20);
  });

  it('resolves a live token to the right user', async () => {
    const issued = await createSession(fixture.userId);
    const resolved = await resolveSession(issued.token);

    expect(resolved).not.toBeNull();
    expect(resolved?.user.userId).toBe(fixture.userId);
    expect(resolved?.user.email).toBe(fixture.email);
    expect(resolved?.user.providerCompanyId).toBe(fixture.providerCompanyId);
  });

  it('returns null for an unknown, empty or undefined token', async () => {
    expect(await resolveSession(undefined)).toBeNull();
    expect(await resolveSession('')).toBeNull();
    expect(await resolveSession('completely-made-up-token')).toBeNull();
  });

  it('returns null once the session is revoked — revocation is immediate', async () => {
    const issued = await createSession(fixture.userId);
    expect(await resolveSession(issued.token)).not.toBeNull();

    await revokeSession(issued.sessionId);
    expect(await resolveSession(issued.token)).toBeNull();
  });

  it('returns null once the session has expired', async () => {
    const issued = await createSession(fixture.userId);
    // Age the row as real elapsed time would: created in the past, expired since. Moving
    // only expires_at would violate the expires_at > created_at CHECK, which is correct.
    await getDb().execute(sql`
      update sessions
      set created_at = now() - interval '7 days',
          expires_at = now() - interval '1 hour'
      where id = ${issued.sessionId}::uuid
    `);

    expect(await resolveSession(issued.token)).toBeNull();
  });

  it('stops honouring a session as soon as the account is suspended', async () => {
    const issued = await createSession(fixture.userId);
    expect(await resolveSession(issued.token)).not.toBeNull();

    await getDb().update(users).set({ status: 'suspended' }).where(eq(users.id, fixture.userId));

    // No revocation was needed: a non-active account holds no session.
    expect(await resolveSession(issued.token)).toBeNull();
  });

  it('revokes every session for a user at once', async () => {
    const first = await createSession(fixture.userId);
    const second = await createSession(fixture.userId);

    const revoked = await revokeAllSessionsForUser(fixture.userId);
    expect(revoked).toBe(2);
    expect(await resolveSession(first.token)).toBeNull();
    expect(await resolveSession(second.token)).toBeNull();
  });

  it('cascades session deletion when the user is deleted', async () => {
    await createSession(fixture.userId);
    await getDb().delete(users).where(eq(users.id, fixture.userId));

    const remaining = await getDb().select({ id: sessions.id }).from(sessions);
    expect(remaining).toEqual([]);
  });

  it('prunes expired sessions but keeps live ones', async () => {
    const live = await createSession(fixture.userId);
    const stale = await createSession(fixture.userId);

    await getDb().execute(sql`
      update sessions
      set created_at = now() - interval '7 days',
          expires_at = now() - interval '1 day'
      where id = ${stale.sessionId}::uuid
    `);

    const pruned = await pruneExpiredSessions();
    expect(pruned).toBe(1);
    expect(await resolveSession(live.token)).not.toBeNull();
  });
});

describe('CSRF', () => {
  it('accepts the session’s own secret and rejects anything else', async () => {
    const issued = await createSession(fixture.userId);
    const resolved = await resolveSession(issued.token);
    expect(resolved).not.toBeNull();

    const secret = resolved!.csrfSecret;
    expect(verifyCsrfToken(secret, secret)).toBe(true);
    expect(verifyCsrfToken(secret, 'forged')).toBe(false);
    expect(verifyCsrfToken(secret, undefined)).toBe(false);
    expect(verifyCsrfToken(secret, '')).toBe(false);
    expect(verifyCsrfToken(secret, `${secret}x`)).toBe(false);
  });

  it('gives each session a different secret', async () => {
    const first = await createSession(fixture.userId);
    const second = await createSession(fixture.userId);
    expect(first.csrfSecret).not.toBe(second.csrfSecret);
    expect(verifyCsrfToken(first.csrfSecret, second.csrfSecret)).toBe(false);
  });
});

describe('sign-in', () => {
  it('succeeds with correct credentials and writes an audit event', async () => {
    const outcome = await attemptLogin({ email: fixture.email, password: PASSWORD });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;

    const resolved = await resolveSession(outcome.session.token);
    expect(resolved?.user.userId).toBe(fixture.userId);

    const events = await getDb()
      .select({ action: auditEvents.action, actorUserId: auditEvents.actorUserId })
      .from(auditEvents)
      .where(eq(auditEvents.action, 'auth.login'));

    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(fixture.userId);
  });

  it('treats email as case-insensitive', async () => {
    const outcome = await attemptLogin({
      email: fixture.email.toUpperCase(),
      password: PASSWORD,
    });
    expect(outcome.kind).toBe('ok');
  });

  it('fails identically for a wrong password and an unknown address', async () => {
    const wrongPassword = await attemptLogin({ email: fixture.email, password: 'wrong' });
    const unknownEmail = await attemptLogin({
      email: 'nobody@apron.local',
      password: PASSWORD,
    });

    expect(wrongPassword.kind).toBe('invalid_credentials');
    expect(unknownEmail.kind).toBe('invalid_credentials');
    expect(wrongPassword).toEqual(unknownEmail);
  });

  it('refuses a suspended account without revealing that it exists', async () => {
    await getDb().update(users).set({ status: 'suspended' }).where(eq(users.id, fixture.userId));

    const outcome = await attemptLogin({ email: fixture.email, password: PASSWORD });
    expect(outcome.kind).toBe('invalid_credentials');
  });

  it('counts failures and locks the account after the threshold', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await attemptLogin({ email: fixture.email, password: 'wrong' });
    }

    const rows = await getDb()
      .select({ failedLoginCount: users.failedLoginCount, lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, fixture.userId));

    expect(rows[0]?.failedLoginCount).toBe(8);
    expect(rows[0]?.lockedUntil).not.toBeNull();

    // Even the correct password is refused while the lock stands.
    const locked = await attemptLogin({ email: fixture.email, password: PASSWORD });
    expect(locked.kind).toBe('locked');
  });

  it('clears the failure counter on a successful sign-in', async () => {
    await attemptLogin({ email: fixture.email, password: 'wrong' });
    await attemptLogin({ email: fixture.email, password: 'wrong' });
    await attemptLogin({ email: fixture.email, password: PASSWORD });

    const rows = await getDb()
      .select({ failedLoginCount: users.failedLoginCount })
      .from(users)
      .where(eq(users.id, fixture.userId));

    expect(rows[0]?.failedLoginCount).toBe(0);
  });

  it('records the last sign-in time', async () => {
    const before = await getDb()
      .select({ lastLoginAt: users.lastLoginAt })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(before[0]?.lastLoginAt).toBeNull();

    await attemptLogin({ email: fixture.email, password: PASSWORD });

    const after = await getDb()
      .select({ lastLoginAt: users.lastLoginAt })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(after[0]?.lastLoginAt).not.toBeNull();
  });
});

describe('password change', () => {
  it('changes the password and ends every other session', async () => {
    const keep = await createSession(fixture.userId);
    const other = await createSession(fixture.userId);

    const result = await changePassword({
      userId: fixture.userId,
      currentPassword: PASSWORD,
      newPassword: 'A-New-Password-2026!',
      keepSessionId: keep.sessionId,
    });

    expect(result.ok).toBe(true);

    // The acting session survives; every other one is revoked.
    expect(await resolveSession(keep.token)).not.toBeNull();
    expect(await resolveSession(other.token)).toBeNull();

    expect((await attemptLogin({ email: fixture.email, password: PASSWORD })).kind).toBe(
      'invalid_credentials',
    );
    expect(
      (await attemptLogin({ email: fixture.email, password: 'A-New-Password-2026!' })).kind,
    ).toBe('ok');
  });

  it('refuses when the current password is wrong and changes nothing', async () => {
    const session = await createSession(fixture.userId);
    const result = await changePassword({
      userId: fixture.userId,
      currentPassword: 'wrong',
      newPassword: 'Another-Password-2026!',
      keepSessionId: session.sessionId,
    });

    expect(result.ok).toBe(false);
    expect((await attemptLogin({ email: fixture.email, password: PASSWORD })).kind).toBe('ok');
  });
});

describe('forced sign-out', () => {
  it('ends every session for a user', async () => {
    const first = await createSession(fixture.userId);
    const second = await createSession(fixture.userId);

    expect(await forceSignOut(fixture.userId)).toBe(2);
    expect(await resolveSession(first.token)).toBeNull();
    expect(await resolveSession(second.token)).toBeNull();
  });
});

async function buildFixture(): Promise<Fixture> {
  const db = getDb();

  const [company] = await db
    .insert(providerCompanies)
    .values({
      slug: 'auth-fixture-provider',
      legalName: 'Auth Fixture Transport LLC',
      displayName: 'Auth Fixture Transport',
      status: 'approved',
      approvedAt: new Date(),
    })
    .returning({ id: providerCompanies.id });

  if (company === undefined) throw new Error('fixture provider was not created');

  const email = 'dispatch@authfixture.example';
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(PASSWORD),
      fullName: 'Auth Fixture Dispatcher',
      role: 'provider_dispatcher',
      providerCompanyId: company.id,
    })
    .returning({ id: users.id });

  if (user === undefined) throw new Error('fixture user was not created');

  return { userId: user.id, email, providerCompanyId: company.id };
}
