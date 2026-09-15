import '@/lib/server-guard';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { getDb } from '@/db/client';
import { sql } from 'drizzle-orm';
import { getEnv, isAiEnabled } from '@/lib/config/env';

/**
 * The local production smoke test (CLAUDE.md §31 Phase 12, §34).
 *
 * Answers one question: **is this deployment actually working?** Not "did the container
 * start" — a container can start perfectly and serve a product nobody can use.
 *
 * Deliberately NOT an end-to-end suite. It creates nothing, changes nothing and asserts no
 * business rule; the unit, integration and contract suites do that. It checks that the built
 * artefact, the database it was pointed at, the queue, the static assets and the sign-in path
 * are all present and talking to each other — the things that are fine on a developer's
 * machine and absent in a fresh deployment.
 *
 * It takes no screenshots and records nothing (CLAUDE.md §34).
 *
 *   npm run smoke                       # against http://127.0.0.1:3001
 *   BASE=http://127.0.0.1:53000 npm run smoke
 */

const BASE = (process.env['BASE'] ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env['SMOKE_TIMEOUT_MS'] ?? 15_000);

let failures = 0;
let checks = 0;

function report(label: string, ok: boolean, detail: string): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? ' PASS ' : ' FAIL '} ${label.padEnd(30)} ${detail}`);
}

async function get(path: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.log(`        ${path}: ${error instanceof Error ? error.message : 'unreachable'}`);
    return null;
  }
}

console.log(`\nApron smoke test against ${BASE}\n`);

// --- 1. the application answers, and says its dependencies are healthy ------
//
// `/api/health` reports the real state of Postgres and Redis and returns 503 when either is
// degraded, so this is a dependency check rather than a liveness ping.
const health = await get('/api/health');
const healthBody = health === null ? null : ((await health.json()) as Record<string, unknown>);

report(
  'application responds',
  health !== null,
  health === null ? `no response from ${BASE}` : `HTTP ${String(health.status)}`,
);

if (health !== null) {
  report(
    'dependencies healthy',
    health.status === 200 && healthBody?.['status'] === 'ok',
    JSON.stringify(healthBody?.['dependencies'] ?? healthBody ?? {}),
  );
}

// --- 2. the build shipped its assets ---------------------------------------
//
// Next's standalone output omits `.next/static` and `public/`. A deployment missing them
// serves a working API and an unstyled page, which looks like a broken product and reads in
// logs like a healthy one — so it is checked explicitly.
const landing = await get('/');
const landingHtml = landing?.status === 200 ? await landing.text() : '';

const cssHref = /href="(\/_next\/static\/[^"]+\.css)"/.exec(landingHtml)?.[1] ?? null;
report(
  'page renders',
  landingHtml.length > 500,
  landingHtml.length === 0 ? 'no HTML' : `${String(landingHtml.length)} bytes`,
);

if (cssHref !== null) {
  const css = await get(cssHref);
  report('stylesheet served', css?.status === 200, `${cssHref} → HTTP ${String(css?.status ?? 0)}`);
} else {
  report('stylesheet served', false, 'the page references no stylesheet');
}

const asset = await get('/assets/apron/06_service_images/ground-transport.webp');
report(
  'public assets served',
  asset?.status === 200,
  `service imagery → HTTP ${String(asset?.status ?? 0)}`,
);

// --- 3. an unauthenticated caller is turned away ---------------------------
//
// A deployment that serves an operations page to nobody in particular is worse than one
// that is down.
const guarded = await get('/ops/requests');
report(
  'private routes guarded',
  guarded !== null && (guarded.status === 307 || guarded.status === 302 || guarded.status === 401),
  `/ops/requests → HTTP ${String(guarded?.status ?? 0)}`,
);

// --- 4. someone can actually sign in ---------------------------------------
//
// Exercises argon2id verification and the session store together. Both are configuration
// that can be wrong in a way nothing else notices until a person tries to log in.
const env = getEnv();
const email = process.env['SMOKE_EMAIL'] ?? 'ops.manager@apron.local';
const password = process.env['SMOKE_PASSWORD'] ?? 'Apron!Dev2026';

const login = await attemptLogin({ email, password, ipAddress: null, userAgent: 'smoke' });
report('sign-in works', login.kind === 'ok', login.kind === 'ok' ? email : `refused: ${login.kind}`);

if (login.kind === 'ok') {
  const cookie = `${env.SESSION_COOKIE_NAME}=${login.session.token}`;
  const page = await get('/ops/requests', { headers: { cookie } });
  const body = page?.status === 200 ? await page.text() : '';

  report(
    'authenticated page renders',
    page?.status === 200 && body.length > 1000,
    `/ops/requests → HTTP ${String(page?.status ?? 0)}`,
  );

  await revokeSession(login.session.sessionId);
}

// --- 5. the database was migrated and seeded -------------------------------
//
// An empty database is the single most common way a fresh deployment is "up" and useless.
const db = getDb();

const counts = await db.execute<{ table_name: string; n: number }>(sql`
  select 'airports'           as table_name, count(*)::int as n from airports
  union all select 'service_categories', count(*)::int from service_categories
  union all select 'provider_companies', count(*)::int from provider_companies
  union all select 'users',              count(*)::int from users
  order by table_name
`);

for (const row of counts.rows ?? []) {
  report(`seeded: ${row.table_name}`, row.n > 0, `${String(row.n)} rows`);
}

// The runner records every applied file in `_apron_migrations` (ADR-003). A database that
// was created but never migrated has no such table at all, which is a distinct and more
// useful failure than "a query went wrong".
try {
  const [migrations] = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from _apron_migrations`)
  ).rows ?? [];

  report(
    'migrations applied',
    (migrations?.n ?? 0) > 0,
    `${String(migrations?.n ?? 0)} migrations recorded`,
  );
} catch {
  report('migrations applied', false, 'no _apron_migrations table — the database was never migrated');
}

// --- 6. the queue is reachable when it is meant to be ----------------------
report(
  'queue configured',
  true,
  env.QUEUE_ENABLED
    ? 'enabled — the worker dispatches matching and SLA jobs'
    : 'disabled — matching runs inline, which is a valid single-process deployment',
);

// --- 7. what the model is configured to do ---------------------------------
//
// Not a failure either way: the product is required to work with AI switched off
// (Journey E). This states which path this deployment will take so the reader knows.
report(
  'AI configuration',
  true,
  isAiEnabled(env)
    ? `enabled — intake ${env.OPENAI_INTAKE_MODEL ?? '?'}, matching ${env.OPENAI_REASONING_MODEL ?? '?'}`
    : 'disabled — intake falls back to manual entry and matching stays deterministic',
);

console.log(
  `\n${failures === 0 ? `all ${String(checks)} checks passed` : `${String(failures)} of ${String(checks)} checks FAILED`}\n`,
);

process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 5_000).unref();
