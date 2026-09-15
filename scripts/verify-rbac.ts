import '@/lib/server-guard';
import { eq } from 'drizzle-orm';
import { closePool, getDb } from '@/db/client';
import { users } from '@/db/schema';
import { attemptLogin } from '@/auth/login';
import { createSession, revokeSession } from '@/auth/session';
import { getEnv } from '@/lib/config/env';
import { seedPassword } from '@/db/seed';

/**
 * Manual product verification of authentication and RBAC against a RUNNING build
 * (CLAUDE.md §32 Journey G, §34 "manually verify ... in the running application").
 *
 * This is not a recorded browser suite — no screenshots, no video, no visual baselines
 * (§3 forbids those). It is plain HTTP against the real server, with real sessions minted
 * through the application's own session module, asserting what a person would actually
 * see: that each role reaches its own portal, that every other portal is refused, and that
 * a forged or revoked cookie is worthless.
 *
 *   npm run verify:rbac              # expects the app on http://127.0.0.1:3001
 *   BASE=http://localhost:53000 npm run verify:rbac
 */

// BASE, then APP_URL, then the local standalone port. APP_URL is what the deployed
// environment already sets to its public origin, so running this as a one-off task in
// the VPC needs nothing passed to it — and pointing a check at the wrong host is a
// mistake that reports success about a server nobody uses.
const BASE = (process.env['BASE'] ?? process.env['APP_URL'] ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
// Whatever the seed used, so this works against a deployed environment too.
const PASSWORD = seedPassword().value;

let failures = 0;
let checks = 0;

function check(label: string, passed: boolean, detail = ''): void {
  checks += 1;
  if (!passed) failures += 1;
  const mark = passed ? '[32mPASS[0m' : '[31mFAIL[0m';
  console.log(`  [${mark}] ${label}${detail === '' ? '' : `  (${detail})`}`);
}

async function visit(path: string, cookie?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
    redirect: 'manual',
  });
}

/** A real session for a seeded account, created exactly as sign-in creates one. */
async function sessionCookieFor(email: string): Promise<{ cookie: string; sessionId: string }> {
  const rows = await getDb().select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (user === undefined) {
    throw new Error(`Seeded account ${email} not found — run "npm run db:seed" first.`);
  }
  const issued = await createSession(user.id);
  return {
    cookie: `${getEnv().SESSION_COOKIE_NAME}=${issued.token}`,
    sessionId: issued.sessionId,
  };
}

interface AccountExpectation {
  readonly label: string;
  readonly email: string;
  readonly home: string;
  readonly refused: readonly string[];
  /** Portals this role may legitimately read in addition to its own. */
  readonly alsoReaches?: readonly string[];
}

const ACCOUNTS: readonly AccountExpectation[] = [
  {
    label: 'platform admin',
    email: 'admin@apron.local',
    home: '/admin',
    // Admin may read Operations: CLAUDE.md §1 gives them sight of every request and its
    // full decision trace. They are refused the Provider portal for a structural reason,
    // not a policy one — that portal is scoped to exactly one company and an admin has
    // none, so there is nothing to scope it to.
    refused: ['/provider'],
    alsoReaches: ['/ops'],
  },
  {
    label: 'operations manager',
    email: 'ops.manager@apron.local',
    home: '/ops',
    refused: ['/admin', '/provider'],
  },
  {
    label: 'operations agent',
    email: 'ops.agent@apron.local',
    home: '/ops',
    refused: ['/admin', '/provider'],
  },
  {
    label: 'provider dispatcher (Hudson)',
    email: 'dispatch@hudsonexec.example',
    home: '/provider',
    refused: ['/ops', '/admin'],
  },
  {
    label: 'provider dispatcher (Palisade)',
    email: 'dispatch@palisadechauffeur.example',
    home: '/provider',
    refused: ['/ops', '/admin'],
  },
];

async function main(): Promise<void> {
  console.log(`\nApron — authentication and RBAC verification against ${BASE}\n`);

  // --- reachability -------------------------------------------------------
  const health = await fetch(`${BASE}/api/health`);
  if (!health.ok) {
    throw new Error(`The application is not healthy at ${BASE} (HTTP ${health.status}).`);
  }

  console.log('Unauthenticated access');
  for (const path of ['/ops', '/provider', '/admin']) {
    const response = await visit(path);
    const location = response.headers.get('location') ?? '';
    check(
      `${path} redirects an anonymous visitor to sign-in`,
      response.status === 307 && location.includes('/login'),
      `HTTP ${response.status}`,
    );
  }

  const loginPage = await visit('/login');
  const loginHtml = await loginPage.text();
  check('the sign-in page renders', loginPage.status === 200, `HTTP ${loginPage.status}`);
  check(
    'the sign-in form is wired to a server action',
    loginHtml.includes('name="email"') &&
      loginHtml.includes('name="password"') &&
      loginHtml.includes('<form'),
  );
  check(
    'no credential handling is shipped to the browser',
    !loginHtml.includes('passwordHash') && !loginHtml.includes('SESSION_SECRET'),
  );

  // --- credentials --------------------------------------------------------
  console.log('\nCredentials (through the real sign-in path)');
  const good = await attemptLogin({ email: 'admin@apron.local', password: PASSWORD });
  check('the correct password is accepted', good.kind === 'ok');

  const wrong = await attemptLogin({ email: 'admin@apron.local', password: 'wrong-password' });
  check('a wrong password is refused', wrong.kind === 'invalid_credentials');

  const unknown = await attemptLogin({ email: 'nobody@apron.local', password: PASSWORD });
  check(
    'an unknown address fails identically, revealing nothing',
    unknown.kind === 'invalid_credentials' && JSON.stringify(unknown) === JSON.stringify(wrong),
  );

  // --- portal access by role ---------------------------------------------
  console.log('\nPortal access by role');
  for (const account of ACCOUNTS) {
    const { cookie } = await sessionCookieFor(account.email);

    const home = await visit(account.home, cookie);
    check(`${account.label} reaches ${account.home}`, home.status === 200, `HTTP ${home.status}`);

    for (const path of account.alsoReaches ?? []) {
      const extra = await visit(path, cookie);
      check(`${account.label} may also read ${path}`, extra.status === 200, `HTTP ${extra.status}`);
    }

    for (const path of account.refused) {
      const response = await visit(path, cookie);
      const location = response.headers.get('location') ?? '';
      // Refused means sent back to their own portal — never rendered, and never bounced
      // to sign-in, which would wrongly suggest the session was invalid.
      const refused = response.status === 307 && !location.includes('/login');
      check(
        `${account.label} is refused ${path}`,
        refused,
        `HTTP ${response.status} -> ${location === '' ? 'no redirect' : location}`,
      );
    }
  }

  // --- session integrity --------------------------------------------------
  console.log('\nSession integrity');
  const forged = await visit('/ops', `${getEnv().SESSION_COOKIE_NAME}=not-a-real-token`);
  check(
    'a forged session token is rejected',
    forged.status === 307 && (forged.headers.get('location') ?? '').includes('/login'),
    `HTTP ${forged.status}`,
  );

  const { cookie: revocable, sessionId } = await sessionCookieFor('ops.manager@apron.local');
  const beforeRevoke = await visit('/ops', revocable);
  check('a live session is accepted', beforeRevoke.status === 200, `HTTP ${beforeRevoke.status}`);

  await revokeSession(sessionId);
  const afterRevoke = await visit('/ops', revocable);
  check(
    'the same cookie stops working the instant the session is revoked',
    afterRevoke.status === 307 && (afterRevoke.headers.get('location') ?? '').includes('/login'),
    `HTTP ${afterRevoke.status}`,
  );

  // --- suspended account --------------------------------------------------
  const { cookie: suspendable } = await sessionCookieFor('ops.agent@apron.local');
  check('a live session is accepted before suspension', (await visit('/ops', suspendable)).status === 200);

  await getDb().update(users).set({ status: 'suspended' }).where(eq(users.email, 'ops.agent@apron.local'));
  const suspended = await visit('/ops', suspendable);
  check(
    'suspending the account ends its existing session immediately',
    suspended.status === 307 && (suspended.headers.get('location') ?? '').includes('/login'),
    `HTTP ${suspended.status}`,
  );
  // Restore, so the script is safe to run repeatedly.
  await getDb().update(users).set({ status: 'active' }).where(eq(users.email, 'ops.agent@apron.local'));

  // --- security headers ---------------------------------------------------
  console.log('\nResponse headers');
  const headed = await visit('/login');
  for (const [header, expected] of [
    ['x-frame-options', 'DENY'],
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
  ] as const) {
    check(`${header} is set`, headed.headers.get(header) === expected, headed.headers.get(header) ?? 'absent');
  }
  check('every response carries a correlation id', headed.headers.get('x-correlation-id') !== null);

  console.log(
    `\n${failures === 0 ? '[32m' : '[31m'}${checks - failures}/${checks} checks passed[0m\n`,
  );
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
