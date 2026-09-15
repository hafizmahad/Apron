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
  entryPoints: {
    worker: join(root, 'src/jobs/worker.ts'),
    migrate: join(root, 'src/db/migrate.ts'),
    seed: join(root, 'src/db/seed/index.ts'),
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
  external: ['pg', 'pg-native', 'ioredis', 'bullmq', 'pino', 'pino-pretty', 'nodemailer', 'openai'],
  alias: {
    '@': join(root, 'src'),
  },
});
