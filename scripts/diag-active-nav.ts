import '@/lib/server-guard';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { getEnv } from '@/lib/config/env';

/** Diagnostic: which nav item does a given page mark as current? */

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:3001';

const login = await attemptLogin({
  email: 'admin@apron.local',
  password: 'Apron!Dev2026',
  ipAddress: null,
  userAgent: 'diag',
});

if (login.kind !== 'ok') {
  console.error('sign-in failed', login);
  process.exit(1);
}

const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;

for (const path of ['/admin', '/admin/requests', '/admin/users', '/admin/settings']) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const html = await response.text();

  const current = [...html.matchAll(/href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);
  const currentAlt = [...html.matchAll(/aria-current="page"[^>]*href="([^"]+)"/g)].map((m) => m[1]);

  console.log(
    `${path.padEnd(20)} HTTP ${String(response.status)}  aria-current -> ${
      [...current, ...currentAlt].join(', ') || 'NONE'
    }`,
  );
}

await revokeSession(login.session.sessionId);
process.exit(0);
