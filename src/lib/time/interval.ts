/**
 * Half-open instant intervals `[start, end)` — the single overlap vocabulary used by the
 * eligibility engine, the scheduler UI and the Postgres exclusion constraints, which use
 * `tstzrange(start_utc, end_utc, '[)')` so the two agree exactly (CLAUDE.md §6, §7).
 *
 * Pure: no clock, no zone, no I/O.
 */

export interface Interval {
  readonly start: Date;
  readonly end: Date;
}

export function makeInterval(start: Date, end: Date): Interval {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new RangeError('Interval start is not a valid Date');
  }
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new RangeError('Interval end is not a valid Date');
  }
  if (end.getTime() <= start.getTime()) {
    throw new RangeError('Interval end must be strictly after start (half-open [start, end))');
  }
  return { start, end };
}

export function isValidInterval(start: Date, end: Date): boolean {
  return (
    start instanceof Date &&
    end instanceof Date &&
    !Number.isNaN(start.getTime()) &&
    !Number.isNaN(end.getTime()) &&
    end.getTime() > start.getTime()
  );
}

/** `[a.start, a.end)` and `[b.start, b.end)` share at least one instant. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** Every instant of `inner` is inside `outer`. Touching endpoints are allowed. */
export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start.getTime() <= inner.start.getTime() && inner.end.getTime() <= outer.end.getTime();
}

export function containsInstant(interval: Interval, instant: Date): boolean {
  return instant.getTime() >= interval.start.getTime() && instant.getTime() < interval.end.getTime();
}

export function durationMinutes(interval: Interval): number {
  return Math.round((interval.end.getTime() - interval.start.getTime()) / 60_000);
}

export function intersection(a: Interval, b: Interval): Interval | null {
  if (!overlaps(a, b)) return null;
  const start = a.start.getTime() > b.start.getTime() ? a.start : b.start;
  const end = a.end.getTime() < b.end.getTime() ? a.end : b.end;
  return { start, end };
}

/** Sorts by start then end, ascending. Total order — used for deterministic output. */
export function compareIntervals(a: Interval, b: Interval): number {
  const byStart = a.start.getTime() - b.start.getTime();
  return byStart !== 0 ? byStart : a.end.getTime() - b.end.getTime();
}

/** Merges touching or overlapping intervals into a minimal sorted set. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort(compareIntervals);
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) {
        merged[merged.length - 1] = { start: last.start, end: current.end };
      }
      continue;
    }
    merged.push({ start: current.start, end: current.end });
  }
  return merged;
}

/** The parts of `interval` not covered by any of `cover`. */
export function subtractIntervals(interval: Interval, cover: readonly Interval[]): Interval[] {
  const blocks = mergeIntervals(cover.filter((candidate) => overlaps(candidate, interval)));
  const gaps: Interval[] = [];
  let cursor = interval.start;

  for (const block of blocks) {
    if (block.start.getTime() > cursor.getTime()) {
      gaps.push({ start: cursor, end: block.start });
    }
    if (block.end.getTime() > cursor.getTime()) {
      cursor = block.end;
    }
  }
  if (cursor.getTime() < interval.end.getTime()) {
    gaps.push({ start: cursor, end: interval.end });
  }
  return gaps;
}

/** True when `cover` leaves no gap inside `interval`. */
export function isFullyCovered(interval: Interval, cover: readonly Interval[]): boolean {
  return subtractIntervals(interval, cover).length === 0;
}

/**
 * Maximum number of intervals overlapping at any single instant — the concurrency a
 * resource pool must sustain. Computed with a sweep over boundary events; ends are
 * processed before starts so `[)` semantics hold (a job ending at 10:00 does not conflict
 * with one starting at 10:00).
 */
export function peakConcurrency(intervals: readonly Interval[]): number {
  const events: { at: number; delta: number }[] = [];
  for (const interval of intervals) {
    events.push({ at: interval.start.getTime(), delta: 1 });
    events.push({ at: interval.end.getTime(), delta: -1 });
  }
  events.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.delta - b.delta));

  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    if (current > peak) peak = current;
  }
  return peak;
}
