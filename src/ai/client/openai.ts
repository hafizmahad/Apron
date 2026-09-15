import '@/lib/server-guard';
import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ApronError } from '@/lib/errors';
import type { AiStage } from '@/db/schema/enums';
import { getEnv, isAiEnabled } from '@/lib/config/env';
import { logger } from '@/lib/logging';
import type {
  AiAdapter,
  AiFailureReason,
  AiResult,
  PromptDefinition,
  RunStructuredOptions,
} from './types';

/**
 * The OpenAI adapter (CLAUDE.md §23).
 *
 * Uses structured outputs with `strict: true`, so the provider itself enforces the JSON
 * shape before we ever see it. The Zod schema is then applied again on our side — belt
 * and braces, because a provider-side guarantee is not a guarantee we control.
 *
 * Every failure path returns a typed result rather than throwing. A model being
 * unreachable is a normal operating condition for this product, not an exception: the
 * caller's deterministic fallback handles it (CLAUDE.md §22).
 */

let client: OpenAI | undefined;

function getClient(): OpenAI {
  const env = getEnv();
  client ??= new OpenAI({
    apiKey: env.OPENAI_API_KEY ?? '',
    ...(env.OPENAI_BASE_URL === undefined ? {} : { baseURL: env.OPENAI_BASE_URL }),
    timeout: env.OPENAI_TIMEOUT_MS,
    // Retries are handled here rather than by the SDK so each attempt is logged and the
    // total is bounded by OPENAI_MAX_ATTEMPTS (CLAUDE.md §3 "retries must be bounded").
    maxRetries: 0,
  });
  return client;
}

function modelForStage(stage: AiStage): string {
  const env = getEnv();
  switch (stage) {
    case 'intake':
      return env.OPENAI_INTAKE_MODEL ?? '';
    case 'matching':
      return env.OPENAI_REASONING_MODEL ?? '';
    case 'research':
      return env.OPENAI_RESEARCH_MODEL ?? '';
    case 'summary':
      return env.OPENAI_SUMMARY_MODEL ?? '';
  }
}

export const openAiAdapter: AiAdapter = {
  name: 'openai',

  isAvailable(): boolean {
    return isAiEnabled(getEnv());
  },

  modelFor(stage: AiStage): string {
    return modelForStage(stage);
  },

  async run<TInput, TOutput>(
    prompt: PromptDefinition<TInput, TOutput>,
    input: TInput,
    options: RunStructuredOptions,
  ): Promise<AiResult<TOutput>> {
    const env = getEnv();
    const model = options.model ?? modelForStage(prompt.stage);
    const startedAt = Date.now();

    if (!this.isAvailable()) {
      return {
        ok: false,
        reason: 'disabled',
        detail: 'AI is disabled or no API key is configured',
        usage: { provider: 'openai', model, latencyMs: 0 },
      };
    }

    const userMessage = prompt.build(input);
    const jsonSchema = toStrictJsonSchema(prompt);

    let lastFailure: { reason: AiFailureReason; detail: string; raw?: string } = {
      reason: 'unavailable',
      detail: 'No attempt was made',
    };

    for (let attempt = 1; attempt <= env.OPENAI_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await getClient().chat.completions.create(
          {
            model,
            temperature: prompt.temperature ?? 0,
            max_completion_tokens: prompt.maxOutputTokens ?? 2048,
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: userMessage },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: prompt.schemaName, schema: jsonSchema, strict: true },
            },
          },
          options.signal === undefined ? {} : { signal: options.signal },
        );

        const choice = response.choices[0];
        const latencyMs = Date.now() - startedAt;

        if (choice?.finish_reason === 'content_filter') {
          return {
            ok: false,
            reason: 'refused',
            detail: 'The model declined to answer',
            usage: { provider: 'openai', model, latencyMs },
          };
        }

        if (choice?.finish_reason === 'length') {
          // A truncated reply is invalid JSON; retrying the same prompt will truncate
          // again, so fail immediately rather than burning the attempt budget.
          return {
            ok: false,
            reason: 'schema_invalid',
            detail: 'The reply was cut off before it was complete',
            usage: { provider: 'openai', model, latencyMs },
          };
        }

        const content = choice?.message.content;
        if (typeof content !== 'string' || content.length === 0) {
          lastFailure = { reason: 'schema_invalid', detail: 'The model returned no content' };
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          lastFailure = {
            reason: 'schema_invalid',
            detail: 'The model returned text that is not valid JSON',
            raw: content,
          };
          continue;
        }

        const validated = prompt.schema.safeParse(parsed);
        if (!validated.success) {
          lastFailure = {
            reason: 'schema_invalid',
            detail: summariseZodIssues(validated.error.issues),
            raw: content,
          };
          logger().warn(
            { promptId: prompt.id, attempt, issues: validated.error.issues.slice(0, 5) },
            'AI output failed schema validation',
          );
          continue;
        }

        return {
          ok: true,
          data: validated.data,
          usage: { provider: 'openai', model, latencyMs },
        };
      } catch (error) {
        lastFailure = classifyError(error);
        logger().warn(
          { promptId: prompt.id, attempt, reason: lastFailure.reason, detail: lastFailure.detail },
          'AI call attempt failed',
        );
        // A timeout or refusal will not improve on a retry; stop spending the budget.
        if (lastFailure.reason === 'timeout' || lastFailure.reason === 'refused') break;
      }
    }

    return {
      ok: false,
      reason: lastFailure.reason,
      detail: lastFailure.detail,
      usage: { provider: 'openai', model, latencyMs: Date.now() - startedAt },
      ...(lastFailure.raw === undefined ? {} : { rawResponse: lastFailure.raw }),
    };
  },
};

/**
 * OpenAI structured outputs require `additionalProperties: false` on every object and
 * every property listed in `required` — optional properties are expressed as a union
 * with null instead. `zod-to-json-schema` does not do this, so the tree is walked here.
 */
function toStrictJsonSchema<TInput, TOutput>(
  prompt: PromptDefinition<TInput, TOutput>,
): Record<string, unknown> {
  const generated = zodToJsonSchema(prompt.schema, {
    name: prompt.schemaName,
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;

  const definitions = generated['definitions'] as Record<string, unknown> | undefined;
  const root = (definitions?.[prompt.schemaName] ?? generated) as Record<string, unknown>;

  return enforceStrict(root) as Record<string, unknown>;
}

function enforceStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(enforceStrict);
  if (node === null || typeof node !== 'object') return node;

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === '$schema' || key === 'default') continue;
    result[key] = enforceStrict(value);
  }

  if (result['type'] === 'object') {
    if (typeof result['properties'] !== 'object' || result['properties'] === null) {
      // An object with no declared properties is an open-ended map, and strict structured
      // outputs cannot express one: every object must list its keys up front. Left alone
      // this produces a schema the provider rejects with a 400 at the first real call —
      // which is exactly how it escaped into production once. Fail here instead, where the
      // message names the construct and a test can catch it offline.
      throw new ApronError(
        'config_invalid',
        'A prompt schema contains an open-ended object (z.record). OpenAI strict structured ' +
          'outputs require every object to declare its properties. Model it as an array of ' +
          '{ key, value } pairs and transform it back in the schema.',
      );
    }

    result['additionalProperties'] = false;
    // `strict` mode demands that every declared property appears in `required`.
    result['required'] = Object.keys(result['properties'] as Record<string, unknown>);
  }

  return result;
}

/**
 * The JSON schema a prompt sends to the provider.
 *
 * Exported so a test can convert every registered prompt offline and prove the provider
 * would accept it, without spending a call to find out.
 */
export function strictJsonSchemaFor<TInput, TOutput>(
  prompt: PromptDefinition<TInput, TOutput>,
): Record<string, unknown> {
  return toStrictJsonSchema(prompt);
}

function classifyError(error: unknown): { reason: AiFailureReason; detail: string } {
  if (error instanceof OpenAI.APIUserAbortError) {
    return { reason: 'timeout', detail: 'The request was aborted' };
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return { reason: 'timeout', detail: 'The provider did not respond in time' };
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return { reason: 'unavailable', detail: 'Could not reach the provider' };
  }
  if (error instanceof OpenAI.RateLimitError) {
    return { reason: 'unavailable', detail: 'Rate limited by the provider' };
  }
  if (error instanceof OpenAI.APIError) {
    // The status and message are safe; the key never appears in either. The message is
    // included because "Provider error 400" is exactly the generic failure §28 forbids —
    // a 400 is nearly always a schema the provider will not accept, and the reason it
    // gives names the offending field.
    const message = typeof error.message === 'string' ? error.message.slice(0, 300) : '';
    return {
      reason: 'unavailable',
      detail: `Provider error ${error.status ?? 'unknown'}${message === '' ? '' : `: ${message}`}`,
    };
  }
  return {
    reason: 'unavailable',
    detail: error instanceof Error ? error.message : 'Unknown provider failure',
  };
}

/** A short, readable summary — never the whole Zod error, which can be enormous. */
function summariseZodIssues(issues: readonly { path: (string | number)[]; message: string }[]): string {
  return issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Test seam: drops the memoised client so a changed key or base URL takes effect. */
export function resetOpenAiClientForTests(): void {
  client = undefined;
}
