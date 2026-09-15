import { ENGINE_VERSION, evaluateCandidates } from './eligibility';
import type {
  EligibilityInput,
  EligibilityResult,
  MatchingContext,
  MatchingOutcome,
  RankedCandidate,
} from './types';

/**
 * The deterministic ranker (CLAUDE.md §9).
 *
 * Only ELIGIBLE candidates are ranked. Ranking never rescues an ineligible provider and
 * never overrides a rejection — eligibility is a gate, ranking is a preference.
 *
 * Scoring is integer arithmetic throughout. Floats would make the ordering
 * platform-dependent at the margins, and a decision trace that cannot be reproduced
 * exactly is not a trace.
 *
 * The documented order of precedence:
 *
 *   1. hard business priority — spare capacity headroom;
 *   2. same-provider consolidation, so one request means fewer hand-offs;
 *   3. lead-time comfort, banded rather than raw so a few minutes never flips an order;
 *   4. platform rank;
 *   5. deterministic name then id tie-break, so the result is total and stable.
 */

/** Weights are constants, not configuration, so a trace can always be recomputed. */
export const RANKING_WEIGHTS = Object.freeze({
  /** Points per spare unit beyond what the line needs, capped by `capacityHeadroomCap`. */
  capacityHeadroom: 12,
  capacityHeadroomCap: 5,
  /** Flat bonus when this provider already serves another line of the same request. */
  sameProviderConsolidation: 45,
  /** Points per lead-time comfort band (see `leadTimeBand`). */
  leadTimeComfort: 8,
  /** Platform rank contributes at most this much; rank 1 scores it all, rank 1000 none. */
  platformRankMax: 30,
});

/**
 * Lead-time comfort in bands, so a provider is not reordered by a one-minute difference.
 * Bands: under 1h, 1-3h, 3-12h, 12-48h, beyond.
 */
function leadTimeBand(marginMinutes: number | null): number {
  if (marginMinutes === null || marginMinutes < 0) return 0;
  if (marginMinutes < 60) return 1;
  if (marginMinutes < 180) return 2;
  if (marginMinutes < 720) return 3;
  if (marginMinutes < 2880) return 4;
  return 5;
}

/** Rank 1 earns the full allowance, rank 1000 earns none. Integer division throughout. */
function platformRankPoints(rank: number): number {
  const clamped = Math.min(1000, Math.max(1, Math.trunc(rank)));
  return Math.floor(((1000 - clamped) * RANKING_WEIGHTS.platformRankMax) / 999);
}

function scoreCandidate(
  result: EligibilityResult,
  quantity: number,
  platformRank: number,
  sameProviderOnOtherLines: number,
): number {
  const headroom = Math.min(
    RANKING_WEIGHTS.capacityHeadroomCap,
    Math.max(0, result.spareCapacity - quantity),
  );

  return (
    headroom * RANKING_WEIGHTS.capacityHeadroom +
    (sameProviderOnOtherLines > 0 ? RANKING_WEIGHTS.sameProviderConsolidation : 0) +
    leadTimeBand(result.leadTimeMarginMinutes) * RANKING_WEIGHTS.leadTimeComfort +
    platformRankPoints(platformRank)
  );
}

/**
 * Total order over ranked candidates. Every comparison falls through to the id, so two
 * candidates can never compare equal and `Array.sort` stability is irrelevant — the
 * result is identical on every engine and every run.
 */
export function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.spareCapacity !== b.spareCapacity) return b.spareCapacity - a.spareCapacity;
  if (a.rank !== b.rank) return a.rank - b.rank;

  const byName = a.displayName.localeCompare(b.displayName, 'en');
  if (byName !== 0) return byName;

  return a.providerCompanyId.localeCompare(b.providerCompanyId, 'en');
}

/** Rejected candidates are ordered for display: transient causes are more actionable. */
function compareRejected(a: EligibilityResult, b: EligibilityResult): number {
  const byName = a.displayName.localeCompare(b.displayName, 'en');
  if (byName !== 0) return byName;
  return a.providerCompanyId.localeCompare(b.providerCompanyId, 'en');
}

export function rankEligibleProviders(
  input: EligibilityInput,
  results: readonly EligibilityResult[],
): RankedCandidate[] {
  const rankByProvider = new Map(
    input.candidates.map((candidate) => [candidate.providerCompanyId, candidate.rank]),
  );

  const ranked = results
    .filter((result): result is EligibilityResult & { eligible: true } => result.eligible)
    .map((result) => {
      const platformRank = rankByProvider.get(result.providerCompanyId) ?? 500;
      const sameProviderOnOtherLines = countOnOtherLines(
        input.context,
        result.providerCompanyId,
      );
      return {
        ...result,
        eligible: true as const,
        rank: platformRank,
        sameProviderOnOtherLines,
        score: scoreCandidate(result, input.line.quantity, platformRank, sameProviderOnOtherLines),
      };
    });

  return ranked.sort(compareRanked);
}

function countOnOtherLines(context: MatchingContext, providerCompanyId: string): number {
  return context.providersOnOtherLines.filter((id) => id === providerCompanyId).length;
}

/**
 * The single entry point the matching service and the eval suite both call.
 *
 * Returns the full picture: every eligible candidate in deterministic order, every
 * rejected candidate with its reasons, and the deterministic top choice. This is exactly
 * what is persisted as the match trace and exactly what is offered to the model as its
 * (already filtered) option set — the model never sees an ineligible provider.
 */
export function evaluateAndRank(input: EligibilityInput): MatchingOutcome {
  const results = evaluateCandidates(input);
  const eligible = rankEligibleProviders(input, results);
  const rejected = results.filter((result) => !result.eligible).sort(compareRejected);

  return {
    engineVersion: ENGINE_VERSION,
    eligible,
    rejected,
    top: eligible[0] ?? null,
  };
}
