import type { AiStage } from '@/db/schema/enums';
import type {
  AiAdapter,
  AiFailureReason,
  AiResult,
  PromptDefinition,
  RunStructuredOptions,
} from './types';

/**
 * The deterministic scripted adapter (CLAUDE.md §26: "Offline test mode must use scripted
 * AI outputs", ADR-007).
 *
 * This is not a mock in the usual sense — it is a real implementation of `AiAdapter` that
 * the eval suite drives with recorded cases. It runs the same validation the OpenAI
 * adapter does, so a scripted reply that would fail the schema in production also fails
 * here. That is what keeps evals honest.
 *
 * It also makes failure paths testable on demand: a case can script a timeout, a refusal,
 * or malformed JSON and assert that the caller's deterministic fallback actually runs.
 */

export type ScriptedOutcome =
  | { readonly kind: 'data'; readonly value: unknown }
  /** Raw text, so schema-validation failure can be exercised exactly as in production. */
  | { readonly kind: 'raw'; readonly text: string }
  | { readonly kind: 'failure'; readonly reason: AiFailureReason; readonly detail?: string };

export interface ScriptedCall {
  readonly promptId: string;
  readonly outcome: ScriptedOutcome;
  /** Simulated latency, so latency assertions have something to read. */
  readonly latencyMs?: number;
}

export interface ScriptedAdapterOptions {
  /** Consumed in order for matching prompt ids. */
  readonly script?: readonly ScriptedCall[];
  /** Used when the script is exhausted or has no entry for a prompt. */
  readonly fallback?: (promptId: string, input: unknown) => ScriptedOutcome;
  readonly available?: boolean;
  readonly modelName?: string;
}

export interface ScriptedAdapter extends AiAdapter {
  /** Every call made, in order — for asserting what the product actually asked for. */
  readonly calls: readonly { promptId: string; input: unknown }[];
  reset(): void;
}

export function createScriptedAdapter(options: ScriptedAdapterOptions = {}): ScriptedAdapter {
  const remaining = [...(options.script ?? [])];
  const calls: { promptId: string; input: unknown }[] = [];
  const available = options.available ?? true;
  const modelName = options.modelName ?? 'scripted-model';

  return {
    name: 'scripted',
    calls,

    isAvailable(): boolean {
      return available;
    },

    modelFor(_stage: AiStage): string {
      return modelName;
    },

    reset(): void {
      calls.length = 0;
      remaining.length = 0;
      remaining.push(...(options.script ?? []));
    },

    async run<TInput, TOutput>(
      prompt: PromptDefinition<TInput, TOutput>,
      input: TInput,
      _options: RunStructuredOptions,
    ): Promise<AiResult<TOutput>> {
      calls.push({ promptId: prompt.id, input });

      if (!available) {
        return {
          ok: false,
          reason: 'disabled',
          detail: 'Scripted adapter is configured as unavailable',
          usage: { provider: 'scripted', model: modelName, latencyMs: 0 },
        };
      }

      const index = remaining.findIndex((entry) => entry.promptId === prompt.id);
      const entry = index === -1 ? undefined : remaining.splice(index, 1)[0];

      const outcome: ScriptedOutcome =
        entry?.outcome ??
        options.fallback?.(prompt.id, input) ?? {
          kind: 'failure',
          reason: 'unavailable',
          detail: `No scripted outcome for prompt "${prompt.id}"`,
        };

      const usage = {
        provider: 'scripted',
        model: modelName,
        latencyMs: entry?.latencyMs ?? 1,
      };

      if (outcome.kind === 'failure') {
        return {
          ok: false,
          reason: outcome.reason,
          detail: outcome.detail ?? `Scripted ${outcome.reason}`,
          usage,
        };
      }

      // Raw text goes through JSON parsing and schema validation exactly as a real reply
      // would, so a malformed scripted reply fails the same way in tests as in production.
      let candidate: unknown;
      if (outcome.kind === 'raw') {
        try {
          candidate = JSON.parse(outcome.text);
        } catch {
          return {
            ok: false,
            reason: 'schema_invalid',
            detail: 'The scripted reply is not valid JSON',
            usage,
            rawResponse: outcome.text,
          };
        }
      } else {
        candidate = outcome.value;
      }

      const validated = prompt.schema.safeParse(candidate);
      if (!validated.success) {
        return {
          ok: false,
          reason: 'schema_invalid',
          detail: validated.error.issues
            .slice(0, 4)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
          usage,
          rawResponse: JSON.stringify(candidate),
        };
      }

      return { ok: true, data: validated.data, usage };
    },
  };
}

/** An adapter that reports unavailable — the Journey E "AI is down" case. */
export function createUnavailableAdapter(): ScriptedAdapter {
  return createScriptedAdapter({ available: false });
}
