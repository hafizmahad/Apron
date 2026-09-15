import '@/lib/server-guard';
import { asc, eq } from 'drizzle-orm';
import { closePool, getDb } from '@/db/client';
import { providerCompanies, users } from '@/db/schema';
import { attemptLogin } from '@/auth/login';
import { revokeSession } from '@/auth/session';
import { homePortal, type Actor } from '@/domain/permissions';
import { getEnv } from '@/lib/config/env';

/**
 * Exhaustive routing and navigation verification against a RUNNING build.
 *
 * Every seeded account — all of them, not a sample — is signed in with its real password,
 * then driven through every portal route. The assertions are:
 *
 *   1. the password works;
 *   2. the account lands on the portal its role says it should;
 *   3. its own portal renders (HTTP 200);
 *   4. every other portal is REFUSED and redirects to its own portal, never to sign-in
 *      (being bounced to sign-in would wrongly imply the session was invalid);
 *   5. `/` sends a signed-in visitor to their portal rather than the marketing page;
 *   6. every sidebar link in the rendered navigation resolves — no dead links.
 *
 *   npm run verify:routing
 *   BASE=http://localhost:53000 npm run verify:routing
 */

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:3001';
const PASSWORD = 'Apron!Dev2026';
const PORTALS = ['/ops', '/provider', '/admin', '/client'] as const;

let failures = 0;
let checks = 0;
const failureDetail: string[] = [];

function check(label: string, passed: boolean, detail = ''): void {
  checks += 1;
  if (!passed) {
    failures += 1;
    failureDetail.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
  const mark = passed ? '[32m ok [0m' : '[31mFAIL[0m';
  console.log(`  [${mark}] ${label}${detail === '' ? '' : `  (${detail})`}`);
}

async function visit(path: string, cookie?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
    redirect: 'manual',
  });
}

/**
 * Which portals a role may legitimately READ, beyond its own home.
 *
 * Admin may read Operations (CLAUDE.md §1: they see every request and its full trace).
 * Nobody may read the Provider portal but a provider: it is scoped to exactly one company
 * and no other role has one to scope it to.
 */
function alsoReadable(actor: Actor): readonly string[] {
  return actor.role === 'platform_admin' ? ['/ops'] : [];
}

async function main(): Promise<void> {
  console.log(`\nApron — routing and navigation verification against ${BASE}\n`);

  const health = await fetch(`${BASE}/api/health`);
  if (!health.ok) throw new Error(`Application is not healthy at ${BASE} (HTTP ${health.status}).`);

  const db = getDb();
  const accounts = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      status: users.status,
      providerCompanyId: users.providerCompanyId,
      clientOrganizationId: users.clientOrganizationId,
      companyName: providerCompanies.displayName,
      companyStatus: providerCompanies.status,
    })
    .from(users)
    .leftJoin(providerCompanies, eq(providerCompanies.id, users.providerCompanyId))
    .orderBy(asc(users.role), asc(users.email));

  console.log(`Found ${accounts.length} seeded accounts.\n`);
  if (accounts.length === 0) {
    throw new Error('No accounts found — run "npm run db:seed" first.');
  }

  // --- anonymous -----------------------------------------------------------
  console.log('Anonymous visitor');
  for (const portal of PORTALS) {
    const response = await visit(portal);
    const location = response.headers.get('location') ?? '';
    check(
      `${portal} sends an anonymous visitor to sign-in`,
      response.status === 307 && location.includes('/login'),
      `HTTP ${response.status} -> ${location || 'no redirect'}`,
    );
  }
  const anonymousRoot = await visit('/');
  check('/ shows the public landing page to an anonymous visitor', anonymousRoot.status === 200,
    `HTTP ${anonymousRoot.status}`);

  // --- every account -------------------------------------------------------
  for (const account of accounts) {
    const actor: Actor = {
      userId: account.id,
      role: account.role,
      providerCompanyId: account.providerCompanyId,
      clientOrganizationId: account.clientOrganizationId,
      status: account.status,
    };
    const expectedHome = homePortal(actor);
    const label = `${account.role} · ${account.email}`;

    console.log(
      `\n${label}${account.companyName === null ? '' : `  [${account.companyName}: ${account.companyStatus}]`}`,
    );

    // 1. the real password works
    const login = await attemptLogin({ email: account.email, password: PASSWORD });
    check('password signs in', login.kind === 'ok', login.kind);
    if (login.kind !== 'ok') continue;

    const cookie = `${getEnv().SESSION_COOKIE_NAME}=${login.session.token}`;

    // 2. `/` sends them to their own portal
    const root = await visit('/', cookie);
    const rootLocation = root.headers.get('location') ?? '';
    check(
      `/ redirects to ${expectedHome}`,
      root.status === 307 && rootLocation.endsWith(expectedHome),
      `HTTP ${root.status} -> ${rootLocation || 'no redirect'}`,
    );

    // 3. their own portal renders
    const home = await visit(expectedHome, cookie);
    check(`${expectedHome} renders`, home.status === 200, `HTTP ${home.status}`);

    // 4. every other portal is refused, and refused in the right way
    const readable = new Set<string>([expectedHome, ...alsoReadable(actor)]);
    for (const portal of PORTALS) {
      if (readable.has(portal)) {
        if (portal !== expectedHome) {
          const extra = await visit(portal, cookie);
          check(`${portal} is readable (documented exception)`, extra.status === 200, `HTTP ${extra.status}`);
        }
        continue;
      }

      const response = await visit(portal, cookie);
      const location = response.headers.get('location') ?? '';
      const refusedCorrectly =
        response.status === 307 && !location.includes('/login') && location.endsWith(expectedHome);

      check(
        `${portal} is refused and returns them to ${expectedHome}`,
        refusedCorrectly,
        `HTTP ${response.status} -> ${location || 'no redirect'}`,
      );
    }

    // 5. every navigation link in the rendered shell actually resolves
    if (home.status === 200) {
      const html = await home.text();
      const links = [...new Set([...html.matchAll(/href="(\/[a-z0-9/-]*)"/gi)].map((m) => m[1] ?? ''))]
        .filter((href) => href !== '' && !href.startsWith('/api/') && href !== '/login');

      let deadLinks = 0;
      const dead: string[] = [];
      for (const href of links) {
        const target = await visit(href, cookie);
        // 200 renders, 307 is a deliberate redirect. 404 or 500 is a dead link.
        if (target.status !== 200 && target.status !== 307) {
          deadLinks += 1;
          dead.push(`${href} (HTTP ${target.status})`);
        }
      }
      check(
        `all ${links.length} navigation links resolve`,
        deadLinks === 0,
        dead.length === 0 ? '' : dead.join(', '),
      );

      // 6. the page's OWN assets load.
      //
      // This check exists because its absence let a completely unusable build pass
      // 194/194. `next build` emits a standalone server that deliberately omits
      // `.next/static` and `public/`, so every stylesheet and script chunk 404s while
      // every page still returns 200. Checking page status alone cannot see it — the
      // HTML is fine; nothing else arrives. A portal with no CSS and no hydration is
      // not a working portal, whatever the status code says.
      const assets = [
        ...new Set(
          [...html.matchAll(/(?:href|src)="(\/_next\/static\/[^"?]+)"/gi)].map((m) => m[1] ?? ''),
        ),
      ].filter((href) => href !== '');

      const stylesheets = assets.filter((href) => href.endsWith('.css'));
      const scripts = assets.filter((href) => href.endsWith('.js'));

      check(
        'the page references a stylesheet',
        stylesheets.length > 0,
        stylesheets.length > 0 ? '' : 'no /_next/static/*.css in the rendered HTML',
      );

      const brokenAssets: string[] = [];
      // Scripts are numerous and identical across portals; a sample proves the mount.
      for (const href of [...stylesheets, ...scripts.slice(0, 5)]) {
        const asset = await fetch(`${BASE}${href}`, { redirect: 'manual' });
        if (asset.status !== 200) brokenAssets.push(`${href} (HTTP ${asset.status})`);
      }

      // 7. exactly one navigation item is marked as the current page.
      //
      // The prefix rule this replaced marked the portal root current on every page
      // beneath it, so two items were highlighted at once and `aria-current` was
      // announced twice. `activeNavHref` has unit tests; this checks the wiring that
      // feeds it — the middleware header — is actually arriving in a real response.
      // The client surface has a header, not a sidebar — there is no nav item to mark, so
      // this property simply does not apply to it.
      const hasSidebar = expectedHome !== '/client';

      for (const navPath of hasSidebar ? [expectedHome, ...links.slice(0, 3)] : []) {
        const page = await visit(navPath, cookie);
        if (page.status !== 200) continue;

        const pageHtml = await page.text();
        const currents = [
          ...pageHtml.matchAll(/aria-current="page"/g),
        ].length;

        check(
          `${navPath} marks exactly one nav item current`,
          currents === 1,
          currents === 1 ? '' : `${String(currents)} items carry aria-current="page"`,
        );
      }

      check(
        `${stylesheets.length} stylesheet(s) and a sample of scripts load`,
        brokenAssets.length === 0,
        brokenAssets.length === 0
          ? ''
          : `${brokenAssets.join(', ')} — if these 404, .next/static was not copied into ` +
            '.next/standalone (run `npm run build`, which now does it)',
      );
    }

    await revokeSession(login.session.sessionId);
  }

  console.log(
    `\n${failures === 0 ? '[32m' : '[31m'}${checks - failures}/${checks} checks passed[0m`,
  );
  if (failures > 0) {
    console.log('\nFailures:');
    for (const detail of failureDetail) console.log(`  - ${detail}`);
  }
  console.log('');
}

try {
  await main();
  await closePool();
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  console.error('\nVerification could not complete:');
  console.error(error);
  await closePool();
  process.exit(1);
}
