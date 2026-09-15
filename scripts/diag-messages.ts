import '@/lib/server-guard';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { getEnv } from '@/lib/config/env';
import { getDb } from '@/db/client';
import { messageThreads } from '@/db/schema/messaging';
import { sql } from 'drizzle-orm';

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:3001';

const db = getDb();
const threads = await db
  .select({ id: messageThreads.id, scope: messageThreads.scope, requestId: messageThreads.requestId, providerCompanyId: messageThreads.providerCompanyId })
  .from(messageThreads)
  .limit(20);

console.log(`threads in the database: ${String(threads.length)}`);
for (const thread of threads.slice(0, 8)) {
  console.log(`  ${thread.id}  scope=${thread.scope}  request=${String(thread.requestId)}`);
}

const counts = await db.execute(
  sql`select scope, count(*)::int as n from message_threads group by scope order by scope`,
);
console.log('\nby kind:', JSON.stringify(counts.rows ?? counts));

for (const email of ['ops.manager@apron.local', 'dispatch@hudsonexec.example']) {
  const login = await attemptLogin({ email, password: 'Apron!Dev2026', ipAddress: null, userAgent: 'diag' });
  if (login.kind !== 'ok') {
    console.log(`\n${email}: SIGN-IN FAILED`);
    continue;
  }

  const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;
  const path = email.includes('apron.local') ? '/ops/messages' : '/provider/messages';
  const html = await (await fetch(`${BASE}${path}`, { headers: { cookie } })).text();

  const links = [...new Set([...html.matchAll(/href="([^"]*messages\/[^"]+)"/g)].map((m) => m[1]))];
  const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  console.log(`\n${email} -> ${path}`);
  console.log(`  thread links rendered: ${links.length === 0 ? '(none)' : links.join(', ')}`);
  console.log(`  visible text: ${text.slice(0, 260).trim()}`);

  await revokeSession(login.session.sessionId);
}

process.exit(0);
