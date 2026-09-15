import '@/lib/server-guard';
import { getDb, type Executor } from '@/db/client';
import { aiCalls } from '@/db/schema';
import type { AiOutcome, AiVerificationStatus } from '@/db/schema/enums';
import { getEnv } from '@/lib/config/env';
import { correlationId, logger } from '@/lib/logging';
import { openAiAdapter } from './openai';
import { createScriptedAdapter, type ScriptedAdapter } from './scripted';
import type { AiAdapter, AiResult, PromptDefinition, RunStructuredOptions } from './types';

export * from './types';
export { createScriptedAdapter, createUnavailableAdapter } from './scripted';
export type { ScriptedAdapter, ScriptedCall, ScriptedOutcome } from './scripted';

/**
 * The single entry point for every production model call (ADR-007).
 *
 * Responsibilities:
 *  - select the adapter (OpenAI in production, scripted in tests and evals);
 *  - run the call;
 *  - persist an `ai_calls` row for every attempt, success or failure.
 *
 * The record is written on the failure paths too — that is the whole point. A silent
 * outage would leave the Admin console showing nothing wrong while every request quietly
 * fell back to deterministic selection (CLAUDE.md §28).
 *
 * Per ADR-015 the row carries no token counts and no cost. Stage, prompt version, model,
 * latency, and the validation/verification outcome are what diagnose a failure.
 */

let overrideAdapter: AiAdapter | undefined;

/** Installs a scripted adapter. Tests and evals only. */
export function setAiAdapterForTests(adapter: AiAdapter | undefined): void {
  overrideAdapter = adapter;
}

export function getAiAdapter(): AiAdapter {
  return overrideAdapter ?? openAiAdapter;
}

export function isAiAvailable(): boolean {
  return getAiAdapter().isAvailable();
}

export interface RunOptions extends RunStructuredOptions {
  /** Skips the `ai_calls` write. Used by evals, which record their own results. */
  readonly skipPersistence?: boolean;
  readonly executor?: Executor;
}

/**
 * Runs a versioned prompt and records the outcome.
 *
 * Never throws for a provider problem: the caller receives a typed failure and takes its
 * deterministic path. It can still throw for a genuine programming error, which should
 * surface loudly.
 */
export async function runStructured<TInput, TOutput>(
  prompt: PromptDefinition<TInput, TOutput>,
  input: TInput,
  options: RunOptions = {},
): Promise<AiResult<TOutput>> {
  const adapter = getAiAdapter();
  const result = await adapter.run(prompt, input, options);

  if (options.skipPersistence !== true) {
    await recordAiCall(prompt, input, result, options).catch((error: unknown) => {
      // Persisting the record must never break the caller's flow, but it must be visible.
      logger().error({ err: error, promptId: prompt.id }, 'failed to record the AI call');
    });
  }

  if (result.ok) {
    logger().info(
      { promptId: prompt.id, version: prompt.version, model: result.usage.model, latencyMs: result.usage.latencyMs },
      'AI call succeeded',
    );
  } else {
    logger().warn(
      { promptId: prompt.id, version: prompt.version, reason: result.reason, detail: result.detail },
      'AI call did not produce usable output',
    );
  }

  return result;
}

/** Maps an adapter result to the `ai_calls` outcome vocabulary. */
function toOutcome<T>(result: AiResult<T>): AiOutcome {
  if (result.ok) return 'success';
  switch (result.reason) {
    case 'disabled':
      return 'unavailable';
    case 'unavailable':
      return 'unavailable';
    case 'timeout':
      return 'timeout';
    case 'schema_invalid':
      return 'schema_invalid';
    case 'refused':
      return 'refused';
  }
}

async function recordAiCall<TInput, TOutput>(
  prompt: PromptDefinition<TInput, TOutput>,
  input: TInput,
  result: AiResult<TOutput>,
  options: RunOptions,
): Promise<void> {
  const env = getEnv();
  const executor = options.executor ?? getDb();
  const outcome = toOutcome(result);

  // Prompt and response bodies may contain client and passenger data, so they are stored
  // only when explicitly enabled (CLAUDE.md §23).
  const storeBodies = env.AI_STORE_PROMPT_BODIES;

  await executor.insert(aiCalls).values({
    stage: prompt.stage,
    promptId: prompt.id,
    promptVersion: prompt.version,
    provider: result.usage.provider,
    model: result.usage.model,
    latencyMs: result.usage.latencyMs,
    outcome,
    validationStatus: result.ok ? 'valid' : result.reason === 'schema_invalid' ? 'invalid' : 'not_applicable',
    // Verification happens after this call, in the caller. `updateAiCallVerification`
    // fills it in once code has checked the model's answer.
    verificationStatus: null,
    errorCategory: result.ok ? null : result.reason,
    errorDetail: result.ok ? null : result.detail.slice(0, 2000),
    requestId: options.requestId ?? null,
    requestServiceLineId: options.requestServiceLineId ?? null,
    actorUserId: options.actorUserId ?? null,
    correlationId: correlationId(),
    promptBody: storeBodies ? safeBody(prompt.build(input)) : null,
    responseBody: storeBodies ? safeBody(responseBodyOf(result)) : null,
  });
}

function responseBodyOf<T>(result: AiResult<T>): string | null {
  if (result.ok) return JSON.stringify(result.data);
  return result.rawResponse ?? null;
}

/** Caps stored bodies so one oversized prompt cannot bloat the table. */
function safeBody(body: string | null): string | null {
  if (body === null) return null;
  return body.length > 20_000 ? `${body.slice(0, 20_000)}… [truncated]` : body;
}

/**
 * Records whether code accepted the model's answer.
 *
 * Called by the matching service after verification, so the Admin console can report a
 * `verified=false` rate — the number that actually matters about model quality here
 * (CLAUDE.md §10, §14).
 */
export async function recordVerificationOutcome(
  input: {
    readonly requestServiceLineId: string;
    readonly status: AiVerificationStatus;
  },
  executor: Executor = getDb(),
): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await executor.execute(sql`
    update ai_calls
    set verification_status = ${input.status},
        outcome = case
          when ${input.status} = 'rejected' and outcome = 'success' then 'verification_failed'
          else outcome
        end,
        error_category = case
          when ${input.status} = 'rejected' and error_category is null then 'verification_failed'
          else error_category
        end
    where id = (
      select id from ai_calls
      where request_service_line_id = ${input.requestServiceLineId}::uuid
        and stage = 'matching'
      order by occurred_at desc, id desc
      limit 1
    )
  `);
}

/** Convenience for tests: installs a scripted adapter and returns it. */
export function installScriptedAdapter(
  ...args: Parameters<typeof createScriptedAdapter>
): ScriptedAdapter {
  const adapter = createScriptedAdapter(...args);
  setAiAdapterForTests(adapter);
  return adapter;
}
