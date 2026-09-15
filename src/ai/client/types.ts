import type { z } from 'zod';
import type { AiStage } from '@/db/schema/enums';

/**
 * The one narrow AI interface the whole product depends on (ADR-007, CLAUDE.md §23).
 *
 * Product code never imports the OpenAI SDK. It calls `runStructured` and receives either
 * a schema-validated result or a typed failure — which is what makes "AI is unavailable"
 * an ordinary, handled branch rather than an exception that bubbles into a 500.
 *
 * Adding a second provider later is a new file implementing `AiAdapter`. Nothing else
 * changes, because nothing else knows OpenAI exists.
 *
 * Per ADR-015, `usage` reports `{ provider, model, latencyMs }` and nothing more. There
 * is no token accounting and no cost estimation anywhere in this codebase.
 */

export interface AiUsage {
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
}

/** Why a call did not produce usable structured output. */
export type AiFailureReason =
  /** AI_ENABLED is false, or no key is configured. Not an error — a configuration state. */
  | 'disabled'
  /** The provider was unreachable, rate-limited, or returned a server error. */
  | 'unavailable'
  /** The call exceeded OPENAI_TIMEOUT_MS. */
  | 'timeout'
  /** The model returned prose, or JSON that failed schema validation. */
  | 'schema_invalid'
  /** The model declined to answer. */
  | 'refused';

export type AiResult<T> =
  | { readonly ok: true; readonly data: T; readonly usage: AiUsage }
  | {
      readonly ok: false;
      readonly reason: AiFailureReason;
      /** Safe to log and to show an operator. Never contains a key or a raw prompt. */
      readonly detail: string;
      readonly usage: AiUsage;
      /** Present when the model replied but the reply failed validation. */
      readonly rawResponse?: string;
    };

/**
 * A versioned prompt (CLAUDE.md §24: "Prompts are code").
 *
 * `system` holds the stable instructions and is the part that is reviewed and tested.
 * `build` turns the caller's typed input into the volatile user message. Keeping them
 * apart is what lets the system half be diffed meaningfully between versions.
 */
export interface PromptDefinition<TInput, TOutput> {
  readonly id: string;
  /** Bump on any change to `system`, the schema, or the meaning of the output. */
  readonly version: string;
  readonly stage: AiStage;
  readonly system: string;
  /**
   * The output schema.
   *
   * The parsed type is pinned; the *input* type is deliberately left open, so a schema may
   * transform on the way in. That is what lets a wire format the provider can express —
   * a list of key/value pairs, say — become the record the domain works with, without the
   * domain learning about the provider's limitations.
   */
  readonly schema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  /** A short, stable name for the structured output, required by the provider. */
  readonly schemaName: string;
  readonly build: (input: TInput) => string;
  /** Lower is more deterministic. Intake and matching use 0. */
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface RunStructuredOptions {
  /** Ties the call to a request line in `ai_calls` and in the logs. */
  readonly requestId?: string | null;
  readonly requestServiceLineId?: string | null;
  readonly actorUserId?: string | null;
  /** Overrides the model the stage would otherwise use. Rarely needed. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface AiAdapter {
  readonly name: string;
  /** False when no key is configured, so callers can skip work entirely. */
  isAvailable(): boolean;
  /** The model this stage will use, for logging before the call is made. */
  modelFor(stage: AiStage): string;
  run<TInput, TOutput>(
    prompt: PromptDefinition<TInput, TOutput>,
    input: TInput,
    options: RunStructuredOptions,
  ): Promise<AiResult<TOutput>>;
}
