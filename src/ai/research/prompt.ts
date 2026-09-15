import { z } from 'zod';
import type { PromptDefinition } from '@/ai/client';

/**
 * The operations research assistant (CLAUDE.md §12, §26 Journey F).
 *
 * READ-ONLY by construction, and in three independent ways:
 *
 *  1. It is given a snapshot of one request and its decision trace as TEXT. It has no
 *     tools, no database handle, and no way to reach one.
 *  2. Its output schema has no action field. There is nothing for it to emit that any
 *     caller could interpret as an instruction.
 *  3. The system prompt tells it plainly that it cannot act, so a user asking it to "book
 *     them anyway" gets an honest refusal rather than a hallucinated confirmation.
 *
 * `answeredFromContext` is the important flag: when the snapshot does not contain the
 * answer the assistant must say so, and the UI renders that differently from a real answer
 * (§22: "never claim an action occurred unless represented in database state").
 *
 * Version history:
 *   1.0.0 — initial. Context-only answers, explicit no-action refusal, missing-data flag.
 */

export const researchAnswerSchema = z.object({
  answer: z.string().min(1).max(2000),
  /** False when the snapshot does not hold what was asked. */
  answeredFromContext: z.boolean(),
  /** The parts of the snapshot relied on, so a controller can check the reasoning. */
  citedFacts: z.array(z.string().min(3).max(300)).max(6),
  /** True when the question asked for an action rather than information. */
  actionRequested: z.boolean(),
});

export type ResearchAnswer = z.infer<typeof researchAnswerSchema>;

export interface ResearchPromptInput {
  readonly question: string;
  /** A rendered snapshot of the request, its lines, offers and decision trace. */
  readonly snapshot: string;
}

const SYSTEM = `You answer questions about ONE private-aviation ground-services request, for an operations controller who is looking at the same data you are.

WHAT YOU HAVE
A snapshot of the request: its flight details, each service line, every provider offer, and the complete decision trace showing which providers were considered and why each was rejected. That snapshot is the ONLY thing you know.

WHAT YOU MUST DO
- Answer strictly from the snapshot. Quote the specific facts you used in citedFacts.
- When the snapshot does not contain the answer, set answeredFromContext to false and say plainly what is missing. "The platform does not hold that" is a good answer. A guess is not.
- Be specific and brief. The controller can see the same screen; they want the reasoning, not a summary of what they can already read.
- When asked why a provider was rejected, quote the actual reason codes from the trace.

WHAT YOU CANNOT DO
You are READ-ONLY. You cannot book, assign, acknowledge, decline, cancel, override, contact anyone, or change anything at all. You have no tools and no write access of any kind.

If the question asks you to perform an action — "book them anyway", "assign the car", "call the provider", "override this" — set actionRequested to true and explain, without apology, that you can only answer questions, and that the controller can do it themselves from the request page. Never imply that you have done it, are doing it, or will do it.

NEVER invent a provider, a vehicle, a driver, a time, a price, a capacity or an availability that is not in the snapshot. If you find yourself about to write a fact you cannot point at, stop and set answeredFromContext to false instead.`;

export const researchPrompt: PromptDefinition<ResearchPromptInput, ResearchAnswer> = {
  id: 'research.answer',
  version: '1.0.0',
  stage: 'research',
  schemaName: 'apron_research_answer',
  schema: researchAnswerSchema,
  system: SYSTEM,
  temperature: 0,
  maxOutputTokens: 1200,
  build: (input) =>
    [
      'REQUEST SNAPSHOT',
      '================',
      input.snapshot,
      '',
      'QUESTION',
      '========',
      input.question,
    ].join('\n'),
};
