import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createScriptedAdapter, createUnavailableAdapter } from '@/ai/client/scripted';
import type { PromptDefinition } from '@/ai/client/types';

/**
 * The AI adapter contract (CLAUDE.md §22, §25).
 *
 * The scripted adapter is what the eval suite and the offline tests run against, so it
 * has to behave exactly like the real one on every failure path. These tests pin that:
 * malformed JSON, a schema mismatch, a refusal and an outage must all produce typed
 * results, never exceptions — because the whole degradation strategy depends on callers
 * being able to branch on them.
 */

const schema = z.object({
  airportToken: z.string().nullable(),
  passengers: z.number().int().nullable(),
});

const prompt: PromptDefinition<{ sentence: string }, z.infer<typeof schema>> = {
  id: 'test.extract',
  version: '1.0.0',
  stage: 'intake',
  schemaName: 'test_extraction',
  schema,
  system: 'Extract fields.',
  build: (input) => input.sentence,
};

describe('a successful call', () => {
  it('returns validated data and usage', async () => {
    const adapter = createScriptedAdapter({
      script: [
        {
          promptId: 'test.extract',
          outcome: { kind: 'data', value: { airportToken: 'Teterboro', passengers: 4 } },
          latencyMs: 120,
        },
      ],
    });

    const result = await adapter.run(prompt, { sentence: 'four to Teterboro' }, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.airportToken).toBe('Teterboro');
    expect(result.data.passengers).toBe(4);
    expect(result.usage.latencyMs).toBe(120);
    expect(result.usage.provider).toBe('scripted');
  });

  it('reports usage without any token or cost field (ADR-015)', async () => {
    const adapter = createScriptedAdapter({
      script: [
        { promptId: 'test.extract', outcome: { kind: 'data', value: { airportToken: null, passengers: null } } },
      ],
    });

    const result = await adapter.run(prompt, { sentence: 'anything' }, {});
    expect(result.usage).toEqual({ provider: 'scripted', model: 'scripted-model', latencyMs: 1 });
    expect(Object.keys(result.usage).sort()).toEqual(['latencyMs', 'model', 'provider']);
  });

  it('records what the product actually asked for', async () => {
    const adapter = createScriptedAdapter({
      script: [
        { promptId: 'test.extract', outcome: { kind: 'data', value: { airportToken: null, passengers: null } } },
      ],
    });

    await adapter.run(prompt, { sentence: 'landing at Teterboro' }, {});
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.promptId).toBe('test.extract');
    expect(adapter.calls[0]?.input).toEqual({ sentence: 'landing at Teterboro' });
  });
});

describe('failure paths never throw', () => {
  it('reports malformed JSON as schema_invalid and keeps the raw reply', async () => {
    const adapter = createScriptedAdapter({
      script: [{ promptId: 'test.extract', outcome: { kind: 'raw', text: 'I think it is Teterboro.' } }],
    });

    const result = await adapter.run(prompt, { sentence: 'x' }, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('schema_invalid');
    expect(result.rawResponse).toBe('I think it is Teterboro.');
  });

  it('reports a well-formed reply that violates the schema', async () => {
    const adapter = createScriptedAdapter({
      script: [
        {
          promptId: 'test.extract',
          // `passengers` must be an integer; "four" is the classic model slip.
          outcome: { kind: 'raw', text: '{"airportToken":"Teterboro","passengers":"four"}' },
        },
      ],
    });

    const result = await adapter.run(prompt, { sentence: 'x' }, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('schema_invalid');
    expect(result.detail).toMatch(/passengers/);
  });

  it('reports an extra field as a violation rather than silently keeping it', async () => {
    const adapter = createScriptedAdapter({
      script: [
        {
          promptId: 'test.extract',
          outcome: { kind: 'data', value: { airportToken: 'KTEB', passengers: 2, icao: 'KTEB' } },
        },
      ],
    });

    const result = await adapter.run(prompt, { sentence: 'x' }, {});
    // Zod strips unknown keys by default, so this succeeds — but the extra field must not
    // survive into the product's data.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.data).sort()).toEqual(['airportToken', 'passengers']);
  });

  it.each(['timeout', 'refused', 'unavailable'] as const)('reports a scripted %s', async (reason) => {
    const adapter = createScriptedAdapter({
      script: [{ promptId: 'test.extract', outcome: { kind: 'failure', reason } }],
    });

    const result = await adapter.run(prompt, { sentence: 'x' }, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
  });

  it('reports "disabled" when the adapter is unavailable', async () => {
    const adapter = createUnavailableAdapter();
    expect(adapter.isAvailable()).toBe(false);

    const result = await adapter.run(prompt, { sentence: 'x' }, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('disabled');
  });

  it('reports a missing script entry rather than inventing an answer', async () => {
    const adapter = createScriptedAdapter({ script: [] });
    const result = await adapter.run(prompt, { sentence: 'x' }, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unavailable');
    expect(result.detail).toMatch(/No scripted outcome/);
  });
});

describe('script ordering', () => {
  it('consumes entries in order for repeated calls to the same prompt', async () => {
    const adapter = createScriptedAdapter({
      script: [
        { promptId: 'test.extract', outcome: { kind: 'data', value: { airportToken: 'first', passengers: 1 } } },
        { promptId: 'test.extract', outcome: { kind: 'data', value: { airportToken: 'second', passengers: 2 } } },
      ],
    });

    const first = await adapter.run(prompt, { sentence: 'a' }, {});
    const second = await adapter.run(prompt, { sentence: 'b' }, {});

    expect(first.ok && first.data.airportToken).toBe('first');
    expect(second.ok && second.data.airportToken).toBe('second');
  });

  it('falls back once the script is exhausted', async () => {
    const adapter = createScriptedAdapter({
      script: [],
      fallback: () => ({ kind: 'data', value: { airportToken: 'fallback', passengers: null } }),
    });

    const result = await adapter.run(prompt, { sentence: 'a' }, {});
    expect(result.ok && result.data.airportToken).toBe('fallback');
  });

  it('reset restores the original script', async () => {
    const adapter = createScriptedAdapter({
      script: [
        { promptId: 'test.extract', outcome: { kind: 'data', value: { airportToken: 'only', passengers: null } } },
      ],
    });

    await adapter.run(prompt, { sentence: 'a' }, {});
    const exhausted = await adapter.run(prompt, { sentence: 'b' }, {});
    expect(exhausted.ok).toBe(false);

    adapter.reset();
    const restored = await adapter.run(prompt, { sentence: 'c' }, {});
    expect(restored.ok && restored.data.airportToken).toBe('only');
  });
});
