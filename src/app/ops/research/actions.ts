'use server';

import '@/lib/server-guard';
import { z } from 'zod';
import { requireActor } from '@/auth/context';
import { can } from '@/domain/permissions';
import { askAboutRequest } from '@/services/research';
import { ApronError } from '@/lib/errors';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * The research assistant action (CLAUDE.md §12, Journey F).
 *
 * Read-only in every sense: it performs no mutation, and the service it calls has no tool
 * that could. The only thing this action writes is the `ai_calls` record the adapter keeps.
 */

const askSchema = z.object({
  requestId: z.string().uuid(),
  question: z.string().trim().min(3, 'Ask a question of at least a few words').max(1000),
});

export interface ResearchState {
  readonly status: 'idle' | 'answered' | 'unavailable' | 'error';
  readonly question?: string;
  readonly answer?: string;
  readonly answeredFromContext?: boolean;
  readonly actionRequested?: boolean;
  readonly citedFacts?: readonly string[];
  readonly message?: string;
}

export async function askResearchAction(
  _previous: ResearchState,
  formData: FormData,
): Promise<ResearchState> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'ops/research' }, async () => {
    try {
      const actor = await requireActor();

      if (!can(actor, 'request.use_research_assistant')) {
        throw new ApronError('forbidden', 'Your role cannot use the research assistant');
      }

      const parsed = askSchema.safeParse({
        requestId: formData.get('requestId'),
        question: formData.get('question'),
      });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Ask a clearer question.',
        };
      }

      const limit = await checkRateLimit({
        key: `research:${actor.userId}`,
        limit: 40,
        windowSeconds: 600,
      });
      if (!limit.allowed) {
        return {
          status: 'error',
          question: parsed.data.question,
          message: 'Too many questions in a short time. Try again shortly.',
        };
      }

      const result = await askAboutRequest(parsed.data.requestId, parsed.data.question, {
        actorUserId: actor.userId,
      });

      if (result.kind === 'unavailable' || result.answer === null) {
        return {
          status: 'unavailable',
          question: parsed.data.question,
          message: result.unavailableReason ?? 'The assistant is unavailable.',
        };
      }

      return {
        status: 'answered',
        question: parsed.data.question,
        answer: result.answer.answer,
        answeredFromContext: result.answer.answeredFromContext,
        actionRequested: result.answer.actionRequested,
        citedFacts: result.answer.citedFacts,
      };
    } catch (error) {
      logError('research question failed', error);
      return {
        status: 'error',
        message:
          error instanceof ApronError ? error.publicMessage : 'The assistant could not answer.',
      };
    }
  });
}
