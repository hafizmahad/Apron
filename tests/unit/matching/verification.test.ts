import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { emptyProviderResources, evaluateAndRank } from '@/domain/matching';
import { verifySelection } from '@/services/matching';
import {
  makeCandidate,
  makeContext,
  makeCoverage,
  makeDriver,
  makeLine,
  makeVehicle,
} from '../../helpers/matching';

/**
 * AI selection verification (CLAUDE.md §10 "Verification", Journey E).
 *
 * This is the guarantee that makes it safe to let a model choose at all: whatever it
 * returns, code checks the answer against the same snapshot the engine evaluated, and an
 * answer that does not survive is discarded in favour of the deterministic top candidate.
 *
 * The property test at the end is the important one — for ANY string the model could
 * possibly emit, verification either returns a genuinely eligible candidate or refuses.
 * There is no third outcome.
 */

function eligible(id: string, rank = 200) {
  return makeCandidate({
    providerCompanyId: id,
    displayName: `Provider ${id}`,
    rank,
    coverage: makeCoverage({ totalCapacity: 4 }),
    resources: {
      ...emptyProviderResources,
      vehicles: [makeVehicle({ providerCompanyId: id })],
      drivers: [makeDriver({ providerCompanyId: id })],
    },
  });
}

function outcomeWith(
  candidates: ReturnType<typeof eligible>[],
  extra: ReturnType<typeof makeCandidate>[] = [],
) {
  return evaluateAndRank({
    context: makeContext(),
    line: makeLine(),
    candidates: [...candidates, ...extra],
  });
}

describe('a valid selection is accepted', () => {
  it('accepts an id from the eligible list', () => {
    const outcome = outcomeWith([eligible('alpha'), eligible('bravo')]);
    const result = verifySelection('bravo', outcome);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.providerCompanyId).toBe('bravo');
    expect(result.candidate.eligible).toBe(true);
  });

  it('accepts a candidate that is not the deterministic top choice', () => {
    // The whole point of consulting the model is that it may differ. Verification checks
    // eligibility, not agreement.
    const outcome = outcomeWith([eligible('best', 100), eligible('second', 900)]);
    expect(outcome.top?.providerCompanyId).toBe('best');

    const result = verifySelection('second', outcome);
    expect(result.ok).toBe(true);
  });
});

describe('an invalid selection is refused', () => {
  it('refuses an id that was never offered', () => {
    const outcome = outcomeWith([eligible('alpha')]);
    const result = verifySelection('some-provider-it-invented', outcome);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not offered/);
  });

  it('refuses an id belonging to a REJECTED candidate, and says so specifically', () => {
    const outcome = outcomeWith(
      [eligible('alpha')],
      [makeCandidate({ providerCompanyId: 'suspended-one', status: 'suspended' })],
    );

    expect(outcome.rejected.some((c) => c.providerCompanyId === 'suspended-one')).toBe(true);

    const result = verifySelection('suspended-one', outcome);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The distinct message matters: this is the failure mode worth spotting in the logs.
    expect(result.reason).toMatch(/rejected as ineligible/);
  });

  it('refuses an empty string', () => {
    const outcome = outcomeWith([eligible('alpha')]);
    expect(verifySelection('', outcome).ok).toBe(false);
  });

  it('refuses when nothing was eligible at all', () => {
    const outcome = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates: [makeCandidate({ providerCompanyId: 'pending-one', status: 'pending' })],
    });

    expect(outcome.top).toBeNull();
    expect(verifySelection('pending-one', outcome).ok).toBe(false);
  });

  it('is case-sensitive — a near-miss id is not accepted', () => {
    const outcome = outcomeWith([eligible('alpha')]);
    expect(verifySelection('Alpha', outcome).ok).toBe(false);
    expect(verifySelection('alpha ', outcome).ok).toBe(false);
  });
});

describe('verification is total', () => {
  it('for ANY string, either returns a genuinely eligible candidate or refuses', () => {
    const outcome = outcomeWith(
      [eligible('alpha'), eligible('bravo'), eligible('charlie')],
      [
        makeCandidate({ providerCompanyId: 'suspended-one', status: 'suspended' }),
        makeCandidate({ providerCompanyId: 'pending-one', status: 'pending' }),
      ],
    );

    const eligibleIds = new Set(outcome.eligible.map((c) => c.providerCompanyId));

    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (candidateId) => {
        const result = verifySelection(candidateId, outcome);

        if (result.ok) {
          // An accepted answer is always genuinely eligible, with no reason codes.
          expect(eligibleIds.has(result.candidate.providerCompanyId)).toBe(true);
          expect(result.candidate.eligible).toBe(true);
          expect(result.candidate.reasonCodes).toEqual([]);
          expect(result.candidate.providerCompanyId).toBe(candidateId);
        } else {
          // A refusal always explains itself, and never refuses a genuinely eligible id.
          expect(eligibleIds.has(candidateId)).toBe(false);
          expect(result.reason.length).toBeGreaterThan(10);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('accepts exactly the eligible ids and nothing else', () => {
    const outcome = outcomeWith(
      [eligible('alpha'), eligible('bravo')],
      [makeCandidate({ providerCompanyId: 'rejected-one', active: false })],
    );

    for (const candidate of outcome.eligible) {
      expect(verifySelection(candidate.providerCompanyId, outcome).ok).toBe(true);
    }
    for (const candidate of outcome.rejected) {
      expect(verifySelection(candidate.providerCompanyId, outcome).ok).toBe(false);
    }
  });

  it('a refused selection always leaves a usable deterministic fallback', () => {
    // This is the property Journey E depends on: the model failing must never mean the
    // line cannot be matched.
    const outcome = outcomeWith([eligible('alpha'), eligible('bravo')]);

    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (candidateId) => {
        const result = verifySelection(candidateId, outcome);
        if (!result.ok) {
          expect(outcome.top).not.toBeNull();
          expect(outcome.top?.eligible).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
