import '@/lib/server-guard';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { getEnv } from '@/lib/config/env';

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:3001';

/** The pages the content check called "thin" — verify each says WHY it is empty. */
const THIN: readonly { email: string; path: string }[] = [
  { email: 'admin@apron.local', path: '/admin/notifications' },
  { email: 'ops.manager@apron.local', path: '/ops/schedule' },
  { email: 'ops.manager@apron.local', path: '/ops/messages' },
  { email: 'dispatch@hudsonexec.example', path: '/provider/queue' },
  { email: 'dispatch@hudsonexec.example', path: '/provider/schedule' },
  { email: 'dispatch@hudsonexec.example', path: '/provider/messages' },
  { email: 'dispatch@hudsonexec.example', path: '/provider/notifications' },
];

for (const { email, path } of THIN) {
  const login = await attemptLogin({ email, password: 'Apron!Dev2026', ipAddress: null, userAgent: 'diag' });
  if (login.kind !== 'ok') {
    console.log(`${path.padEnd(26)} SIGN-IN FAILED`);
    continue;
  }

  const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;
  const html = await (await fetch(`${BASE}${path}`, { headers: { cookie } })).text();

  const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? html;
  const text = main.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

  console.log(`\n${path}`);
  console.log(`  ${text.slice(0, 240)}`);

  await revokeSession(login.session.sessionId);
}

process.exitCode = 0;
setTimeout(() => process.exit(0), 5_000).unref();
