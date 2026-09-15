import '@/lib/server-guard';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { getEnv } from '@/lib/config/env';

/** Diagnostic: does the client portal actually render the six service cards with images? */

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:53000';

const login = await attemptLogin({
  email: 'aviation@meridiancapital.example',
  password: 'Apron!Dev2026',
  ipAddress: null,
  userAgent: 'diag',
});

if (login.kind !== 'ok') {
  console.error('sign-in failed:', login.kind);
  process.exit(1);
}

const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;
const response = await fetch(`${BASE}/client`, { headers: { cookie }, redirect: 'manual' });
const html = response.status === 200 ? await response.text() : '';

console.log(`/client  HTTP ${String(response.status)}\n`);

const images = [...html.matchAll(/06_service_images\/([a-z-]+)\.webp/g)]
  .map((m) => m[1])
  .filter((name): name is string => name !== undefined);
console.log('service images referenced:', [...new Set(images)].sort().join(', ') || '(none)');

const expected = ['catering', 'close-protection', 'fuel', 'ground-transport', 'hangar', 'hotel'];
const missing = expected.filter((name) => !images.includes(name));
console.log('missing:', missing.length === 0 ? '(none)' : missing.join(', '));

console.log('\nsection present:', html.includes('What we can arrange'));
console.log('card markup (article/group):', html.includes('group flex h-full flex-col'));
console.log('hover scale on image:', html.includes('group-hover:scale-'));

// Each image must actually be fetchable.
for (const name of [...new Set(images)].sort()) {
  // `connection: close` on purpose: keep-alive sockets left open by these six fetches are
  // what a forced exit was racing against below.
  const asset = await fetch(`${BASE}/assets/apron/06_service_images/${name}.webp`, {
    headers: { connection: 'close' },
  });
  console.log(`  ${name.padEnd(18)} HTTP ${String(asset.status)}`);
}

await revokeSession(login.session.sessionId);

/**
 * Exit by letting the loop drain, not by forcing it.
 *
 * `process.exit()` here aborted with `!(handle->flags & UV_HANDLE_CLOSING)` on Windows —
 * a crash AFTER every check had already passed, which reads as a product failure and is
 * not one. The sockets it was racing are closed at the source above; this just declares
 * success and lets Node finish. The timer is a backstop for a handle that outlives its
 * welcome, and is unref'd so it cannot be the thing keeping the process alive.
 */
process.exitCode = 0;
setTimeout(() => process.exit(0), 5_000).unref();
