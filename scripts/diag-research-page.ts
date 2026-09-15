import '@/lib/server-guard';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { getEnv } from '@/lib/config/env';
import { loadRequestList } from '@/db/queries/operations';
import { closePool } from '@/db/client';

/** Diagnostic: what does /ops/research actually render, and does the list have rows? */

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:53000';

const rows = await loadRequestList({});
console.log(`loadRequestList({}) -> ${String(rows.length)} rows`);
for (const row of rows.slice(0, 5)) {
  console.log(`  ${row.reference}  ${row.status}  arrival=${String(row.arrivalUtc)}`);
}

const login = await attemptLogin({
  email: 'ops.manager@apron.local',
  password: 'Apron!Dev2026',
  ipAddress: null,
  userAgent: 'diag',
});

if (login.kind !== 'ok') {
  console.error('sign-in failed', login.kind);
  await closePool();
  process.exit(1);
}

const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;

for (const path of ['/ops/research', rows[0] ? `/ops/research?request=${rows[0].id}` : null].filter(
  (value): value is string => value !== null,
)) {
  const response = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' });
  const html = response.status === 200 ? await response.text() : '';

  console.log(`\n${path}  HTTP ${String(response.status)}`);
  console.log('  "No requests to ask about":', html.includes('No requests to ask about'));
  console.log('  "Pick a request to ask about":', html.includes('Pick a request to ask about'));
  console.log('  research panel present:', html.includes('Research assistant'));
  console.log('  question textarea present:', html.includes('name="question"'));
  console.log('  requestId hidden field:', html.includes('name="requestId"'));
  console.log('  AI switched off banner:', html.includes('AI assistance is switched off'));
}

await revokeSession(login.session.sessionId);
await closePool();
process.exit(0);
