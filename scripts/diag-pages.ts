import '@/lib/server-guard';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { getEnv } from '@/lib/config/env';

/**
 * Diagnostic: does a page actually render data, or a placeholder?
 *
 * Checks for the phrases that mean "nothing was built here" alongside a crude content
 * signal, so a page that returns 200 while showing an apology is distinguishable from one
 * that returns 200 and shows the product.
 */

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:3001';

const PLACEHOLDER_MARKERS = ['Needs Phase', 'dependsOn', 'ALREADY WORKING'];

const CHECKS: readonly { email: string; paths: readonly string[] }[] = [
  {
    email: 'admin@apron.local',
    paths: [
      '/admin',
      '/admin/requests',
      '/admin/providers',
      '/admin/users',
      '/admin/catalogue',
      '/admin/registry',
      '/admin/settings',
      '/admin/audit',
      '/admin/ai',
      '/admin/notifications',
    ],
  },
  {
    email: 'ops.manager@apron.local',
    paths: [
      '/ops',
      '/ops/requests',
      '/ops/schedule',
      '/ops/exceptions',
      '/ops/providers',
      '/ops/airports',
      '/ops/research',
      '/ops/messages',
      '/ops/notifications',
    ],
  },
  {
    email: 'dispatch@hudsonexec.example',
    paths: [
      '/provider',
      '/provider/queue',
      '/provider/schedule',
      '/provider/resources',
      '/provider/coverage',
      '/provider/team',
      '/provider/messages',
      '/provider/notifications',
    ],
  },
  { email: 'aviation@meridiancapital.example', paths: ['/client'] },
];

let problems = 0;

for (const { email, paths } of CHECKS) {
  const login = await attemptLogin({
    email,
    password: 'Apron!Dev2026',
    ipAddress: null,
    userAgent: 'diag',
  });

  if (login.kind !== 'ok') {
    console.log(`\n${email}: SIGN-IN FAILED (${login.kind})`);
    problems += 1;
    continue;
  }

  const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;
  console.log(`\n${email}`);

  for (const path of paths) {
    const response = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' });
    const html = response.status === 200 ? await response.text() : '';

    const placeholder = PLACEHOLDER_MARKERS.some((marker) => html.includes(marker));
    // Rough content signal: how much text sits inside the <main> region.
    const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? html;
    const textLength = main.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;

    const verdict =
      response.status !== 200
        ? `HTTP ${String(response.status)}`
        : placeholder
          ? 'PLACEHOLDER'
          : textLength < 400
            ? `thin (${String(textLength)} chars)`
            : `ok (${String(textLength)} chars)`;

    if (verdict === 'PLACEHOLDER' || response.status !== 200) problems += 1;
    console.log(`  ${path.padEnd(26)} ${verdict}`);
  }

  await revokeSession(login.session.sessionId);
}

console.log(`\n${problems === 0 ? 'no placeholders or errors' : `${String(problems)} problem(s)`}`);
process.exit(0);
