import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const srcAlias = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Four explicit projects, each with its own preconditions:
 *
 *  - `unit`        pure, hermetic, no services. Runs everywhere, always.
 *  - `integration` requires a live PostgreSQL (and Redis for queue suites).
 *  - `contracts`   requires the same, and exercises route handlers end to end.
 *  - `evals`       AI evals; run against the scripted adapter offline, or against
 *                  OpenAI when AI_ENABLED=true and a key is present.
 *
 * There is deliberately no browser/screenshot/video project (CLAUDE.md §3, ADR-014).
 */
export default defineConfig({
  resolve: {
    alias: { '@': srcAlias },
  },
  test: {
    globals: false,
    reporters: ['default'],
    projects: [
      {
        resolve: { alias: { '@': srcAlias } },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
          environment: 'node',
          setupFiles: ['tests/setup/unit.ts'],
        },
      },
      {
        resolve: { alias: { '@': srcAlias } },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/integration.ts'],
          // Integration and contract suites share ONE database. Vitest's default pool is
          // 'forks', so a 'threads' option here silently does nothing — the files then run
          // concurrently and interleave their truncations, which shows up as deadlocks and
          // foreign keys vanishing mid-test. 'singleFork' runs every file in this project
          // sequentially in one process.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve: { alias: { '@': srcAlias } },
        test: {
          name: 'contracts',
          include: ['tests/contracts/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/integration.ts'],
          // Integration and contract suites share ONE database. Vitest's default pool is
          // 'forks', so a 'threads' option here silently does nothing — the files then run
          // concurrently and interleave their truncations, which shows up as deadlocks and
          // foreign keys vanishing mid-test. 'singleFork' runs every file in this project
          // sequentially in one process.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve: { alias: { '@': srcAlias } },
        test: {
          name: 'evals',
          include: ['tests/evals/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/evals.ts'],
          testTimeout: 180_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
