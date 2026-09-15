import '@/lib/server-guard';
import { sql } from 'drizzle-orm';
import { closePool, getDb } from '@/db/client';
import { askAboutRequest } from '@/services/research';
import { isAiEnabled, getEnv } from '@/lib/config/env';

/** Diagnostic: does the operations research assistant actually answer? */

const env = getEnv();
console.log('AI_ENABLED:', isAiEnabled(env));
console.log('research model:', env.OPENAI_RESEARCH_MODEL ?? '(not set)');
console.log('key present:', env.OPENAI_API_KEY !== undefined && env.OPENAI_API_KEY !== '');

const rows = await getDb().execute<{ id: string; reference: string }>(
  sql`select id, reference from requests order by created_at desc limit 1`,
);

const request = rows.rows[0];
if (request === undefined) {
  console.log('\nNo requests in this database — nothing to ask about.');
  await closePool();
  process.exit(0);
}

console.log(`\nasking about ${request.reference} (${request.id})\n`);

const result = await askAboutRequest(
  request.id,
  'Why was the chosen provider selected for the ground transport?',
  { actorUserId: null },
);

console.log('kind:', result.kind);
console.log('unavailableReason:', result.unavailableReason ?? '(none)');

if (result.answer !== null) {
  console.log('answeredFromContext:', result.answer.answeredFromContext);
  console.log('actionRequested:', result.answer.actionRequested);
  console.log('answer:', result.answer.answer.slice(0, 400));
} else {
  console.log('answer: NULL');
}

const calls = await getDb().execute<{
  stage: string;
  outcome: string;
  error_category: string | null;
  error_detail: string | null;
  model: string;
}>(sql`
  select stage, outcome, error_category, error_detail, model
  from ai_calls where stage = 'research' order by occurred_at desc limit 3
`);

console.log('\nrecent research ai_calls:');
for (const call of calls.rows) {
  console.log(
    ` ${call.outcome.padEnd(18)} ${call.model.padEnd(18)} ${call.error_category ?? ''} ${call.error_detail ?? ''}`,
  );
}

await closePool();
process.exit(0);
