import '@/lib/server-guard';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApronError } from '@/lib/errors';
import { enrichCorrelation, logger } from '@/lib/logging';
import {
  can,
  homePortal,
  isOperations,
  isPlatformAdmin,
  isProviderUser,
  type Actor,
  type Permission,
} from '@/domain/permissions';
import { getEnv } from '@/lib/config/env';
import { resolveSession, verifyCsrfToken, type SessionContext } from './session';

/**
 * Request-scoped authentication and authorisation (CLAUDE.md §5, §27).
 *
 * These are the only functions a route handler, server action or server component should
 * use to learn who is calling. They read the session cookie, resolve it against the
 * database, and enrich the correlation context so every log line and audit row for the
 * rest of the request carries the actor.
 *
 * `requirePermission` is the workhorse: it throws a typed `forbidden` error rather than
 * returning a boolean, so forgetting to check the return value cannot silently authorise
 * an action.
 */

/** The current session, or null. Never throws for an unauthenticated caller. */
export async function getSession(): Promise<SessionContext | null> {
  const env = getEnv();
  const cookieStore = await cookies();
  const token = cookieStore.get(env.SESSION_COOKIE_NAME)?.value;

  const session = await resolveSession(token);
  if (session === null) return null;

  enrichCorrelation({
    actorId: session.user.userId,
    actorRole: session.user.role,
    ...(session.user.providerCompanyId === null
      ? {}
      : { providerCompanyId: session.user.providerCompanyId }),
  });

  return session;
}

/** The current actor, or null. */
export async function getActor(): Promise<Actor | null> {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * The current session, or a typed `unauthenticated` error.
 * Use in route handlers and server actions, where a thrown error becomes a 401.
 */
export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (session === null) {
    throw new ApronError('unauthenticated', 'Sign in to continue');
  }
  return session;
}

export async function requireActor(): Promise<Actor> {
  return (await requireSession()).user;
}

/**
 * The current session, or a redirect to sign-in. Use in server components and layouts,
 * where a thrown error would render an error page instead of sending the user to log in.
 */
export async function requireSessionOrRedirect(returnTo?: string): Promise<SessionContext> {
  const session = await getSession();
  if (session === null) {
    const target =
      returnTo === undefined || returnTo === ''
        ? '/login'
        : `/login?next=${encodeURIComponent(returnTo)}`;
    redirect(target);
  }
  return session;
}

/**
 * Asserts a capability, throwing `forbidden` when it is absent.
 *
 * Every denial is logged with the actor and the permission, because an authorisation
 * failure is either a bug or an attack and both are worth seeing (CLAUDE.md §28, §32
 * Journey G).
 */
export async function requirePermission(permission: Permission): Promise<Actor> {
  const actor = await requireActor();
  if (!can(actor, permission)) {
    logger().warn(
      { actorId: actor.userId, role: actor.role, permission },
      'authorization denied: missing permission',
    );
    throw new ApronError('forbidden', 'You do not have permission to do that', {
      details: { permission },
    });
  }
  return actor;
}

/**
 * Non-throwing permission check, for deciding whether to RENDER a control.
 *
 * This is presentation only. Hiding a button the caller cannot use is courtesy; the
 * server action behind it re-checks the same permission and refuses regardless of what
 * was rendered (CLAUDE.md §5: never authorize solely by route or control visibility).
 */
export async function hasPermission(permission: Permission): Promise<boolean> {
  const actor = await getActor();
  return actor !== null && can(actor, permission);
}

/**
 * Asserts that the actor may act on data owned by `providerCompanyId`.
 *
 * This is the Journey G defence: a provider dispatcher guessing another company's URL or
 * calling an API with another company's id is refused here, server-side, and the attempt
 * is logged.
 */
export function assertProviderScope(actor: Actor, providerCompanyId: string): void {
  if (isPlatformAdmin(actor) || isOperations(actor)) return;

  if (!isProviderUser(actor) || actor.providerCompanyId !== providerCompanyId) {
    logger().warn(
      {
        actorId: actor.userId,
        role: actor.role,
        actorProviderCompanyId: actor.providerCompanyId,
        requestedProviderCompanyId: providerCompanyId,
      },
      'tenant isolation violated: provider scope',
    );
    throw new ApronError('tenant_mismatch', 'That record belongs to another company');
  }
}

/** Asserts that the actor may act on data owned by `clientOrganizationId`. */
export function assertClientScope(actor: Actor, clientOrganizationId: string): void {
  if (isPlatformAdmin(actor) || isOperations(actor)) return;

  if (actor.role !== 'client' || actor.clientOrganizationId !== clientOrganizationId) {
    logger().warn(
      {
        actorId: actor.userId,
        role: actor.role,
        actorClientOrganizationId: actor.clientOrganizationId,
        requestedClientOrganizationId: clientOrganizationId,
      },
      'tenant isolation violated: client scope',
    );
    throw new ApronError('tenant_mismatch', 'That record belongs to another organisation');
  }
}

/**
 * Verifies the CSRF token accompanying a mutation.
 *
 * Every server action and non-GET route handler calls this. `SameSite=Lax` already blocks
 * most cross-site form posts; this closes the remaining cases and costs one comparison.
 */
export async function requireCsrf(submittedToken: string | undefined): Promise<SessionContext> {
  const session = await requireSession();

  if (!verifyCsrfToken(session.csrfSecret, submittedToken)) {
    logger().warn(
      { actorId: session.user.userId, sessionId: session.sessionId },
      'CSRF verification failed',
    );
    throw new ApronError('csrf_failed', 'Your session has expired. Reload the page and try again.');
  }

  return session;
}

/** Reads the CSRF token from a submitted form. */
export function csrfTokenFromForm(form: FormData): string | undefined {
  const value = form.get('csrfToken');
  return typeof value === 'string' ? value : undefined;
}

/** Client IP, honouring the proxy header set in front of the app. */
export async function callerIpAddress(): Promise<string | null> {
  const headerList = await headers();
  const forwarded = headerList.get('x-forwarded-for');
  if (forwarded !== null && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return headerList.get('x-real-ip');
}

export async function callerUserAgent(): Promise<string | null> {
  return (await headers()).get('user-agent');
}

/**
 * Sends an actor to their own portal. Used after sign-in and by each portal layout when
 * someone arrives at a portal that is not theirs — a provider reaching `/admin` is
 * redirected rather than shown an error, because it is far more often a stale bookmark
 * than an attack. The server-side permission checks still refuse the data either way.
 */
export function redirectToHomePortal(actor: Actor): never {
  redirect(homePortal(actor));
}
