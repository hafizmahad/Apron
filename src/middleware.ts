import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware.
 *
 * Deliberately does NOT authenticate. It has no database access, so any check it made
 * would be a guess about a cookie's validity — and a guess that said "signed in" when the
 * session had been revoked would be worse than no check at all. Authentication and
 * authorisation happen server-side in the layouts and pages, against the real session row
 * (CLAUDE.md §5).
 *
 * What it does do:
 *
 *  - publishes the request path as a header, so a server component can highlight the
 *    active navigation item without becoming a client component;
 *  - propagates or mints a correlation id, so a request can be followed from the edge
 *    through the app and into the audit trail;
 *  - sets the security headers that belong on every response.
 */

export function middleware(request: NextRequest): NextResponse {
  const requestHeaders = new Headers(request.headers);

  requestHeaders.set('x-apron-pathname', request.nextUrl.pathname);

  const correlationId = request.headers.get('x-correlation-id') ?? crypto.randomUUID();
  requestHeaders.set('x-correlation-id', correlationId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('x-correlation-id', correlationId);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own static output and the public asset tree. Matching
     * `/assets/*` would add a header rewrite to every icon request for no benefit.
     */
    '/((?!_next/static|_next/image|favicon.ico|assets/).*)',
  ],
};
