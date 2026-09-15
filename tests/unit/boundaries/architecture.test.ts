import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-boundary tests (CLAUDE.md §25: "Add source-boundary tests so architecture
 * regressions fail loudly").
 *
 * These assert on the import graph, not on behaviour. They are cheap, and they catch the
 * class of mistake that is otherwise invisible until something important is quietly
 * wrong — an AI module reaching for the database, or the pure matching engine gaining a
 * clock and silently becoming irreproducible.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

function sourceFiles(pattern: string): string[] {
  return globSync(pattern, { cwd: ROOT })
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    .map((file) => file.split(sep).join('/'));
}

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

/** Import specifiers of a module, from static imports, `export … from` and `import()`. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** Strips comments and string literals so a rule cannot trip on prose about itself. */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

describe('the time module owns every timezone conversion (ADR-005)', () => {
  it('nothing outside src/lib/time imports luxon', () => {
    const offenders = sourceFiles('src/**/*.{ts,tsx}')
      .filter((file) => !file.startsWith('src/lib/time/'))
      .filter((file) => importSpecifiers(read(file)).some((s) => s === 'luxon' || s.startsWith('luxon/')));

    expect(offenders).toEqual([]);
  });

  it('src/lib/time is the only place that constructs Intl.DateTimeFormat for zone maths', () => {
    // Formatting for display is legitimate elsewhere; what must not spread is zone
    // *conversion*. `timeZoneName: 'longOffset'` is the tell-tale of offset extraction.
    const offenders = sourceFiles('src/**/*.{ts,tsx}')
      .filter((file) => !file.startsWith('src/lib/time/'))
      .filter((file) => /timeZoneName\s*:\s*['"]longOffset['"]/.test(stripCommentsAndStrings(read(file))));

    expect(offenders).toEqual([]);
  });
});

describe('the matching engine is pure (ADR-009)', () => {
  const engineFiles = sourceFiles('src/domain/matching/**/*.ts');

  it('has files to check', () => {
    expect(engineFiles.length).toBeGreaterThan(0);
  });

  it('imports nothing from src/db except pure type modules', () => {
    const offenders: string[] = [];
    for (const file of engineFiles) {
      for (const specifier of importSpecifiers(read(file))) {
        if (!specifier.startsWith('@/db')) continue;
        // Enum value lists are pure data and are shared deliberately; the client,
        // queries and seed are not importable from here.
        if (specifier === '@/db/schema/enums') continue;
        offenders.push(`${file} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never imports the database client, drizzle or a queue', () => {
    const forbidden = ['@/db/client', 'drizzle-orm', 'pg', 'ioredis', 'bullmq', '@/jobs'];
    const offenders: string[] = [];
    for (const file of engineFiles) {
      for (const specifier of importSpecifiers(read(file))) {
        if (forbidden.some((bad) => specifier === bad || specifier.startsWith(`${bad}/`))) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never reads the clock or uses randomness', () => {
    const offenders: string[] = [];
    for (const file of engineFiles) {
      const source = stripCommentsAndStrings(read(file));
      if (/\bDate\s*\.\s*now\s*\(/.test(source)) offenders.push(`${file}: Date.now()`);
      if (/\bnew\s+Date\s*\(\s*\)/.test(source)) offenders.push(`${file}: new Date()`);
      if (/\bMath\s*\.\s*random\s*\(/.test(source)) offenders.push(`${file}: Math.random()`);
      if (/\bcrypto\s*\.\s*randomUUID\s*\(/.test(source)) offenders.push(`${file}: randomUUID()`);
    }
    expect(offenders).toEqual([]);
  });

  it('performs no database mutation', () => {
    const offenders: string[] = [];
    for (const file of engineFiles) {
      const source = stripCommentsAndStrings(read(file));
      for (const verb of ['insert', 'update', 'delete', 'upsert', 'truncate']) {
        // Method-call shape only, so a local variable named `update` is not a false hit.
        if (new RegExp(`\\.\\s*${verb}\\s*\\(`, 'i').test(source)) {
          offenders.push(`${file}: .${verb}(`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('server-only code stays server-only', () => {
  it('every module importing the db client or queue also imports the server guard', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src/**/*.{ts,tsx}')) {
      if (file === 'src/lib/server-guard.ts') continue;
      const source = read(file);
      const specifiers = importSpecifiers(source);

      const touchesServerOnly = specifiers.some(
        (s) => s === 'pg' || s === 'ioredis' || s === 'bullmq' || s === 'argon2' || s === 'nodemailer',
      );
      if (!touchesServerOnly) continue;

      if (!specifiers.includes('@/lib/server-guard')) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no client component imports a server-only module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src/**/*.{ts,tsx}')) {
      const source = read(file);
      if (!/^\s*['"]use client['"]/m.test(source)) continue;

      for (const specifier of importSpecifiers(source)) {
        if (
          specifier.startsWith('@/db') ||
          specifier.startsWith('@/jobs') ||
          specifier === '@/auth/password' ||
          specifier === 'pg' ||
          specifier === 'ioredis' ||
          specifier === 'node:fs'
        ) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the asset registry is the only source of asset paths (ADR-012)', () => {
  it('no module outside src/lib/assets.ts contains a literal /assets/apron/ path', () => {
    const offenders = sourceFiles('src/**/*.{ts,tsx}')
      .filter((file) => file !== 'src/lib/assets.ts')
      .filter((file) => read(file).includes('/assets/apron/'));

    expect(offenders).toEqual([]);
  });

  it('the implementation-reference images are never registered', () => {
    const registry = read('src/lib/assets.ts');
    // These are design references, not product content (pack README, CLAUDE.md §21).
    for (const forbidden of ['ui-reference.png', 'asset-pack-preview.png']) {
      const registeredSomewhere = new RegExp(`\\b(?:brand|service|aviation|domain|background|location|provider|illustration|misc)\\w*\\s*[:=][^\\n]*${forbidden}`);
      expect(registeredSomewhere.test(registry)).toBe(false);
    }
  });
});

describe('design tokens are the only source of colour', () => {
  it('no component hard-codes a hex colour', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src/components/**/*.{ts,tsx}').concat(
      sourceFiles('src/app/**/*.tsx'),
    )) {
      const source = stripCommentsAndStrings(read(file));
      const matches = source.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (matches !== null) offenders.push(`${file}: ${matches.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
