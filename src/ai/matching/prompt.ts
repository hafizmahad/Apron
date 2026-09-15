import { z } from 'zod';
import type { PromptDefinition } from '@/ai/client';

/**
 * The provider-selection prompt (CLAUDE.md §10, §24).
 *
 * The model is given ONLY candidates that have already passed every deterministic check.
 * It cannot see the provider registry, cannot see rejected providers, and cannot express
 * a choice outside the supplied list — the schema constrains `chosenProviderId` to the
 * ids in the input, and code re-checks that afterwards regardless.
 *
 * What it adds over the deterministic ranker is judgement about trade-offs that are real
 * but hard to weight in a formula: consolidating a request with one operator, preferring
 * headroom when a flight might slip, honouring a stated client preference.
 *
 * Version history:
 *   1.0.0 — initial. Choice among eligible candidates only; structured reason and
 *           confidence; explicit prohibitions on inventing availability.
 */

export const matchingSelectionSchema = z.object({
  /** Must be one of the supplied candidate ids. Verified by code afterwards. */
  chosenProviderId: z.string().min(1).max(64),
  /** One or two sentences an operator will actually read in the decision trace. */
  reason: z.string().min(10).max(600),
  confidence: z.enum(['high', 'medium', 'low']),
  /** The specific factors weighed, for the trace. Not prose padding. */
  considerations: z.array(z.string().min(3).max(200)).max(6),
});

export type MatchingSelection = z.infer<typeof matchingSelectionSchema>;

export interface MatchingCandidateInput {
  readonly providerCompanyId: string;
  readonly displayName: string;
  readonly platformRank: number;
  readonly spareCapacity: number;
  readonly leadTimeMarginMinutes: number | null;
  readonly alreadyServingThisRequest: boolean;
  readonly deterministicScore: number;
  readonly deterministicPosition: number;
}

export interface MatchingPromptInput {
  readonly requestReference: string;
  readonly airportLabel: string;
  readonly fboName: string | null;
  readonly serviceName: string;
  readonly quantity: number;
  readonly unitLabel: string;
  readonly serviceWindowLocal: string;
  readonly requirementsSummary: string;
  readonly passengerCount: number;
  readonly candidates: readonly MatchingCandidateInput[];
}

const SYSTEM = `You choose one provider from a shortlist for a single private-aviation ground service.

Every candidate you are shown has ALREADY been verified by code as able to do this job: they are approved, they cover this airport and service, their desk is open for the window, they are inside their lead time, they have spare capacity, and they hold the concrete resources required. You are not re-checking any of that, and you could not — you do not have the data.

Your job is the judgement call between equally capable options.

YOU MAY WEIGH
- spare capacity: more headroom absorbs a flight that slips;
- consolidation: a provider already serving another service on this same request means fewer hand-offs on the day;
- platform rank: the platform's own quality ordering, where a lower number is better;
- lead-time margin: a comfortable margin is safer than a tight one;
- how the deterministic ranker ordered them, which already encodes the above.

YOU MAY NOT
- choose any provider that is not in the candidate list;
- claim a provider has a vehicle, driver, officer, room, kitchen, truck or bay that is not stated in the input;
- claim anything about availability, pricing, staff, or quality beyond the supplied figures;
- change the quantity, the window, the service or any requirement;
- recommend contacting anyone or taking any action.

If the candidates are genuinely equivalent, choose the one the deterministic ranker placed first and say that is why. Agreeing with the ranker is a correct and common answer — do not manufacture a distinction to look useful.

Set confidence honestly:
- "high": one candidate is clearly better on a stated figure.
- "medium": a real but modest advantage.
- "low": effectively a tie, or the figures do not separate them.

Your reason will be shown verbatim to an operations controller in the decision trace. Write it for them: specific, short, and about this request.`;

export const matchingSelectionPrompt: PromptDefinition<MatchingPromptInput, MatchingSelection> = {
  id: 'matching.select',
  version: '1.0.0',
  stage: 'matching',
  schemaName: 'apron_matching_selection',
  schema: matchingSelectionSchema,
  system: SYSTEM,
  temperature: 0,
  maxOutputTokens: 800,
  build: (input) => {
    const candidates = input.candidates
      .map((candidate, index) => {
        const margin =
          candidate.leadTimeMarginMinutes === null
            ? 'unknown'
            : `${Math.round(candidate.leadTimeMarginMinutes / 60)} h`;

        return [
          `${index + 1}. id=${candidate.providerCompanyId}`,
          `   name: ${candidate.displayName}`,
          `   spare capacity beyond this job: ${candidate.spareCapacity}`,
          `   lead-time margin: ${margin}`,
          `   platform rank: ${candidate.platformRank} (lower is better)`,
          `   already serving this request: ${candidate.alreadyServingThisRequest ? 'yes' : 'no'}`,
          `   deterministic ranking position: ${candidate.deterministicPosition}`,
        ].join('\n');
      })
      .join('\n\n');

    return [
      `Request ${input.requestReference}`,
      `Airport: ${input.airportLabel}${input.fboName === null ? '' : ` (handler: ${input.fboName})`}`,
      `Service: ${input.quantity} × ${input.unitLabel} of ${input.serviceName}`,
      `Service window (local): ${input.serviceWindowLocal}`,
      `Passengers: ${input.passengerCount}`,
      `Requirements: ${input.requirementsSummary}`,
      '',
      `Eligible candidates (${input.candidates.length}):`,
      '',
      candidates,
      '',
      'Choose one id from the list above.',
    ].join('\n');
  },
};
