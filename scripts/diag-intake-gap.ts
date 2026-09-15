import '@/lib/server-guard';
import { runIntake, isDraftDispatchable, clarificationPlanFor } from '@/domain/requests/intake';
import { listActiveServiceCategories } from '@/domain/services/resolve';
import { missingRequiredFields } from '@/domain/services/requirements';

const SENTENCE =
  'Arriving Opa Locka Saturday 8pm, 5 passengers, two SUVs and breakfast catering, Hotel for 3.';

const draft = await runIntake({
  sentence: SENTENCE,
  referenceDate: '2026-09-15',
  referenceTimezone: 'America/New_York',
  actorUserId: null,
});

console.log(`sentence: ${SENTENCE}\n`);
console.log(`source: ${draft.source}   airport: ${draft.airport?.icao ?? 'none'}`);
console.log(`arrival: ${draft.arrival?.display ?? 'none'}`);
const categories = await listActiveServiceCategories();
console.log(`DISPATCHABLE: ${String(isDraftDispatchable(draft, categories))}   <-- would the Confirm button be enabled?\n`);

for (const service of draft.services) {
  console.log(`service: ${service.category?.name ?? `UNRESOLVED "${service.token}"`}  qty=${String(service.quantity)}`);
  console.log(`  requirements supplied: ${JSON.stringify(service.requirements)}`);
  console.log(`  validation issues: ${service.requirementIssues.length === 0 ? '(none)' : service.requirementIssues.map((i) => `${i.label}: ${i.message}`).join(' | ')}`);

  if (service.category !== null) {
    const missing = missingRequiredFields(service.category.configSchemaJson, service.requirements);
    console.log(`  REQUIRED but absent: ${missing.length === 0 ? '(none)' : missing.map((f) => `${f.label} [${f.type}${f.options ? ': ' + f.options.join('/') : ''}]`).join(' | ')}`);
  }
  console.log('');
}

console.log(`clarifications (${String(draft.clarifications.length)}):`);
for (const c of draft.clarifications) {
  console.log(`  [${c.severity}] ${c.field}: ${c.question}${c.options.length > 0 ? ` -> ${c.options.slice(0, 4).join(', ')}` : ''}`);
}

process.exitCode = 0;
setTimeout(() => process.exit(0), 5_000).unref();

const plan = clarificationPlanFor(draft, categories);
console.log(`
CLARIFICATION PLAN — ${String(plan.blocking.length)} blocking, ${String(plan.optional.length)} optional:`);
for (const item of plan.blocking) {
  const control = item.control.kind === 'enum' || item.control.kind === 'entity'
    ? `${item.control.kind}(${item.control.options.map((o) => o.label).slice(0, 5).join('/')})`
    : item.control.kind;
  console.log(`  [${item.state}] ${item.serviceName ?? 'Trip'} — ${item.question}  <${control}>`);
  if (item.help !== null) console.log(`        help: ${item.help}`);
}
