import '@/lib/server-guard';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { getEnv } from '@/lib/config/env';

/**
 * Diagnostic: spot-checks the UI refinements against the running build.
 *
 * Asserts on rendered HTML rather than on source, so it catches a change that compiles but
 * never reaches the page.
 */

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:3001';

interface Check {
  readonly email: string;
  readonly path: string;
  /** Substrings that MUST be present. */
  readonly expect: readonly string[];
  /** Substrings that must NOT be present. */
  readonly forbid?: readonly string[];
}

const CHECKS: readonly Check[] = [
  {
    email: 'admin@apron.local',
    path: '/admin/settings',
    expect: [
      'Maximum rematch attempts',
      'Acknowledgement window',
      'Same-provider consolidation bonus',
      'AI provider selection',
      'Research assistant',
      // The key stays visible as secondary information.
      'matching.max_rematch_attempts',
      // Grouped by area.
      'Matching',
      'Acknowledgement SLA',
    ],
  },
  {
    email: 'admin@apron.local',
    path: '/admin',
    // The monogram replaced the static avatar images.
    expect: ['rounded-full'],
    forbid: ['avatar-initials', '>JD<', '>SP<', '>OP<'],
  },
  {
    email: 'ops.manager@apron.local',
    path: '/ops',
    expect: ['ops-sidebar'],
    forbid: ['avatar-initials'],
  },
  {
    email: 'dispatch@hudsonexec.example',
    path: '/provider',
    expect: ['provider-sidebar'],
    forbid: ['avatar-initials'],
  },
  {
    email: 'aviation@meridiancapital.example',
    path: '/client',
    expect: ['client-hero'],
    // No internal vocabulary on a client surface.
    forbid: ['sourcing', 'rematch', 'provider_offer', 'awaiting_confirmation'],
  },
];

let failures = 0;

for (const check of CHECKS) {
  const login = await attemptLogin({
    email: check.email,
    password: 'Apron!Dev2026',
    ipAddress: null,
    userAgent: 'diag',
  });

  if (login.kind !== 'ok') {
    console.log(`${check.path}: SIGN-IN FAILED`);
    failures += 1;
    continue;
  }

  const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;
  const response = await fetch(`${BASE}${check.path}`, { headers: { cookie }, redirect: 'manual' });
  const html = response.status === 200 ? await response.text() : '';

  const missing = check.expect.filter((needle) => !html.includes(needle));
  const present = (check.forbid ?? []).filter((needle) => html.includes(needle));

  const ok = response.status === 200 && missing.length === 0 && present.length === 0;
  if (!ok) failures += 1;

  console.log(`${ok ? ' ok ' : 'FAIL'}  ${check.path.padEnd(18)} HTTP ${String(response.status)}`);
  if (missing.length > 0) console.log(`        missing: ${missing.join(', ')}`);
  if (present.length > 0) console.log(`        should not appear: ${present.join(', ')}`);

  await revokeSession(login.session.sessionId);
}

// The sign-in page is public and must never carry development credentials.
const loginHtml = await (await fetch(`${BASE}/login`)).text();
const leaked = ['Apron!Dev2026', 'apron.local', 'Local development'].filter((needle) =>
  loginHtml.includes(needle),
);
if (leaked.length > 0) {
  failures += 1;
  console.log(`FAIL  /login carries development credentials: ${leaked.join(', ')}`);
} else {
  console.log(' ok   /login            no development credentials');
}

console.log(`\n${failures === 0 ? 'all UI checks passed' : `${String(failures)} failed`}`);
process.exit(failures === 0 ? 0 : 1);
