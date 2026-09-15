import { type Interval, mergeIntervals, isFullyCovered, overlaps } from './interval';
import { addLocalDays, assertValidTimeZone, isoWeekdayIn, startOfLocalDay, toWallTime } from './zone';

/**
 * Recurring weekday-based opening hours, expressed in a zone, supporting windows that
 * cross midnight (CLAUDE.md §7).
 *
 * A window is `{ weekday, openMinute, closeMinute }` where the minutes are offsets from
 * local midnight on `weekday`. `closeMinute > 1440` means the window runs into the
 * following day — e.g. a Friday 18:00 → Saturday 02:00 desk is
 * `{ weekday: 5, openMinute: 1080, closeMinute: 1560 }`. `closeMinute === 1440` is a
 * window that ends exactly at local midnight.
 */
export interface OpeningWindow {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  readonly weekday: number;
  /** Minutes from local midnight, 0-1439. */
  readonly openMinute: number;
  /** Minutes from local midnight, 1-2880; may exceed 1440 to cross midnight. */
  readonly closeMinute: number;
}

export const MINUTES_PER_DAY = 1440;

export function isValidOpeningWindow(window: OpeningWindow): boolean {
  return (
    Number.isInteger(window.weekday) &&
    window.weekday >= 1 &&
    window.weekday <= 7 &&
    Number.isInteger(window.openMinute) &&
    Number.isInteger(window.closeMinute) &&
    window.openMinute >= 0 &&
    window.openMinute < MINUTES_PER_DAY &&
    window.closeMinute > window.openMinute &&
    window.closeMinute <= 2 * MINUTES_PER_DAY
  );
}

export function assertValidOpeningWindow(window: OpeningWindow): void {
  if (!isValidOpeningWindow(window)) {
    throw new RangeError(
      `Invalid opening window: weekday=${window.weekday} open=${window.openMinute} close=${window.closeMinute}`,
    );
  }
}

export function formatMinuteOfDay(minute: number): string {
  const normalised = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(normalised / 60);
  const minutes = normalised % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Expands recurring windows into concrete UTC intervals covering `range`.
 *
 * Every window is materialised from the local midnight of its weekday, so a window that
 * spans a DST transition keeps its *wall-clock* meaning (a 09:00-17:00 desk is still
 * 09:00-17:00 local on the day the clocks change, even though that day is 23 or 25 hours
 * long). Minute arithmetic is applied to the local day start through the zone-aware
 * calendar helpers, never by adding fixed milliseconds to a UTC instant.
 */
export function expandOpeningWindows(
  windows: readonly OpeningWindow[],
  zone: string,
  range: Interval,
): Interval[] {
  assertValidTimeZone(zone);
  for (const window of windows) assertValidOpeningWindow(window);
  if (windows.length === 0) return [];

  const intervals: Interval[] = [];

  // Start a day early so a window that began on the previous local day and crosses
  // midnight into `range` is included.
  let cursor = startOfLocalDay(addLocalDays(range.start, zone, -1), zone);
  const limit = range.end.getTime();
  let guard = 0;

  while (cursor.getTime() < limit) {
    if (++guard > 800) {
      throw new RangeError('expandOpeningWindows: range too large (limit 800 local days)');
    }
    const weekday = isoWeekdayIn(zone, cursor);
    const nextDay = startOfLocalDay(addLocalDays(cursor, zone, 1), zone);

    for (const window of windows) {
      if (window.weekday !== weekday) continue;
      const start = addLocalMinutes(cursor, zone, window.openMinute);
      const end = addLocalMinutes(cursor, zone, window.closeMinute);
      if (end.getTime() <= start.getTime()) continue;
      const candidate: Interval = { start, end };
      if (overlaps(candidate, range)) intervals.push(candidate);
    }

    cursor = nextDay;
  }

  return mergeIntervals(intervals);
}

/**
 * Adds wall-clock minutes to a local day start. Splits into whole local days plus a
 * remainder so crossing a DST boundary preserves the intended wall-clock time.
 */
function addLocalMinutes(localDayStart: Date, zone: string, minutes: number): Date {
  const wholeDays = Math.floor(minutes / MINUTES_PER_DAY);
  const remainder = minutes - wholeDays * MINUTES_PER_DAY;
  const dayStart = wholeDays === 0 ? localDayStart : startOfLocalDay(addLocalDays(localDayStart, zone, wholeDays), zone);

  if (remainder === 0) return dayStart;

  // Walk forward from the local day start by the remainder, then correct for any offset
  // change that occurred inside that span so the wall-clock reading is exact.
  const naive = new Date(dayStart.getTime() + remainder * 60_000);
  const targetHour = Math.floor(remainder / 60);
  const targetMinute = remainder % 60;
  const wall = toWallTime(naive, zone);
  const drift = (wall.hour - targetHour) * 60 + (wall.minute - targetMinute);
  if (drift === 0) return naive;
  // Drift is the offset delta (±60 typically). Subtracting it restores the wall time.
  return new Date(naive.getTime() - drift * 60_000);
}

/** True when the whole of `interval` falls inside the opening windows. */
export function isWithinOpeningHours(
  windows: readonly OpeningWindow[],
  zone: string,
  interval: Interval,
): boolean {
  if (windows.length === 0) return false;
  return isFullyCovered(interval, expandOpeningWindows(windows, zone, interval));
}

/** True when at least part of `interval` falls inside the opening windows. */
export function touchesOpeningHours(
  windows: readonly OpeningWindow[],
  zone: string,
  interval: Interval,
): boolean {
  if (windows.length === 0) return false;
  return expandOpeningWindows(windows, zone, interval).some((window) => overlaps(window, interval));
}

/** A 24/7 schedule, used when a coverage row declares round-the-clock operation. */
export const ALWAYS_OPEN: readonly OpeningWindow[] = Object.freeze(
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, openMinute: 0, closeMinute: MINUTES_PER_DAY })),
);
