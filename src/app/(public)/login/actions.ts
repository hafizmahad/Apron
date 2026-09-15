'use server';

import '@/lib/server-guard';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { attemptLogin } from '@/auth/login';
import { callerIpAddress, callerUserAgent, getSession } from '@/auth/context';
import { revokeSession, sessionCookieOptions } from '@/auth/session';
import { recordAuditEvent } from '@/domain/audit';
import { homePortal } from '@/domain/permissions';
import { getEnv } from '@/lib/config/env';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * Sign-in and sign-out server actions.
 *
 * The form posts here; there is no client-side authentication logic at all. The only
 * state the browser ever holds is an opaque HttpOnly cookie.
 */

const loginSchema = z.object({
  email: z.string().trim().min(3).max(320).email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password').max(1024),
  next: z.string().max(512).optional(),
});

export interface LoginFormState {
  readonly error?: string;
  readonly email?: string;
}

/**
 * Every failure returns the same message. The caller cannot tell an unknown address from
 * a wrong password from a suspended account — `attemptLogin` already equalises the work,
 * and this equalises what is said.
 */
const GENERIC_FAILURE = 'That email and password do not match an active account.';

export async function loginAction(
  _previous: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const correlationId = newCorrelationId();

  const outcome = await withCorrelation({ correlationId, route: 'login' }, async () => {
    const parsed = loginSchema.safeParse({
      email: formData.get('email'),
      password: formData.get('password'),
      next: formData.get('next') ?? undefined,
    });

    if (!parsed.success) {
      const email = typeof formData.get('email') === 'string' ? String(formData.get('email')) : '';
      return { state: { error: GENERIC_FAILURE, email } } as const;
    }

    const ipAddress = await callerIpAddress();
    const userAgent = await callerUserAgent();

    // Rate limited per address and per email, so neither a single client nor a single
    // target account can be hammered (CLAUDE.md §27).
    const limit = await checkRateLimit({
      key: `login:${ipAddress ?? 'unknown'}:${parsed.data.email.toLowerCase()}`,
      limit: 10,
      windowSeconds: 300,
    });

    if (!limit.allowed) {
      return {
        state: {
          error: `Too many sign-in attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
          email: parsed.data.email,
        },
      } as const;
    }

    try {
      const result = await attemptLogin({
        email: parsed.data.email,
        password: parsed.data.password,
        ipAddress,
        userAgent,
      });

      if (result.kind === 'locked') {
        return {
          state: {
            error: 'This account is temporarily locked after repeated failed attempts.',
            email: parsed.data.email,
          },
        } as const;
      }

      if (result.kind === 'invalid_credentials') {
        return { state: { error: GENERIC_FAILURE, email: parsed.data.email } } as const;
      }

      const options = sessionCookieOptions();
      const cookieStore = await cookies();
      cookieStore.set(options.name, result.session.token, {
        httpOnly: options.httpOnly,
        sameSite: options.sameSite,
        secure: options.secure,
        path: options.path,
        maxAge: options.maxAge,
      });

      return { redirectTo: safeNext(parsed.data.next) } as const;
    } catch (error) {
      logError('login action failed', error);
      return {
        state: { error: 'Sign-in is temporarily unavailable. Try again shortly.', email: parsed.data.email },
      } as const;
    }
  });

  if ('redirectTo' in outcome) {
    // `redirect` throws, so it must happen outside the try/catch above or it would be
    // swallowed as a failure.
    redirect(outcome.redirectTo ?? '/');
  }

  return outcome.state;
}

export async function logoutAction(): Promise<never> {
  const correlationId = newCorrelationId();

  await withCorrelation({ correlationId, route: 'logout' }, async () => {
    const session = await getSession();
    if (session !== null) {
      await revokeSession(session.sessionId);
      await recordAuditEvent({
        action: 'auth.logout',
        entityType: 'user',
        entityId: session.user.userId,
        actorUserId: session.user.userId,
        actorRole: session.user.role,
        actorLabel: session.user.email,
      });
    }

    const cookieStore = await cookies();
    cookieStore.delete(getEnv().SESSION_COOKIE_NAME);
  });

  redirect('/login');
}

/**
 * Only same-origin relative paths are honoured as a post-login destination. An absolute
 * URL or a protocol-relative `//evil.example` would turn sign-in into an open redirect.
 */
function safeNext(next: string | undefined): string | undefined {
  if (next === undefined || next.length === 0) return undefined;
  if (!next.startsWith('/')) return undefined;
  if (next.startsWith('//')) return undefined;
  if (next.includes('\\')) return undefined;
  return next;
}

/** Exposed for the login page so it can send an already-signed-in user onward. */
export async function homePortalForCurrentActor(): Promise<string | null> {
  const session = await getSession();
  return session === null ? null : homePortal(session.user);
}
