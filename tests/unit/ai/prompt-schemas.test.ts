import { describe, expect, it } from 'vitest';
import { strictJsonSchemaFor } from '@/ai/client/openai';
import { intakeExtractionPrompt } from '@/ai/intake/prompt';
import { matchingSelectionPrompt } from '@/ai/matching/prompt';
import { researchPrompt } from '@/ai/research/prompt';
import type { PromptDefinition } from '@/ai/client/types';

/**
 * Every prompt's schema must be one OpenAI's strict structured outputs will accept
 * (CLAUDE.md §24: "Prompts are code … have tests").
 *
 * This suite exists because of a real escape. `intakeServiceSchema.requirements` was a
 * `z.record()`, which generates an object with no declared properties. Strict mode cannot
 * express an open-ended map, so the provider answered **400 Invalid schema** — and because
 * the adapter degrades on any provider error, intake quietly fell back to the deterministic
 * extractor on every single call. Nothing failed. The product simply never used the model
 * for intake, and no test noticed because the scripted adapter does not convert schemas.
 *
 * The rules below are OpenAI's published requirements for `strict: true`. Checking them
 * offline costs nothing and turns a silent production degradation into a failed unit test.
 */

const PROMPTS: readonly PromptDefinition<never, unknown>[] = [
  intakeExtractionPrompt,
  matchingSelectionPrompt,
  researchPrompt,
] as unknown as readonly PromptDefinition<never, unknown>[];

interface Violation {
  readonly path: string;
  readonly problem: string;
}

/** Walks the converted schema and collects every strict-mode violation. */
function findViolations(node: unknown, path = '$'): Violation[] {
  if (Array.isArray(node)) {
    return node.flatMap((entry, index) => findViolations(entry, `${path}[${String(index)}]`));
  }
  if (node === null || typeof node !== 'object') return [];

  const schema = node as Record<string, unknown>;
  const violations: Violation[] = [];

  if (schema['type'] === 'object') {
    const properties = schema['properties'];

    if (typeof properties !== 'object' || properties === null) {
      violations.push({
        path,
        problem: 'object declares no properties — strict mode cannot express an open map',
      });
    } else {
      const keys = Object.keys(properties as Record<string, unknown>);
      const required = schema['required'];

      if (!Array.isArray(required)) {
        violations.push({ path, problem: 'object has no `required` array' });
      } else {
        const missing = keys.filter((key) => !required.includes(key));
        const extra = required.filter(
          (key): key is string => typeof key === 'string' && !keys.includes(key),
        );

        if (missing.length > 0) {
          violations.push({
            path,
            problem: `properties not listed in required: ${missing.join(', ')}`,
          });
        }
        if (extra.length > 0) {
          violations.push({
            path,
            problem: `required names keys that are not properties: ${extra.join(', ')}`,
          });
        }
      }

      if (schema['additionalProperties'] !== false) {
        violations.push({ path, problem: 'additionalProperties is not false' });
      }
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'required' || key === 'enum') continue;
    violations.push(...findViolations(value, `${path}.${key}`));
  }

  return violations;
}

describe('every prompt schema is one the provider will accept', () => {
  it('converts without throwing', () => {
    for (const prompt of PROMPTS) {
      expect(() => strictJsonSchemaFor(prompt), prompt.id).not.toThrow();
    }
  });

  for (const prompt of PROMPTS) {
    it(`${prompt.id} satisfies every strict-mode rule`, () => {
      const schema = strictJsonSchemaFor(prompt);
      const violations = findViolations(schema);

      expect(
        violations.map((violation) => `${violation.path}: ${violation.problem}`),
      ).toEqual([]);
    });
  }

  it('gives each prompt a distinct id, version and schema name', () => {
    expect(new Set(PROMPTS.map((prompt) => prompt.id)).size).toBe(PROMPTS.length);
    expect(new Set(PROMPTS.map((prompt) => prompt.schemaName)).size).toBe(PROMPTS.length);
    for (const prompt of PROMPTS) {
      expect(prompt.version, prompt.id).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('names schemas the way the provider requires', () => {
    // Letters, digits, underscores and dashes, 1-64 characters.
    for (const prompt of PROMPTS) {
      expect(prompt.schemaName, prompt.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });
});

describe('the guard that catches an open-ended object', () => {
  it('throws with a message naming the construct and the fix', async () => {
    const { z } = await import('zod');

    const offending = {
      id: 'test.open_record',
      version: '1.0.0',
      stage: 'intake' as const,
      system: 'test',
      schemaName: 'open_record',
      schema: z.object({ anything: z.record(z.string(), z.string()) }),
      build: () => 'test',
    } as unknown as PromptDefinition<never, unknown>;

    expect(() => strictJsonSchemaFor(offending)).toThrow(/open-ended object/i);
    expect(() => strictJsonSchemaFor(offending)).toThrow(/key, value/i);
  });
});
