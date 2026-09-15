import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Bundles the worker entrypoint into a single ESM file.
 *
 * The worker shares the `src/` tree with the web app (ADR-001), including the `@/*` path
 * alias, so it cannot simply be run by `node` after `tsc`. Bundling keeps the production
 * worker image free of a TypeScript runtime loader and resolves the alias at build time.
 *
 * Native and connection-pooling packages stay external so their platform binaries and
 * `require`-time behaviour are untouched.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  // Object form so the seed entry lands at `dist-worker/seed.js` rather than
  // `dist-worker/index.js`, which is what `docker-compose.yml` invokes.
  // The verification scripts are bundled alongside the worker for one reason: they need
  // the database as well as HTTP. They read seeded row counts, sign in through
  // `attemptLogin` and revoke the session afterwards — which is what makes them worth
  // more than a curl — and a deployed database sits in a private subnet where neither a
  // laptop nor a CI runner can reach it. Bundled, they run as a one-off task inside the
  // VPC against the public URL, which is the only place they can tell the whole truth.
  entryPoints: {
    worker: join(root, 'src/jobs/worker.ts'),
    migrate: join(root, 'src/db/migrate.ts'),
    seed: join(root, 'src/db/seed/index.ts'),
    smoke: join(root, 'scripts/smoke.ts'),
    'verify-rbac': join(root, 'scripts/verify-rbac.ts'),
    'verify-routing': join(root, 'scripts/verify-routing.ts'),
    // Scenario requests, for a deployed environment that needs something to show. They
    // are created by calling the same services the product uses — never by inserting
    // rows — so every status, offer and assignment is one the state machines produced.
    scenarios: join(root, 'scripts/seed-scenarios.ts'),
  },
  outdir: join(root, 'dist-worker'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  banner: {
    // Some CommonJS dependencies reach for `require` when bundled into ESM.
    js: [
      "import { createRequire as __apronCreateRequire } from 'node:module';",
      'const require = __apronCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  // `argon2` belongs here for the same reason as `pg`: it is a native module, and bundling
  // it broke the seed. Its CommonJS entry reads `__dirname` to locate its own .node binary,
  // and an ESM bundle has no `__dirname` — so `node dist-worker/seed.js` failed with
  // "the argon2 module could not be loaded" the moment it hashed the first password. That
  // is the documented deployment path for creating the first administrator, so it failed
  // in the one place it could not be allowed to.
  external: [
    'argon2',
    'pg',
    'pg-native',
    'ioredis',
    'bullmq',
    'pino',
    'pino-pretty',
    'nodemailer',
    'openai',
  ],
  alias: {
    '@': join(root, 'src'),
  },
});
