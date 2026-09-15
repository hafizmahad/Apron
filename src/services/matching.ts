import '@/lib/server-guard';
import { eq, sql } from 'drizzle-orm';
import { withTransaction, type Transaction } from '@/db/client';
import { loadEligibilityInput } from '@/db/queries/matching-snapshot';
import {
  airports,
  fbos,
  matchAttempts,
  requestServiceLines,
  requests,
  serviceCategories,
} from '@/db/schema';
import { isAiAvailable, recordVerificationOutcome, runStructured } from '@/ai/client';
import { matchingSelectionPrompt } from '@/ai/matching/prompt';
import { ENGINE_VERSION, evaluateAndRank } from '@/domain/matching';
import type { CandidateSnapshot } from '@/db/schema/matching';
import type { EligibilityInput, MatchingOutcome, RankedCandidate } from '@/domain/matching';
import { ApronError } from '@/lib/errors';
import { logger } from '@/lib/logging';
import { formatOperational } from '@/lib/time';

/**
 * The matching service (CLAUDE.md §10, Phase 5).
 *
 * Lives in `src/services/` rather than `src/domain/matching/` because it ORCHESTRATES:
 * it touches the database, the AI adapter and the pure engine. A boundary test fails the
 * build if anything under `src/domain/matching/` gains such an import, which is what keeps
 * the rules themselves reproducible (ADR-009, ADR-016).
 *
 * The sequence, and why each step exists:
 *
 *  1. **Load** a snapshot of everything relevant, including providers that will be rejected.
 *  2. **Evaluate** with the pure engine. This produces the eligible set and, crucially, the
 *     deterministic top choice — computed BEFORE the model is consulted, so there is always
 *     an answer even if everything after this fails.
 *  3. **Consult** the model, but only with the already-eligible candidates.
 *  4. **Verify** the model's answer in code: is the id one we offered, and is that candidate
 *     still eligible in the same snapshot? An unverifiable answer is discarded.
 *  5. **Record** the whole attempt — every candidate, every reason code, what the model said,
 *     whether verification accepted it, and why the fallback ran if it did.
 *
 * The model can therefore never widen the eligible set, never invent a provider, and never
 * be the reason a request fails: step 2's answer stands if steps 3-4 do not improve on it.
 */

export interface MatchDecision {
  readonly requestServiceLineId: string;
  readonly attemptNumber: number;
  readonly outcome: MatchingOutcome;
  /** Null when nothing was eligible. */
  readonly chosen: RankedCandidate | null;
  readonly selectionSource: 'ai' | 'deterministic';
  /** Shown in the decision trace. */
  readonly reason: string;
  readonly aiConsulted: boolean;
  readonly aiVerified: boolean | null;
  readonly fallbackReason: string | null;
  readonly matchAttemptId: string;
}

export interface RunMatchingOptions {
  /** The instant the engine treats as "now". Supplied by the caller (ADR-009). */
  readonly evaluationNow: Date;
  /** Providers held out: previous declines, manual exclusions. */
  readonly excludedProviderIds?: readonly string[];
  /** Skips the model even when it is available — used by Journey E verification. */
  readonly forceDeterministic?: boolean;
  readonly actorUserId?: string | null;
}

/**
 * Matches one service line and records the attempt.
 *
 * Runs in a transaction so the match attempt and any status change commit together: a
 * trace describing a decision that was rolled back would be worse than no trace.
 */
export async function runMatching(
  requestServiceLineId: string,
  options: RunMatchingOptions,
): Promise<MatchDecision> {
  const input = await loadEligibilityInput(requestServiceLineId, options.evaluationNow, {
    ...(options.excludedProviderIds === undefined
      ? {}
      : { excludedProviderIds: options.excludedProviderIds }),
  });

  // Step 2: the deterministic answer, computed before anything else can go wrong.
  const outcome = evaluateAndRank(input);

  let chosen: RankedCandidate | null = outcome.top;
  let selectionSource: 'ai' | 'deterministic' = 'deterministic';
  let reason = outcome.top === null ? 'No eligible provider' : describeDeterministicChoice(outcome.top);
  let aiConsulted = false;
  let aiVerified: boolean | null = null;
  let aiChosenProviderId: string | null = null;
  let aiConfidence: 'high' | 'medium' | 'low' | null = null;
  let fallbackReason: string | null = null;

  // Step 3: consult the model — but only when there is a genuine choice to make. With one
  // eligible candidate there is nothing to decide and a model call would be pure cost and
  // pure risk.
  const worthConsulting =
    outcome.eligible.length > 1 && isAiAvailable() && options.forceDeterministic !== true;

  if (worthConsulting) {
    aiConsulted = true;
    const promptInput = await buildPromptInput(input, outcome);

    const result = await runStructured(matchingSelectionPrompt, promptInput, {
      requestId: input.context.requestId,
      requestServiceLineId,
      actorUserId: options.actorUserId ?? null,
    });

    if (!result.ok) {
      aiVerified = false;
      fallbackReason = `Model unavailable (${result.reason}); used the deterministic top candidate.`;
      logger().warn(
        { requestServiceLineId, reason: result.reason },
        'matching fell back to the deterministic choice',
      );
    } else {
      aiConfidence = result.data.confidence;

      // The ai_chosen_provider_id column is a foreign key to a real company, so only a
      // value that actually names one of this snapshot's candidates may be stored. A
      // hallucinated id — a plausible UUID for a company that does not exist, or not a
      // UUID at all — would otherwise raise a constraint violation and take down the very
      // match the fallback exists to rescue. The raw value is preserved in fallbackReason.
      aiChosenProviderId = knownCandidateId(result.data.chosenProviderId, outcome);

      // Step 4: verification. Two independent checks.
      const verification = verifySelection(result.data.chosenProviderId, outcome);

      if (verification.ok) {
        aiVerified = true;
        chosen = verification.candidate;
        selectionSource = 'ai';
        reason = result.data.reason;
      } else {
        aiVerified = false;
        fallbackReason = verification.reason;
        logger().warn(
          {
            requestServiceLineId,
            aiChosenProviderId: result.data.chosenProviderId,
            reason: verification.reason,
          },
          'AI selection failed verification; used the deterministic top candidate',
        );
      }
    }
  }

  // Step 5: record the attempt, atomically with the line's selection metadata.
  return withTransaction(async (tx) => {
    const attemptNumber = await nextAttemptNumber(requestServiceLineId, tx);

    const [attempt] = await tx
      .insert(matchAttempts)
      .values({
        requestServiceLineId,
        attemptNumber,
        engineVersion: ENGINE_VERSION,
        evaluationNowUtc: options.evaluationNow,
        eligibleCandidates: outcome.eligible.map(toSnapshot),
        rejectedCandidates: outcome.rejected.map(toSnapshot),
        excludedProviderIds: [...(options.excludedProviderIds ?? [])],
        chosenProviderId: chosen?.providerCompanyId ?? null,
        deterministicTopId: outcome.top?.providerCompanyId ?? null,
        aiConsulted,
        aiChosenProviderId,
        aiVerified,
        aiReason: selectionSource === 'ai' ? reason : null,
        aiConfidence,
        fallbackReason,
      })
      .returning({ id: matchAttempts.id });

    if (attempt === undefined) {
      throw new ApronError('internal', 'The match attempt could not be recorded');
    }

    await tx
      .update(requestServiceLines)
      .set({
        modelExplanation: reason,
        modelVerified: aiVerified,
        selectionSource,
      })
      .where(eq(requestServiceLines.id, requestServiceLineId));

    // Mirror the verdict onto the AI call record so the Admin console can report a
    // verified-false rate without joining through the trace.
    if (aiConsulted) {
      await recordVerificationOutcome(
        { requestServiceLineId, status: aiVerified === true ? 'verified' : 'rejected' },
        tx,
      );
    }

    logger().info(
      {
        requestServiceLineId,
        attemptNumber,
        eligible: outcome.eligible.length,
        rejected: outcome.rejected.length,
        chosen: chosen?.displayName ?? null,
        selectionSource,
        aiConsulted,
        aiVerified,
      },
      'matching completed',
    );

    return {
      requestServiceLineId,
      attemptNumber,
      outcome,
      chosen,
      selectionSource,
      reason,
      aiConsulted,
      aiVerified,
      fallbackReason,
      matchAttemptId: attempt.id,
    };
  });
}

/**
 * Verifies a model selection against the same snapshot the engine evaluated.
 *
 * Two checks, both necessary:
 *  - the id must be one we actually offered (guards against a hallucinated or
 *    remembered-from-training provider);
 *  - that candidate must still be present in the ELIGIBLE list (guards against the model
 *    picking an id it saw in a rejected-candidate context, and against any future change
 *    that widens the prompt input).
 */
export function verifySelection(
  chosenProviderId: string,
  outcome: MatchingOutcome,
):
  | { readonly ok: true; readonly candidate: RankedCandidate }
  | { readonly ok: false; readonly reason: string } {
  const candidate = outcome.eligible.find(
    (item) => item.providerCompanyId === chosenProviderId,
  );

  if (candidate === undefined) {
    const wasRejected = outcome.rejected.some(
      (item) => item.providerCompanyId === chosenProviderId,
    );
    return {
      ok: false,
      reason: wasRejected
        ? `The model chose a provider that had been rejected as ineligible (${chosenProviderId}); used the deterministic top candidate.`
        : `The model returned a provider id that was not offered (${chosenProviderId}); used the deterministic top candidate.`,
    };
  }

  if (!candidate.eligible || candidate.reasonCodes.length > 0) {
    return {
      ok: false,
      reason: `The chosen provider is no longer eligible in this snapshot; used the deterministic top candidate.`,
    };
  }

  return { ok: true, candidate };
}

/** The id if it names a candidate in this snapshot — eligible or rejected — else null. */
function knownCandidateId(candidateId: string, outcome: MatchingOutcome): string | null {
  const known =
    outcome.eligible.some((item) => item.providerCompanyId === candidateId) ||
    outcome.rejected.some((item) => item.providerCompanyId === candidateId);
  return known ? candidateId : null;
}

function describeDeterministicChoice(candidate: RankedCandidate): string {
  const parts: string[] = [];
  if (candidate.sameProviderOnOtherLines > 0) {
    parts.push('already serving another service on this request');
  }
  if (candidate.spareCapacity > 0) {
    parts.push(`${candidate.spareCapacity} spare capacity`);
  }
  parts.push(`platform rank ${candidate.rank}`);

  return `Selected deterministically: ${candidate.displayName} — ${parts.join(', ')}.`;
}

function toSnapshot(candidate: {
  providerCompanyId: string;
  displayName: string;
  eligible: boolean;
  reasonCodes: readonly string[];
  spareCapacity: number;
  leadTimeMarginMinutes: number | null;
}): CandidateSnapshot {
  return {
    providerCompanyId: candidate.providerCompanyId,
    providerName: candidate.displayName,
    rank: 'rank' in candidate ? (candidate as { rank: number }).rank : 0,
    eligible: candidate.eligible,
    reasonCodes: [...candidate.reasonCodes],
    spareCapacity: candidate.spareCapacity,
    leadTimeMarginMinutes: candidate.leadTimeMarginMinutes,
    sameProviderOnOtherLines:
      'sameProviderOnOtherLines' in candidate
        ? (candidate as { sameProviderOnOtherLines: number }).sameProviderOnOtherLines
        : 0,
  };
}

async function nextAttemptNumber(
  requestServiceLineId: string,
  tx: Transaction,
): Promise<number> {
  const result = await tx.execute<{ next: string }>(sql`
    select coalesce(max(attempt_number), 0) + 1 as next
    from match_attempts
    where request_service_line_id = ${requestServiceLineId}::uuid
  `);
  return Number(result.rows[0]?.next ?? 1);
}

/** Builds the model's view: eligible candidates only, with the figures it may weigh. */
async function buildPromptInput(input: EligibilityInput, outcome: MatchingOutcome) {
  const { getDb } = await import('@/db/client');
  const db = getDb();

  const [context] = await db
    .select({
      reference: requests.reference,
      airportName: airports.name,
      airportIcao: airports.icao,
      timezone: airports.timezoneIana,
      fboName: fbos.name,
      serviceName: serviceCategories.name,
      unitLabel: serviceCategories.unitLabel,
    })
    .from(requests)
    .innerJoin(airports, eq(airports.id, requests.airportId))
    .innerJoin(
      serviceCategories,
      eq(serviceCategories.id, sql`${input.line.serviceCategoryId}::uuid`),
    )
    .leftJoin(fbos, eq(fbos.id, requests.fboId))
    .where(eq(requests.id, input.context.requestId))
    .limit(1);

  const window = input.line.serviceWindow;
  const windowLabel =
    window === null
      ? 'not yet determined'
      : `${formatOperational(window.start, input.context.airportTimezone)} — ${formatOperational(window.end, input.context.airportTimezone)}`;

  return {
    requestReference: context?.reference ?? 'unknown',
    airportLabel:
      context === undefined
        ? 'unknown'
        : `${context.airportName}${context.airportIcao === null ? '' : ` (${context.airportIcao})`}`,
    fboName: context?.fboName ?? null,
    serviceName: context?.serviceName ?? input.line.serviceCode,
    quantity: input.line.quantity,
    unitLabel: context?.unitLabel ?? 'unit',
    serviceWindowLocal: windowLabel,
    requirementsSummary: summariseRequirements(input.line.requirements),
    passengerCount: input.context.passengerCount,
    candidates: outcome.eligible.map((candidate, index) => ({
      providerCompanyId: candidate.providerCompanyId,
      displayName: candidate.displayName,
      platformRank: candidate.rank,
      spareCapacity: candidate.spareCapacity,
      leadTimeMarginMinutes: candidate.leadTimeMarginMinutes,
      alreadyServingThisRequest: candidate.sameProviderOnOtherLines > 0,
      deterministicScore: candidate.score,
      deterministicPosition: index + 1,
    })),
  };
}

function summariseRequirements(requirements: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(requirements);
  if (entries.length === 0) return 'none stated';
  return entries
    .slice(0, 8)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}
