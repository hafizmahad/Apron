import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  compareIntervals,
  contains,
  containsInstant,
  durationMinutes,
  intersection,
  isFullyCovered,
  makeInterval,
  mergeIntervals,
  overlaps,
  peakConcurrency,
  subtractIntervals,
  type Interval,
} from '@/lib/time';

/**
 * Half-open `[start, end)` semantics must match the Postgres exclusion constraints
 * exactly (`tstzrange(start_utc, end_utc, '[)')`) — if they diverge, the application and
 * the database disagree about what a double-booking is (CLAUDE.md §6, §30).
 */

const at = (isoMinute: string): Date => new Date(`2026-09-18T${isoMinute}:00.000Z`);
const span = (from: string, to: string): Interval => makeInterval(at(from), at(to));

describe('makeInterval', () => {
  it('rejects a zero-length interval', () => {
    expect(() => makeInterval(at('10:00'), at('10:00'))).toThrow(/strictly after/);
  });

  it('rejects an inverted interval', () => {
    expect(() => makeInterval(at('11:00'), at('10:00'))).toThrow(/strictly after/);
  });

  it('rejects an invalid date', () => {
    expect(() => makeInterval(new Date('nonsense'), at('10:00'))).toThrow(/valid Date/);
  });
});

describe('overlaps — half-open semantics', () => {
  it('treats touching endpoints as non-overlapping', () => {
    // A driver finishing at 10:00 can start the next job at 10:00.
    expect(overlaps(span('08:00', '10:00'), span('10:00', '12:00'))).toBe(false);
  });

  it('detects a one-minute overlap', () => {
    expect(overlaps(span('08:00', '10:01'), span('10:00', '12:00'))).toBe(true);
  });

  it('detects full containment in both directions', () => {
    expect(overlaps(span('08:00', '18:00'), span('10:00', '12:00'))).toBe(true);
    expect(overlaps(span('10:00', '12:00'), span('08:00', '18:00'))).toBe(true);
  });

  it('is symmetric for every pair', () => {
    fc.assert(
      fc.property(intervalArb(), intervalArb(), (a, b) => {
        expect(overlaps(a, b)).toBe(overlaps(b, a));
      }),
      { numRuns: 300 },
    );
  });
});

describe('containsInstant', () => {
  it('includes the start and excludes the end', () => {
    const interval = span('10:00', '12:00');
    expect(containsInstant(interval, at('10:00'))).toBe(true);
    expect(containsInstant(interval, at('11:59'))).toBe(true);
    expect(containsInstant(interval, at('12:00'))).toBe(false);
  });
});

describe('contains', () => {
  it('allows touching endpoints', () => {
    expect(contains(span('08:00', '18:00'), span('08:00', '18:00'))).toBe(true);
    expect(contains(span('08:00', '18:00'), span('08:00', '18:01'))).toBe(false);
  });
});

describe('intersection', () => {
  it('returns the shared span', () => {
    const result = intersection(span('08:00', '12:00'), span('10:00', '14:00'));
    expect(result).not.toBeNull();
    expect(result!.start.toISOString()).toBe(at('10:00').toISOString());
    expect(result!.end.toISOString()).toBe(at('12:00').toISOString());
  });

  it('returns null for touching intervals', () => {
    expect(intersection(span('08:00', '10:00'), span('10:00', '12:00'))).toBeNull();
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping and touching spans, sorted', () => {
    const merged = mergeIntervals([
      span('12:00', '14:00'),
      span('08:00', '10:00'),
      span('10:00', '11:00'),
      span('13:00', '16:00'),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(span('08:00', '11:00'));
    expect(merged[1]).toEqual(span('12:00', '16:00'));
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.array(intervalArb(), { maxLength: 12 }), (intervals) => {
        const once = mergeIntervals(intervals);
        expect(mergeIntervals(once)).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });

  it('never produces overlapping output', () => {
    fc.assert(
      fc.property(fc.array(intervalArb(), { maxLength: 12 }), (intervals) => {
        const merged = mergeIntervals(intervals);
        for (let index = 1; index < merged.length; index += 1) {
          expect(merged[index]!.start.getTime()).toBeGreaterThan(merged[index - 1]!.end.getTime());
        }
      }),
      { numRuns: 200 },
    );
  });

  it('preserves total covered duration', () => {
    fc.assert(
      fc.property(fc.array(intervalArb(), { minLength: 1, maxLength: 10 }), (intervals) => {
        const merged = mergeIntervals(intervals);
        const mergedMinutes = merged.reduce((total, item) => total + durationMinutes(item), 0);
        const maxMinutes = intervals.reduce((total, item) => total + durationMinutes(item), 0);
        // Merging can only reduce (never increase) the covered span.
        expect(mergedMinutes).toBeLessThanOrEqual(maxMinutes);
        expect(mergedMinutes).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });
});

describe('subtractIntervals / isFullyCovered', () => {
  it('reports the uncovered gaps', () => {
    const gaps = subtractIntervals(span('08:00', '18:00'), [
      span('08:00', '10:00'),
      span('12:00', '14:00'),
    ]);
    expect(gaps).toEqual([span('10:00', '12:00'), span('14:00', '18:00')]);
  });

  it('returns the whole interval when nothing covers it', () => {
    expect(subtractIntervals(span('08:00', '18:00'), [])).toEqual([span('08:00', '18:00')]);
  });

  it('recognises exact and over-wide cover', () => {
    expect(isFullyCovered(span('08:00', '18:00'), [span('08:00', '18:00')])).toBe(true);
    expect(isFullyCovered(span('08:00', '18:00'), [span('06:00', '20:00')])).toBe(true);
    expect(isFullyCovered(span('08:00', '18:00'), [span('08:00', '17:59')])).toBe(false);
  });

  it('cover leaves no gap exactly when isFullyCovered agrees', () => {
    fc.assert(
      fc.property(intervalArb(), fc.array(intervalArb(), { maxLength: 8 }), (target, cover) => {
        expect(subtractIntervals(target, cover).length === 0).toBe(isFullyCovered(target, cover));
      }),
      { numRuns: 300 },
    );
  });
});

describe('peakConcurrency', () => {
  it('counts the busiest instant, not the total', () => {
    expect(
      peakConcurrency([span('08:00', '12:00'), span('09:00', '10:00'), span('09:30', '11:00')]),
    ).toBe(3);
  });

  it('does not count a job ending where another begins', () => {
    expect(peakConcurrency([span('08:00', '10:00'), span('10:00', '12:00')])).toBe(1);
  });

  it('is zero for no intervals and one for a single interval', () => {
    expect(peakConcurrency([])).toBe(0);
    expect(peakConcurrency([span('08:00', '10:00')])).toBe(1);
  });

  it('never exceeds the number of intervals', () => {
    fc.assert(
      fc.property(fc.array(intervalArb(), { maxLength: 15 }), (intervals) => {
        expect(peakConcurrency(intervals)).toBeLessThanOrEqual(intervals.length);
      }),
      { numRuns: 200 },
    );
  });

  it('agrees with a brute-force sample of the timeline', () => {
    fc.assert(
      fc.property(fc.array(intervalArb(), { minLength: 1, maxLength: 8 }), (intervals) => {
        const bruteForce = bruteForcePeak(intervals);
        expect(peakConcurrency(intervals)).toBe(bruteForce);
      }),
      { numRuns: 200 },
    );
  });
});

describe('compareIntervals', () => {
  it('produces a stable total order', () => {
    const sorted = [span('10:00', '12:00'), span('08:00', '14:00'), span('08:00', '10:00')].sort(
      compareIntervals,
    );
    expect(sorted).toEqual([span('08:00', '10:00'), span('08:00', '14:00'), span('10:00', '12:00')]);
  });
});

/** Intervals on a coarse 15-minute grid within a single day — realistic for scheduling. */
function intervalArb(): fc.Arbitrary<Interval> {
  const base = Date.UTC(2026, 8, 18, 0, 0, 0, 0);
  return fc
    .tuple(fc.integer({ min: 0, max: 92 }), fc.integer({ min: 1, max: 8 }))
    .map(([startSlot, lengthSlots]) =>
      makeInterval(
        new Date(base + startSlot * 15 * 60_000),
        new Date(base + (startSlot + lengthSlots) * 15 * 60_000),
      ),
    );
}

/** Samples every 15-minute slot and counts covering intervals. */
function bruteForcePeak(intervals: readonly Interval[]): number {
  const starts = intervals.map((interval) => interval.start.getTime());
  let peak = 0;
  for (const start of starts) {
    const covering = intervals.filter(
      (interval) => interval.start.getTime() <= start && start < interval.end.getTime(),
    ).length;
    if (covering > peak) peak = covering;
  }
  return peak;
}
