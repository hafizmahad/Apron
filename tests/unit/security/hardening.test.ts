import { readFileSync, globSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Security hardening checks (CLAUDE.md §27).
 *
 * Source-level assertions for the rules that are otherwise only true because everyone
 * remembered. Each one has a specific failure in mind:
 *
 *  - a secret reaching a log, a client bundle, or version control;
 *  - a mutation that skips the permission check because its author assumed the route guard
 *    was enough;
 *  - a string-concatenated SQL query;
 *  - an upload accepted without a type or size check.
 *
 * These are cheap and run in the ordinary unit gate, so a regression is caught in seconds
 * rather than in an audit.
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

function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const ALL_SOURCE = sourceFiles('src/**/*.{ts,tsx}');

describe('secrets never leave the environment (§27)', () => {
  it('finds source to check', () => {
    expect(ALL_SOURCE.length).toBeGreaterThan(50);
  });

  it('contains no hard-coded API key, token or password literal', () => {
    // Real key shapes, not the word "key". `sk-` prefixed OpenAI keys, AWS access key ids,
    // and long base64 blobs assigned to something that sounds like a credential.
    const patterns: readonly [string, RegExp][] = [
      ['OpenAI key', /\bsk-[A-Za-z0-9_-]{20,}/],
      ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
      ['private key block', /-----BEGIN (RSA |EC )?PRIVATE KEY-----/],
      [
        'assigned credential literal',
        /\b(password|secret|apiKey|api_key|token)\s*[:=]\s*['"][A-Za-z0-9+/_-]{16,}['"]/i,
      ],
    ];

    const offenders: string[] = [];
    for (const file of ALL_SOURCE) {
      const source = read(file);
      for (const [label, pattern] of patterns) {
        // The env schema names variables; that is a declaration, not a value.
        if (file === 'src/lib/config/env.ts' && label === 'assigned credential literal') continue;
        if (pattern.test(source)) offenders.push(`${file}: ${label}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never logs a secret-bearing value', () => {
    const offenders: string[] = [];

    for (const file of ALL_SOURCE) {
      const source = code(file);
      // A logger call whose object literal names a credential field.
      const matches = source.matchAll(
        /\blogger\(\)\.\w+\(\s*\{[^}]*\b(apiKey|api_key|password|passwordHash|secret|sessionToken|csrfSecret|token)\b\s*[,:}]/gi,
      );
      for (const match of matches) offenders.push(`${file}: ${match[1] ?? ''}`);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the env file out of version control', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^\.env$/m);
  });

  it('ships an .env.example with no real values', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    expect(example).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}/);
    expect(example).toMatch(/^OPENAI_API_KEY=\s*$/m);
  });
});

describe('no secret reaches a client bundle (§27)', () => {
  const clientComponents = ALL_SOURCE.filter((file) => /^\s*['"]use client['"]/m.test(read(file)));

  it('finds client components to check', () => {
    expect(clientComponents.length).toBeGreaterThan(0);
  });

  it('client components read no environment variable except NEXT_PUBLIC_ ones', () => {
    const offenders: string[] = [];

    for (const file of clientComponents) {
      const matches = code(file).matchAll(/process\.env\[?['"]?(\w+)/g);
      for (const match of matches) {
        const name = match[1] ?? '';
        if (!name.startsWith('NEXT_PUBLIC_')) offenders.push(`${file}: ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('client components never import the database, the queue or the AI client', () => {
    const offenders: string[] = [];

    for (const file of clientComponents) {
      const matches = read(file).matchAll(/from\s*['"]([^'"]+)['"]/g);
      for (const match of matches) {
        const specifier = match[1] ?? '';
        if (
          specifier.startsWith('@/db/') ||
          specifier.startsWith('@/jobs/') ||
          specifier.startsWith('@/ai/') ||
          specifier === 'drizzle-orm' ||
          specifier === 'bullmq' ||
          specifier === 'openai'
        ) {
          // A type-only import is erased at build time and reaches no bundle.
          const line = read(file)
            .split('\n')
            .find((entry) => entry.includes(specifier));
          if (line !== undefined && /\bimport\s+type\b|\{\s*type\s/.test(line)) continue;
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('every server action checks a permission server-side (§5, §27)', () => {
  const actionFiles = ALL_SOURCE.filter(
    (file) => file.endsWith('/actions.ts') && /^\s*['"]use server['"]/m.test(read(file)),
  );

  it('finds the action files', () => {
    expect(actionFiles.length).toBeGreaterThan(3);
  });

  /**
   * Sign-in is the one action that cannot establish an actor first — establishing one is
   * what it does. It is exempt by nature, not by oversight, and has its own protections
   * (rate limiting, identical failures for a wrong password and an unknown address,
   * lockout) covered by the auth integration suite.
   */
  const NO_ACTOR_REQUIRED = new Set(['src/app/(public)/login/actions.ts']);

  /**
   * Actions that need authentication but no *capability*, because they act only on the
   * caller's own rows and are scoped by user id inside the query rather than by a
   * permission. Listing them explicitly is deliberate: adding a file here should require
   * someone to justify it in review, and the test below checks the scoping is real.
   */
  const SELF_SCOPED = new Set([
    'src/app/notifications/actions.ts',
    'src/app/(public)/login/actions.ts',
  ]);

  it('every action module establishes the actor before doing anything', () => {
    const offenders = actionFiles
      .filter((file) => !NO_ACTOR_REQUIRED.has(file))
      .filter((file) => !/\b(requireActor|requireSession|requirePermission)\s*\(/.test(code(file)));

    expect(offenders).toEqual([]);
  });

  it('every action module performs an explicit capability check', () => {
    // `can(...)` and `requirePermission(...)` are the direct forms; the `canX(...)` helpers
    // in src/domain/permissions are the domain-specific ones, and they call `can` too.
    const capabilityCheck = /\bcan\s*\(|\brequirePermission\s*\(|\bcan[A-Z]\w*\s*\(/;

    const offenders = actionFiles
      .filter((file) => !SELF_SCOPED.has(file))
      .filter((file) => !capabilityCheck.test(code(file)));

    expect(offenders).toEqual([]);
  });

  it('a self-scoped action really is scoped to the caller', () => {
    // The exemption above is only safe if these actions pass the actor's own id into every
    // write. Without that, "no capability needed" would quietly mean "anyone may edit
    // anyone's".
    for (const file of SELF_SCOPED) {
      if (file.includes('/login/')) continue;
      expect(code(file), file).toMatch(/actor\.userId/);
    }
  });

  it('no action trusts a role or company id supplied in the form', () => {
    // Tenancy comes from the session, never from the request body. A form field named
    // `role` or `actorUserId` would let a caller nominate their own authority.
    const offenders: string[] = [];

    for (const file of actionFiles) {
      const matches = code(file).matchAll(/formData\.get\(\s*['"](\w+)['"]\s*\)/g);
      for (const match of matches) {
        const field = match[1] ?? '';
        if (['actorUserId', 'actorRole', 'userRole', 'isAdmin', 'permissions'].includes(field)) {
          offenders.push(`${file}: reads "${field}" from the form`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('no SQL is built by string concatenation (§27)', () => {
  const dataFiles = sourceFiles('src/**/*.ts').filter(
    (file) => file.startsWith('src/db/') || file.startsWith('src/services/') || file.startsWith('src/domain/'),
  );

  it('finds data-access files', () => {
    expect(dataFiles.length).toBeGreaterThan(10);
  });

  it('never concatenates a value into a SQL string', () => {
    const offenders: string[] = [];

    for (const file of dataFiles) {
      const source = code(file);
      // `sql.raw(...)` with anything but a literal, or a template that interpolates into
      // an obvious SQL keyword position via `+`.
      if (/\bsql\.raw\s*\(\s*[^'"`)]/.test(source)) {
        offenders.push(`${file}: sql.raw with a non-literal`);
      }
      if (/(['"])\s*\+\s*\w+\s*\+\s*\1\s*\)?\s*(?:as\s+SQL|;)?\s*$/m.test(source) && /\bselect\b/i.test(source)) {
        offenders.push(`${file}: string concatenation near SQL`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('uses drizzle’s sql template, which parameterises its interpolations', () => {
    // A spot-check that the codebase's raw queries go through the tagged template rather
    // than a plain string handed to the driver.
    const rawQueryFiles = dataFiles.filter((file) => /\bexecute\s*\(/.test(code(file)));
    expect(rawQueryFiles.length).toBeGreaterThan(0);

    for (const file of rawQueryFiles) {
      const source = code(file);
      // Every `.execute(` in these files is immediately followed by a `sql` tagged template.
      const bad = [...source.matchAll(/\.execute(?:<[^>]*>)?\s*\(\s*([^s\s])/g)];
      expect(bad.map((match) => `${file}: execute(${match[1] ?? ''}…)`)).toEqual([]);
    }
  });
});

describe('uploads and documents are constrained (§27)', () => {
  it('the storage layer refuses a key it did not generate', () => {
    const source = read('src/lib/storage/index.ts');
    expect(source).toMatch(/KEY_PATTERN/);
    expect(source).toMatch(/assertWellFormedKey/);
  });

  it('content types are an allow-list, not free text', () => {
    const enums = read('src/db/schema/enums.ts');
    expect(enums).toMatch(/documentContentTypes/);
    // An allow-list means a fixed array, and it must not include an executable type.
    expect(enums).not.toMatch(/'text\/html'/);
    expect(enums).not.toMatch(/'application\/javascript'/);
    expect(enums).not.toMatch(/'image\/svg\+xml'/);
  });

  it('the document route sets nosniff and refuses to cache', () => {
    const source = read('src/app/api/documents/[id]/route.ts');
    expect(source).toMatch(/x-content-type-options.*nosniff/s);
    expect(source).toMatch(/no-store/);
    expect(source).toMatch(/private/);
  });

  it('the document route authorises from the record, not the URL', () => {
    const source = read('src/app/api/documents/[id]/route.ts');
    expect(source).toMatch(/getActor\(\)/);
    expect(source).toMatch(/mayRead/);
    // A document the caller may not read is indistinguishable from one that is absent.
    expect(source).toMatch(/404/);
  });
});

describe('sessions and passwords (§27)', () => {
  it('stores only a hash of the session token', () => {
    const source = read('src/auth/session.ts');
    expect(source).toMatch(/hashSessionToken/);
    expect(source).toMatch(/createHash\(\s*['"]sha256['"]\s*\)/);
  });

  it('uses a modern password hash, never a bare digest', () => {
    const source = code('src/auth/password.ts');
    expect(source).toMatch(/argon2|scrypt/);
    expect(source).not.toMatch(/createHash\(\s*['"]md5['"]/);
    expect(source).not.toMatch(/createHash\(\s*['"]sha1['"]/);
  });

  it('compares secrets in constant time where a comparison is a check', () => {
    const source = code('src/auth/session.ts');
    expect(source).toMatch(/timingSafeEqual/);
  });

  it('sets secure cookie attributes', () => {
    const source = read('src/auth/session.ts');
    expect(source).toMatch(/httpOnly/);
    expect(source).toMatch(/sameSite/);
    expect(source).toMatch(/secure/);
  });
});

describe('a user prompt is never executed as code (§27)', () => {
  it('nothing evaluates a string', () => {
    const offenders = ALL_SOURCE.filter((file) =>
      /\beval\s*\(|\bnew\s+Function\s*\(/.test(code(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('no model output is used to name a function or a tool', () => {
    // The research assistant has no tools; nothing anywhere should be dispatching on a
    // model-supplied name.
    const aiConsumers = ALL_SOURCE.filter((file) => file.startsWith('src/services/'));
    const offenders = aiConsumers.filter((file) =>
      /\bresult\.data\[[^\]]*\]\s*\(|\bdata\.toolName\b|\bdata\.functionName\b/.test(code(file)),
    );
    expect(offenders).toEqual([]);
  });
});
