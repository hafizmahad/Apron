import '@/lib/server-guard';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { getEnv } from '@/lib/config/env';

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:3001';

const login = await attemptLogin({
  email: 'admin@apron.local',
  password: 'Apron!Dev2026',
  ipAddress: null,
  userAgent: 'diag',
});
if (login.kind !== 'ok') {
  console.error('sign-in failed');
  process.exit(1);
}

const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;
const html = await (await fetch(`${BASE}/admin/audit`, { headers: { cookie } })).text();
const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

console.log('Does the readable label render alongside the raw action?\n');
for (const [label, raw] of [
  ['No provider could be found', 'request_line.match_failed'],
  ['Offer sent to provider', 'offer.sent'],
  ['Provider accepted', 'offer.acknowledge'],
] as const) {
  console.log(`  label "${label}": ${text.includes(label) ? 'PRESENT' : 'MISSING'}   raw "${raw}": ${text.includes(raw) ? 'present (provenance)' : 'absent'}`);
}

const idx = text.indexOf('request_line.match_failed');
if (idx >= 0) console.log(`\ncontext around the raw value:\n  …${text.slice(Math.max(0, idx - 130), idx + 60).trim()}…`);

await revokeSession(login.session.sessionId);
process.exit(0);
