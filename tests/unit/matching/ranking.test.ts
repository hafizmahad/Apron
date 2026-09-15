import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { emptyProviderResources, evaluateAndRank, compareRanked } from '@/domain/matching';
import type { ProviderCandidate, RankedCandidate } from '@/domain/matching';
import {
  makeCandidate,
  makeContext,
  makeCoverage,
  makeDriver,
  makeLine,
  makeVehicle,
} from '../../helpers/matching';

/**
 * The deterministic ranker (CLAUDE.md §9).
 *
 * Ranking expresses a preference among candidates that are ALREADY eligible. The property
 * tests below pin the invariants that matter more than any individual ordering: ranking
 * never rescues an ineligible provider, the order is a total order, and the same inputs
 * always produce the same output.
 */

/** A provider that is eligible for the default ground-transport line. */
function eligibleCandidate(
  id: string,
  options: {
    readonly rank?: number;
    readonly displayName?: string;
    readonly totalCapacity?: number;
    readonly committed?: number;
  } = {},
): ProviderCandidate {
  const vehicles = Array.from({ length: 4 }, () => makeVehicle({ providerCompanyId: id }));
  const drivers = Array.from({ length: 4 }, () => makeDriver({ providerCompanyId: id }));
  return makeCandidate({
    providerCompanyId: id,
    displayName: options.displayName ?? `Provider ${id}`,
    rank: options.rank ?? 500,
    coverage: makeCoverage({
      totalCapacity: options.totalCapacity ?? 4,
      committedUnitsInWindow: options.committed ?? 0,
    }),
    resources: { ...emptyProviderResources, vehicles, drivers },
  });
}

describe('ranking preferences', () => {
  it('prefers the provider with more spare capacity, all else equal', () => {
    const outcome = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates: [
        eligibleCandidate('tight', { totalCapacity: 4, committed: 3, rank: 500 }),
        eligibleCandidate('roomy', { totalCapacity: 4, committed: 0, rank: 500 }),
      ],
    });
    expect(outcome.top?.providerCompanyId).toBe('roomy');
  });

  it('prefers a provider already serving another line of the same request', () => {
    const outcome = evaluateAndRank({
      context: makeContext({ providersOnOtherLines: ['incumbent'] }),
      line: makeLine(),
      candidates: [
        // The challenger has the better platform rank; consolidation still wins, because
        // fewer hand-offs on one request is worth more than 400 rank points.
        eligibleCandidate('challenger', { rank: 100 }),
        eligibleCandidate('incumbent', { rank: 500 }),
      ],
    });
    expect(outcome.top?.providerCompanyId).toBe('incumbent');
    expect(outcome.top?.sameProviderOnOtherLines).toBe(1);
  });

  it('prefers the better platform rank when capacity and consolidation tie', () => {
    const outcome = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates: [
        eligibleCandidate('weak', { rank: 900 }),
        eligibleCandidate('strong', { rank: 100 }),
      ],
    });
    expect(outcome.top?.providerCompanyId).toBe('strong');
  });

  it('falls back to display name, then id, so the order is always total', () => {
    const outcome = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates: [
        eligibleCandidate('z-id', { rank: 300, displayName: 'Zeta Transport' }),
        eligibleCandidate('a-id', { rank: 300, displayName: 'Alpha Transport' }),
      ],
    });
    expect(outcome.eligible.map((c) => c.displayName)).toEqual([
      'Alpha Transport',
      'Zeta Transport',
    ]);
  });

  it('does not reorder on a trivial lead-time difference', () => {
    // Both are hours clear of their cutoffs and land in the same comfort band, so the
    // platform rank decides rather than a few minutes of margin.
    const outcome = evaluateAndRank({
      context: makeContext(),
      line: makeLine(),
      candidates: [
        eligibleCandidate('slightly-tighter', { rank: 100 }),
        eligibleCandidate('slightly-looser', { rank: 200 }),
      ],
    });
    expect(outcome.top?.providerCompanyId).toBe('slightly-tighter');
  });
});

describe('ranking invariants', () => {
  const candidateArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim().length > 0),
    rank: fc.integer({ min: 1, max: 1000 }),
    totalCapacity: fc.integer({ min: 1, max: 12 }),
    committed: fc.integer({ min: 0, max: 12 }),
    approved: fc.boolean(),
    covered: fc.boolean(),
  });

  function buildCandidates(
    specs: readonly {
      id: string;
      rank: number;
      totalCapacity: number;
      committed: number;
      approved: boolean;
      covered: boolean;
    }[],
  ): ProviderCandidate[] {
    // Unique ids: two providers sharing an id is not a state the loader can produce.
    const seen = new Set<string>();
    return specs
      .filter((spec) => {
        const key = spec.id.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((spec, index) => {
        const id = `${spec.id}-${index}`;
        const base = eligibleCandidate(id, {
          rank: spec.rank,
          totalCapacity: spec.totalCapacity,
          committed: spec.committed,
        });
        return {
          ...base,
          status: spec.approved ? ('approved' as const) : ('suspended' as const),
          coverage: spec.covered
            ? base.coverage
            : { ...base.coverage, airportId: 'somewhere-else' },
        };
      });
  }

  it('every ranked candidate is eligible with no reason codes', () => {
    fc.assert(
      fc.property(fc.array(candidateArb, { maxLength: 10 }), (specs) => {
        const outcome = evaluateAndRank({
          context: makeContext(),
          line: makeLine(),
          candidates: buildCandidates(specs),
        });
        for (const candidate of outcome.eligible) {
          expect(candidate.eligible).toBe(true);
          expect(candidate.reasonCodes).toEqual([]);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('every rejected candidate carries at least one reason', () => {
    fc.assert(
      fc.property(fc.array(candidateArb, { maxLength: 10 }), (specs) => {
        const outcome = evaluateAndRank({
          context: makeContext(),
          line: makeLine(),
          candidates: buildCandidates(specs),
        });
        for (const candidate of outcome.rejected) {
          expect(candidate.reasonCodes.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('eligible and rejected together account for every candidate exactly once', () => {
    fc.assert(
      fc.property(fc.array(candidateArb, { maxLength: 10 }), (specs) => {
        const candidates = buildCandidates(specs);
        const outcome = evaluateAndRank({
          context: makeContext(),
          line: makeLine(),
          candidates,
        });

        const returned = [
          ...outcome.eligible.map((c) => c.providerCompanyId),
          ...outcome.rejected.map((c) => c.providerCompanyId),
        ].sort();
        const supplied = candidates.map((c) => c.providerCompanyId).sort();

        expect(returned).toEqual(supplied);
      }),
      { numRuns: 300 },
    );
  });

  it('the top choice is always the first eligible candidate, or null', () => {
    fc.assert(
      fc.property(fc.array(candidateArb, { maxLength: 10 }), (specs) => {
        const outcome = evaluateAndRank({
          context: makeContext(),
          line: makeLine(),
          candidates: buildCandidates(specs),
        });
        if (outcome.eligible.length === 0) {
          expect(outcome.top).toBeNull();
        } else {
          expect(outcome.top).toEqual(outcome.eligible[0]);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('the ordering is stable under any input permutation', () => {
    fc.assert(
      fc.property(
        fc.array(candidateArb, { minLength: 2, maxLength: 8 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (specs, seed) => {
          const candidates = buildCandidates(specs);
          const shuffled = deterministicShuffle(candidates, seed);

          const a = evaluateAndRank({
            context: makeContext(),
            line: makeLine(),
            candidates,
          });
          const b = evaluateAndRank({
            context: makeContext(),
            line: makeLine(),
            candidates: shuffled,
          });

          expect(b.eligible.map((c) => c.providerCompanyId)).toEqual(
            a.eligible.map((c) => c.providerCompanyId),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('compareRanked is a strict total order — never returns 0 for distinct candidates', () => {
    fc.assert(
      fc.property(fc.array(candidateArb, { minLength: 2, maxLength: 8 }), (specs) => {
        const outcome = evaluateAndRank({
          context: makeContext(),
          line: makeLine(),
          candidates: buildCandidates(specs),
        });

        const ranked: RankedCandidate[] = [...outcome.eligible];
        for (let i = 0; i < ranked.length; i += 1) {
          for (let j = 0; j < ranked.length; j += 1) {
            const a = ranked[i]!;
            const b = ranked[j]!;
            const comparison = compareRanked(a, b);

            if (i === j) {
              expect(comparison).toBe(0);
            } else {
              expect(comparison).not.toBe(0);
              // Antisymmetry.
              expect(Math.sign(comparison)).toBe(-Math.sign(compareRanked(b, a)));
            }
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  it('the produced list is sorted according to compareRanked', () => {
    fc.assert(
      fc.property(fc.array(candidateArb, { maxLength: 10 }), (specs) => {
        const outcome = evaluateAndRank({
          context: makeContext(),
          line: makeLine(),
          candidates: buildCandidates(specs),
        });
        for (let index = 1; index < outcome.eligible.length; index += 1) {
          expect(
            compareRanked(outcome.eligible[index - 1]!, outcome.eligible[index]!),
          ).toBeLessThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('spare capacity is never negative and never exceeds total capacity', () => {
    fc.assert(
      fc.property(fc.array(candidateArb, { maxLength: 10 }), (specs) => {
        const candidates = buildCandidates(specs);
        const capacityById = new Map(
          candidates.map((c) => [c.providerCompanyId, c.coverage.totalCapacity]),
        );
        const outcome = evaluateAndRank({
          context: makeContext(),
          line: makeLine(),
          candidates,
        });

        for (const candidate of [...outcome.eligible, ...outcome.rejected]) {
          expect(candidate.spareCapacity).toBeGreaterThanOrEqual(0);
          expect(candidate.spareCapacity).toBeLessThanOrEqual(
            capacityById.get(candidate.providerCompanyId) ?? 0,
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a candidate that is eligible stays eligible when a worse-ranked rival is added', () => {
    // Ranking must never change eligibility — it is a preference, not a gate.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (rivalRank) => {
        const solo = evaluateAndRank({
          context: makeContext(),
          line: makeLine(),
          candidates: [eligibleCandidate('subject', { rank: 400 })],
        });
        const withRival = evaluateAndRank({
          context: makeContext(),
          line: makeLine(),
          candidates: [
            eligibleCandidate('subject', { rank: 400 }),
            eligibleCandidate('rival', { rank: rivalRank }),
          ],
        });

        expect(solo.eligible).toHaveLength(1);
        expect(
          withRival.eligible.some((c) => c.providerCompanyId === 'subject'),
        ).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

/** Deterministic Fisher-Yates so a shuffled-order failure is reproducible from the seed. */
function deterministicShuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed === 0 ? 1 : seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const target = state % (index + 1);
    const a = result[index]!;
    const b = result[target]!;
    result[index] = b;
    result[target] = a;
  }
  return result;
}
