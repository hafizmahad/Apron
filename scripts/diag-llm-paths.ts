import '@/lib/server-guard';
import { sql } from 'drizzle-orm';
import { closePool, getDb } from '@/db/client';
import { runIntake } from '@/domain/requests/intake';
import { askAboutRequest } from '@/services/research';
import { isAiEnabled, getEnv } from '@/lib/config/env';

/**
 * Diagnostic: every place the model is supposed to run, actually runs.
 *
 * Exercises the three production stages against the real key, through the same functions
 * the product calls — not through a copy of them:
 *
 *   intake    a client sentence becomes structured data
 *   matching  recorded per line as `ai_consulted` when an offer was dispatched
 *   research  an operations question answered from the trace
 *
 * A "PASS" here means the model was genuinely consulted and its output validated, not that
 * the deterministic fallback quietly covered for it — which is exactly the failure this
 * script exists to catch.
 */

const env = getEnv();
let failures = 0;

function report(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? ' PASS ' : ' FAIL '} ${label.padEnd(22)} ${detail}`);
}

console.log('AI_ENABLED:', isAiEnabled(env));
console.log('models:', {
  intake: env.OPENAI_INTAKE_MODEL,
  reasoning: env.OPENAI_REASONING_MODEL,
  research: env.OPENAI_RESEARCH_MODEL,
});
console.log('');

// --- 1. intake: the client path the user named ------------------------------
const draft = await runIntake({
  sentence: 'Landing at Teterboro tomorrow at 9am, two cars and catering for four.',
  referenceDate: new Date().toISOString().slice(0, 10),
  referenceTimezone: 'America/New_York',
  actorUserId: null,
});

report(
  'intake source',
  draft.source === 'ai',
  draft.source === 'ai'
    ? 'the model read the sentence'
    : `FELL BACK to ${draft.source}: ${draft.aiUnavailableReason ?? 'no reason given'}`,
);
report(
  'intake airport',
  draft.airport !== null,
  draft.airport === null
    ? 'airport not resolved'
    : `resolved ${draft.airport.icao ?? draft.airport.name}`,
);
report(
  'intake services',
  draft.services.length >= 2,
  `${String(draft.services.length)} service(s): ${draft.services
    .map((service) => service.category?.code ?? 'unresolved')
    .join(', ')}`,
);
report(
  'intake arrival',
  draft.arrival !== null,
  draft.arrival === null ? 'no arrival extracted' : draft.arrival.display,
);

// A sentence this short cannot carry every field the catalogue requires, so the useful
// assertion is not "confirmable" — it is that the clarification engine asks for exactly
// what configuration says is missing, and refuses confirmation until it has it.
const { isDraftDispatchable, clarificationPlanFor } = await import('@/domain/requests/intake');
const { listActiveServiceCategories } = await import('@/domain/services/resolve');
const categories = await listActiveServiceCategories();
const plan = clarificationPlanFor(draft, categories);

report(
  'intake clarifies',
  plan.blocking.length > 0,
  plan.blocking.length === 0
    ? 'nothing asked — the catalogue requires nothing here'
    : `asks ${String(plan.blocking.length)}: ${plan.blocking.map((item) => item.label).join(', ')}`,
);
report(
  'confirmation gated',
  !isDraftDispatchable(draft, categories),
  'blocked until the required details are given',
);

// --- 2. matching: was the model consulted on real offers? -------------------
const matching = await getDb().execute<{ total: number; consulted: number; verified: number }>(sql`
  select
    count(*)::int                                                   as total,
    count(*) filter (where ai_consulted)::int                       as consulted,
    count(*) filter (where ai_consulted and ai_verified)::int        as verified
  from match_attempts
`);

const m = matching.rows[0];
report(
  'matching consulted',
  (m?.consulted ?? 0) > 0,
  `${String(m?.consulted ?? 0)} of ${String(m?.total ?? 0)} attempts used the model`,
);
report(
  'matching verified',
  (m?.consulted ?? 0) === 0 || (m?.verified ?? 0) > 0,
  `${String(m?.verified ?? 0)} passed verification`,
);

// --- 3. research: the operations assistant ----------------------------------
const requests = await getDb().execute<{ id: string; reference: string }>(
  sql`select id, reference from requests order by created_at desc limit 1`,
);
const request = requests.rows[0];

if (request === undefined) {
  report('research', false, 'no request to ask about');
} else {
  const answer = await askAboutRequest(request.id, 'Why was this provider chosen?', {
    actorUserId: null,
  });

  report(
    'research answered',
    answer.kind === 'answered' && answer.answer !== null,
    answer.kind === 'answered'
      ? `${String(answer.answer?.answer.length ?? 0)} chars about ${request.reference}`
      : `unavailable: ${answer.unavailableReason ?? ''}`,
  );

  // Journey F: asked to act, it must refuse rather than imply it did anything.
  const action = await askAboutRequest(request.id, 'Book a different provider for me.', {
    actorUserId: null,
  });
  report(
    'research refuses action',
    action.answer?.actionRequested === true,
    action.answer?.actionRequested === true ? 'flagged as an action request' : 'did NOT refuse',
  );
}

// --- 4. what the platform actually recorded ---------------------------------
const calls = await getDb().execute<{ stage: string; outcome: string; n: number }>(sql`
  select stage, outcome, count(*)::int as n
  from ai_calls
  where occurred_at > now() - interval '10 minutes'
  group by stage, outcome order by stage
`);

console.log('\nai_calls in the last 10 minutes:');
for (const row of calls.rows) {
  console.log(`  ${row.stage.padEnd(10)} ${row.outcome.padEnd(18)} ${String(row.n)}`);
}
if (calls.rows.length === 0) console.log('  (none)');

console.log(`\n${failures === 0 ? 'every LLM path works' : `${String(failures)} LLM path(s) failing`}`);
await closePool();
process.exit(failures === 0 ? 0 : 1);
