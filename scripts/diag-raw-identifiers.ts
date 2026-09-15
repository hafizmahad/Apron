import '@/lib/server-guard';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { getEnv } from '@/lib/config/env';
import { AUDIT_ACTION_LABELS } from '@/lib/domain-labels';

/**
 * Diagnostic: does any snake_case identifier reach a user in the RUNNING build?
 *
 * The unit test guards the source. This guards the rendered page, which is the only place
 * the question is actually settled — a label can be correct in the registry and still not be
 * the thing a page renders, and a value that arrives from the database is invisible to a
 * source scan entirely.
 *
 * Scripts and attributes are stripped first: Next.js serialises the same enum values into
 * its flight payload, and those are wire data, not words a person reads.
 */

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:3001';
const PASSWORD = 'Apron!Dev2026';

const CHECKS: readonly { email: string; paths: readonly string[] }[] = [
  {
    email: 'admin@apron.local',
    paths: [
      '/admin', '/admin/requests', '/admin/providers', '/admin/users',
      '/admin/catalogue', '/admin/registry', '/admin/settings', '/admin/audit',
      '/admin/ai', '/admin/notifications',
    ],
  },
  {
    email: 'ops.manager@apron.local',
    paths: [
      '/ops', '/ops/requests', '/ops/schedule', '/ops/exceptions', '/ops/providers',
      '/ops/airports', '/ops/research', '/ops/messages', '/ops/notifications',
    ],
  },
  {
    email: 'dispatch@hudsonexec.example',
    paths: [
      '/provider', '/provider/queue', '/provider/schedule', '/provider/resources',
      '/provider/coverage', '/provider/team', '/provider/messages', '/provider/notifications',
    ],
  },
  { email: 'aviation@meridiancapital.example', paths: ['/client'] },
];

/**
 * The dynamic routes carry the most enum-bearing UI in the product — a request detail
 * renders statuses, offer states, assignment kinds and the decision trace. They are reached
 * the way a user reaches them: by following the first link the list page actually renders,
 * so a route that no longer links anywhere fails loudly instead of being quietly skipped.
 */
const FOLLOW: readonly { email: string; from: string; pattern: RegExp }[] = [
  { email: 'ops.manager@apron.local', from: '/ops/requests', pattern: /href="(\/ops\/requests\/[0-9a-f-]{36})"/ },
  { email: 'ops.manager@apron.local', from: '/ops/messages', pattern: /href="(\/ops\/messages\/[0-9a-f-]{36})"/ },
  { email: 'dispatch@hudsonexec.example', from: '/provider/messages', pattern: /href="(\/provider\/messages\/[0-9a-f-]{36})"/ },
  { email: 'aviation@meridiancapital.example', from: '/client', pattern: /href="(\/client\/requests\/[0-9a-f-]{36})"/ },
];

/**
 * Words that legitimately contain an underscore in prose. A timezone is the honest name of
 * the thing — "America/New_York" is how IANA writes it and how an operator recognises it.
 */
const ALLOWED: readonly RegExp[] = [/[A-Za-z]+\/[A-Za-z]+_[A-Za-z]+/];

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Every snake_case token a person would actually read on this page. */
function rawIdentifiers(html: string): readonly string[] {
  const text = visibleText(html);
  const allowedSpans = ALLOWED.flatMap((rule) => text.match(new RegExp(rule, 'g')) ?? []);

  return [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])].filter(
    (hit) => !allowedSpans.some((span) => span.includes(hit)),
  );
}

/**
 * Values a page shows ON PURPOSE, as small secondary text under a readable name.
 *
 *  - `/admin/catalogue` prints a service's `code` under a "Code" heading and its matching
 *    strategy under the strategy's own plain-English description. Both are what the engine
 *    switches on and what an audit event records; an admin defining a service needs them.
 *  - `/admin/settings` prints each setting and flag key beneath its readable name, because
 *    the key is what the audit trail records.
 *
 * They are listed here rather than silently tolerated, so adding one is a decision someone
 * has to write down.
 */
const DOCUMENTED_CODE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  '/admin/catalogue': [
    'ground_transport', 'close_protection', 'hotel_rooms', 'catering_order',
    'fuel_uplift', 'hangar_slot', 'vehicle_with_driver',
  ],
  '/admin/settings': [
    'max_rematch_attempts', 'same_provider_bonus', 'acknowledgement_minutes',
    'default_ground_transport_minutes', 'guest_link_ttl_hours', 'intake_enabled',
    'matching_enabled', 'research_assistant_enabled', 'guest_requests_enabled', 'sms_enabled',
  ],
};

/**
 * `/admin/audit` prints each event's raw action beneath its readable label, because that
 * string is what a support thread or a log query cites. The set is data-driven, so instead
 * of listing every action this PROVES the label rendered: a token is tolerated only when it
 * belongs to a known action whose English label is also on the page. If a label ever stops
 * rendering, the raw value stops being excused.
 */
function auditProvenance(hit: string, text: string): boolean {
  return Object.entries(AUDIT_ACTION_LABELS).some(
    ([action, label]) => action.split('.').includes(hit) && text.includes(label),
  );
}

/** A list page that legitimately has nothing to link to yet says so. */
const EMPTY_STATE = /Nothing|No conversations|no conversations|None yet|nothing yet|No messages/;

let problems = 0;

for (const { email, paths } of CHECKS) {
  const login = await attemptLogin({ email, password: PASSWORD, ipAddress: null, userAgent: 'diag' });

  if (login.kind !== 'ok') {
    console.log(`\n${email}: SIGN-IN FAILED (${login.kind})`);
    problems += 1;
    continue;
  }

  const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;
  console.log(`\n${email}`);

  for (const path of paths) {
    const response = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' });

    if (response.status !== 200) {
      console.log(`  ${path.padEnd(28)} HTTP ${String(response.status)}`);
      problems += 1;
      continue;
    }

    const documented = DOCUMENTED_CODE_FIELDS[path] ?? [];
    const html = await response.text();
    const all = rawIdentifiers(html);
    const visible = visibleText(html);
    const hits = all.filter(
      (hit) =>
        !documented.includes(hit) && !(path === '/admin/audit' && auditProvenance(hit, visible)),
    );
    const allowed = all.length - hits.length;

    if (hits.length > 0) problems += 1;
    console.log(
      `  ${path.padEnd(28)} ${hits.length === 0 ? 'clean' : `RAW: ${hits.join(', ')}`}` +
        (allowed > 0 ? `  (${String(allowed)} documented code field${allowed === 1 ? '' : 's'})` : ''),
    );
  }

  await revokeSession(login.session.sessionId);
}

console.log('\nDynamic routes, reached by following a real link:');

for (const { email, from, pattern } of FOLLOW) {
  const login = await attemptLogin({ email, password: PASSWORD, ipAddress: null, userAgent: 'diag' });

  if (login.kind !== 'ok') {
    console.log(`  from ${from.padEnd(23)} SIGN-IN FAILED`);
    problems += 1;
    continue;
  }

  const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;
  const listing = await fetch(`${BASE}${from}`, { headers: { cookie }, redirect: 'manual' });
  // Read once: a Response body cannot be consumed twice.
  const listingHtml = listing.status === 200 ? await listing.text() : '';
  const target = pattern.exec(listingHtml)?.[1] ?? null;

  if (target === null) {
    // A list with nothing in it is correct, not broken — but a list that HAS rows and links
    // nowhere is a dead portal. Those are different findings, so they are reported apart.
    const empty = EMPTY_STATE.test(visibleText(listingHtml));

    console.log(`  from ${from.padEnd(23)} ${empty ? 'empty list, nothing to open (correct)' : 'NO LINK FOUND — list has rows but links nowhere'}`);
    if (!empty) problems += 1;
    await revokeSession(login.session.sessionId);
    continue;
  }

  const response = await fetch(`${BASE}${target}`, { headers: { cookie }, redirect: 'manual' });

  if (response.status !== 200) {
    console.log(`  ${target.slice(0, 26).padEnd(28)} HTTP ${String(response.status)}`);
    problems += 1;
  } else {
    const hits = rawIdentifiers(await response.text());
    if (hits.length > 0) problems += 1;
    console.log(
      `  ${target.slice(0, 26).padEnd(28)} ${hits.length === 0 ? 'clean' : `RAW: ${hits.join(', ')}`}`,
    );
  }

  await revokeSession(login.session.sessionId);
}

console.log(
  `\n${problems === 0 ? 'no raw identifiers rendered anywhere' : `${String(problems)} page(s) with a problem`}`,
);
process.exit(problems === 0 ? 0 : 1);
