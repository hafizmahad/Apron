import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

/**
 * Type-aware linting is scoped to TypeScript sources only.
 *
 * `next/core-web-vitals` brings its own parser, and rules that need type information
 * (`consistent-type-imports`, the floating-promise checks) fail outright on any file that
 * parser handles — including this config file. Restricting the typed block to `.ts`/`.tsx`
 * and pinning `tseslint.parser` there keeps both halves working.
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist-worker/**',
      'public/**',
      'apron-production-assets/**',
      'next-env.d.ts',
      'coverage/**',
    ],
  },

  js.configs.recommended,
  ...compat.extends('next/core-web-vitals'),

  // --- TypeScript, with type information -----------------------------------
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause[body.body.length=0]',
          message: 'Empty catch blocks are forbidden (CLAUDE.md §33: no silent catches).',
        },
      ],
    },
  },

  // --- plain JavaScript: config and build scripts, no type information ------
  {
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },

  // --- console-facing operational tools ------------------------------------
  {
    files: [
      'scripts/**/*.ts',
      'src/jobs/worker.ts',
      'src/db/seed/**/*.ts',
      'src/db/migrate.ts',
      'src/db/reset.ts',
    ],
    rules: { 'no-console': 'off' },
  },

  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
