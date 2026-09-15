import '@/lib/server-guard';
import { getDb } from '@/db/client';
import { sql } from 'drizzle-orm';

const db = getDb();

for (const [label, query] of [
  ['offers', sql`select status, count(*)::int as n from provider_offers group by status order by status`],
  ['threads', sql`select scope, count(*)::int as n from message_threads group by scope order by scope`],
  ['messages', sql`select count(*)::int as n from messages`],
  ['requests', sql`select status, count(*)::int as n from requests group by status order by status`],
  ['newest offers', sql`select id, status, created_at from provider_offers order by created_at desc limit 5`],
] as const) {
  const result = await db.execute(query);
  console.log(`\n${label}:`);
  for (const row of result.rows ?? []) console.log('  ', JSON.stringify(row));
}

process.exit(0);
