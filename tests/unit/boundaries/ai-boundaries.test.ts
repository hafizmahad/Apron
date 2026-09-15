import { readFileSync, globSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AI boundary tests (CLAUDE.md §25).
 *
 * The brief lists these individually, so they are asserted individually rather than rolled
 * into one "the AI layer is well behaved" check. Each is a specific way the architecture
 * could rot into something that looks fine and is not:
 *
 *  - an AI module quietly gaining database access;
 *  - the matching prompt being handed the raw provider registry instead of the shortlist
 *    the engine already proved eligible;
 *  - the adapter importing the availability implementation and "helpfully" recomputing
 *    business logic the deterministic layer already owns;
 *  - the research assistant acquiring a tool;
 *  - an unset key silently falling through to some other service.
 *
 * These assert on source, which is cheap and catches the regression at the moment it is
 * written rather than at the moment it matters.
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

/** Strips comments and string literals so a rule cannot trip on prose about itself. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+[^;]*?from\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^;]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

const AI_FILES = sourceFiles('src/ai/**/*.ts');

describe('the AI layer has files to check', () => {
  it('finds the prompt, schema and adapter modules', () => {
    expect(AI_FILES.length).toBeGreaterThan(5);
    expect(AI_FILES).toContain('src/ai/intake/prompt.ts');
    expect(AI_FILES).toContain('src/ai/matching/prompt.ts');
    expect(AI_FILES).toContain('src/ai/research/prompt.ts');
  });
});

describe('AI decision modules perform no database mutation (§25)', () => {
  /** Prompt and schema modules — the parts that decide what the model is asked. */
  const decisionModules = AI_FILES.filter(
    (file) => file.includes('/intake/') || file.includes('/matching/') || file.includes('/research/'),
  );

  it('never imports the database client, schema or drizzle', () => {
    const offenders: string[] = [];

    for (const file of decisionModules) {
      const specifiers = importSpecifiers(read(file));
      const bad = specifiers.filter(
        (specifier) =>
          specifier === 'drizzle-orm' ||
          specifier.startsWith('drizzle-orm/') ||
          specifier === '@/db/client' ||
          specifier.startsWith('@/db/queries'),
      );
      if (bad.length > 0) offenders.push(`${file} -> ${bad.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });

  it('contains no insert, update, delete, upsert or truncate', () => {
    const forbidden = /\b(insert|update|delete|upsert|truncate)\s*\(/i;
    const offenders = decisionModules.filter((file) => forbidden.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it('never imports a queue', () => {
    const offenders = AI_FILES.filter((file) =>
      importSpecifiers(read(file)).some(
        (specifier) => specifier === 'bullmq' || specifier.startsWith('@/jobs'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the matching prompt is given the shortlist, never the registry (§25)', () => {
  const source = read('src/ai/matching/prompt.ts');

  it('accepts candidates and nothing that could be a full provider list', () => {
    // The input type names `candidates`. It must not also accept providers, coverage, or
    // anything else that would let a caller hand over the unfiltered registry.
    expect(source).toContain('readonly candidates:');

    const forbiddenFields = [
      'readonly providers:',
      'readonly allProviders:',
      'readonly providerCompanies:',
      'readonly coverage:',
      'readonly registry:',
    ];
    for (const field of forbiddenFields) {
      expect(source, field).not.toContain(field);
    }
  });

  it('states in the prompt that eligibility is already settled', () => {
    // The instruction is load-bearing: it is what stops the model re-litigating a check it
    // does not have the data to perform.
    expect(source).toMatch(/ALREADY been verified by code/i);
  });

  it('exposes only the computed per-candidate facts the engine chose to share', () => {
    const allowed = new Set([
      'providerCompanyId',
      'displayName',
      'platformRank',
      'spareCapacity',
      'leadTimeMarginMinutes',
      'alreadyServingThisRequest',
      'deterministicScore',
      'deterministicPosition',
    ]);

    const block = /export interface MatchingCandidateInput \{([\s\S]*?)\n\}/.exec(source);
    expect(block).not.toBeNull();

    const fields = [...(block?.[1] ?? '').matchAll(/readonly\s+(\w+)\s*:/g)].map((match) => match[1]!);
    expect(fields.length).toBeGreaterThan(0);

    for (const field of fields) {
      expect(allowed, `unexpected candidate field "${field}"`).toContain(field);
    }
  });
});

describe('the AI adapter does not recompute business logic (§25)', () => {
  const adapterFiles = sourceFiles('src/ai/client/**/*.ts');

  it('never imports the deterministic matching engine', () => {
    const offenders: string[] = [];

    for (const file of adapterFiles) {
      const bad = importSpecifiers(read(file)).filter(
        (specifier) =>
          specifier.startsWith('@/domain/matching') ||
          specifier.startsWith('@/domain/availability') ||
          specifier.startsWith('@/services/matching'),
      );
      if (bad.length > 0) offenders.push(`${file} -> ${bad.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });

  it('never imports the eligibility functions under any name', () => {
    const forbidden = /\b(couldProviderCover|couldResourceCover|rankEligibleProviders)\b/;
    const offenders = adapterFiles.filter((file) => forbidden.test(code(file)));
    expect(offenders).toEqual([]);
  });
});

describe('the research assistant has no tools at all (§25)', () => {
  const promptSource = read('src/ai/research/prompt.ts');
  const serviceSource = read('src/services/research.ts');

  /**
   * §25 asks for the tool count to be asserted "where practical". Here the count is zero,
   * which is stronger than any list: the assistant is a single structured completion over a
   * rendered snapshot, so there is no tool surface to get wrong.
   */
  it('declares no tools in the prompt definition', () => {
    expect(promptSource).not.toMatch(/\btools\s*:/);
    expect(promptSource).not.toMatch(/\bfunction_call\b|\btool_choice\b/);
  });

  it('states its read-only nature in the system prompt', () => {
    expect(promptSource).toMatch(/READ-ONLY/);
    expect(promptSource).toMatch(/no tools and no write access/i);
  });

  it('the research service performs no mutation', () => {
    const forbidden = /\b(insert|update|delete|upsert|truncate)\s*\(/i;
    expect(forbidden.test(code('src/services/research.ts'))).toBe(false);
  });

  it('the research service never imports an offer, assignment or intervention service', () => {
    const bad = importSpecifiers(serviceSource).filter(
      (specifier) =>
        specifier.startsWith('@/services/offers') ||
        specifier.startsWith('@/services/assignments') ||
        specifier.startsWith('@/services/interventions') ||
        specifier.startsWith('@/services/governance'),
    );
    expect(bad).toEqual([]);
  });

  it('never puts passenger contact details into the snapshot', () => {
    // A research prompt is sent to a third party. The snapshot is deliberately built
    // without phone numbers and email addresses, and this is the guard on that.
    const source = code('src/services/research.ts');
    expect(source).not.toMatch(/\bphone\b\s*[,:)]/);
    expect(source).not.toMatch(/passengers\.\w*email/);
  });
});

describe('an absent key never falls through to another service (§25)', () => {
  const clientFiles = sourceFiles('src/ai/**/*.ts');

  it('imports no SDK other than openai', () => {
    const otherProviders = [
      '@anthropic-ai/sdk',
      '@google/generative-ai',
      'cohere-ai',
      '@mistralai/mistralai',
      'groq-sdk',
      'replicate',
      'together-ai',
      'ollama',
    ];

    const offenders: string[] = [];
    for (const file of clientFiles) {
      const specifiers = importSpecifiers(read(file));
      const bad = specifiers.filter((specifier) => otherProviders.includes(specifier));
      if (bad.length > 0) offenders.push(`${file} -> ${bad.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });

  it('makes no network call of its own outside the SDK', () => {
    // A bare fetch inside the AI layer would be a second route to a provider that the
    // adapter's logging, validation and failure handling never sees.
    const offenders = clientFiles
      .filter((file) => !file.endsWith('/scripted.ts'))
      .filter((file) => /\bfetch\s*\(|\bnew\s+XMLHttpRequest\b|\baxios\b/.test(code(file)));

    expect(offenders).toEqual([]);
  });

  it('gates availability on the key being present', () => {
    const source = code('src/ai/client/openai.ts');
    // `isAvailable` must consider the key, not just a flag.
    expect(source).toMatch(/OPENAI_API_KEY/);
  });
});

describe('the production oracle and the eval oracle are the same code (§25)', () => {
  it('the eval suite imports the real prompts, not copies', () => {
    const evalFiles = sourceFiles('tests/evals/**/*.ts');
    expect(evalFiles.length).toBeGreaterThan(0);

    const importsRealPrompts = evalFiles.some((file) =>
      importSpecifiers(read(file)).some((specifier) => specifier.startsWith('@/ai/')),
    );
    expect(importsRealPrompts).toBe(true);
  });

  it('no eval file defines its own system prompt', () => {
    const evalFiles = sourceFiles('tests/evals/**/*.ts');
    const offenders = evalFiles.filter((file) => /\bconst\s+SYSTEM\s*=/.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it('no eval file reimplements an eligibility check', () => {
    const evalFiles = sourceFiles('tests/evals/**/*.ts');
    const offenders = evalFiles.filter((file) =>
      /function\s+(couldProviderCover|rankEligibleProviders|isEligible)\b/.test(code(file)),
    );
    expect(offenders).toEqual([]);
  });
});
