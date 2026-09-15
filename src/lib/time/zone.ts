import { DateTime, IANAZone } from 'luxon';

/** A local wall-clock date and time with no zone attached. Minute precision. */
export interface WallTime {
  readonly year: number;
  /** 1-12 */
  readonly month: number;
  /** 1-31 */
  readonly day: number;
  /** 0-23 */
  readonly hour: number;
  /** 0-59 */
  readonly minute: number;
}

export type LocalTimeResolution =
  /** Exactly one UTC instant corresponds to this wall time in this zone. */
  | { readonly kind: 'ok'; readonly instant: Date; readonly offsetMinutes: number }
  /**
   * The clock was set back: this wall time occurs twice. The caller must ask the user
   * which one they meant; nothing may guess (CLAUDE.md §7).
   */
  | {
      readonly kind: 'ambiguous';
      readonly options: readonly { readonly instant: Date; readonly offsetMinutes: number }[];
    }
  /**
   * The clock was set forward: this wall time never happens. `transitionAt` is the exact
   * instant the offset changed and `gapMinutes` is how much local time was skipped.
   * `suggestions` are real, renderable instants the user can choose between — never a
   * silent coercion (CLAUDE.md §7).
   */
  | {
      readonly kind: 'nonexistent';
      readonly transitionAt: Date;
      readonly gapMinutes: number;
      readonly suggestions: readonly {
        readonly instant: Date;
        readonly wall: WallTime;
        readonly label: 'first-valid-after-change' | 'requested-shifted-forward';
      }[];
    };

const WALL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/;

export function isValidTimeZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

export function assertValidTimeZone(zone: string): void {
  if (!isValidTimeZone(zone)) {
    throw new RangeError(`Unknown IANA time zone: ${zone}`);
  }
}

/** Parses `YYYY-MM-DDTHH:mm` (or with a space, or with seconds) into a WallTime. */
export function parseWallTime(value: string): WallTime | null {
  const match = WALL_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  if (y === undefined || mo === undefined || d === undefined || h === undefined || mi === undefined) {
    return null;
  }
  const wall: WallTime = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
  };
  return isCalendarValid(wall) ? wall : null;
}

export function formatWallTime(wall: WallTime): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** True when the fields describe a real calendar date (rejects 31 February etc.). */
export function isCalendarValid(wall: WallTime): boolean {
  if (wall.month < 1 || wall.month > 12) return false;
  if (wall.day < 1 || wall.day > 31) return false;
  if (wall.hour < 0 || wall.hour > 23) return false;
  if (wall.minute < 0 || wall.minute > 59) return false;
  // UTC construction is safe here: this checks calendar validity only, never an offset.
  const probe = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute));
  return (
    probe.getUTCFullYear() === wall.year &&
    probe.getUTCMonth() === wall.month - 1 &&
    probe.getUTCDate() === wall.day
  );
}

function zoneOffsetMinutesAt(zone: string, instant: Date): number {
  return IANAZone.create(zone).offset(instant.getTime());
}

/** Wall time as if it were UTC — the anchor used to probe candidate offsets. */
function wallAsUtcMillis(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
}

function instantToWall(zone: string, instant: Date): WallTime {
  const dt = DateTime.fromJSDate(instant, { zone });
  return {
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
  };
}

function wallEquals(a: WallTime, b: WallTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/**
 * Resolves a local wall time in a zone to UTC, reporting DST gaps and overlaps instead of
 * silently picking one.
 *
 * Method: take the wall time interpreted as UTC as an anchor, read the zone's real UTC
 * offset a day either side of it, and treat each distinct offset as a candidate. A
 * candidate is accepted only if `wall - offset` renders back to exactly `wall` in the
 * zone. Zero survivors means the wall time falls in a spring-forward gap; two survivors
 * means it falls in a fall-back overlap. The zone database (via Luxon/ICU) supplies every
 * offset; no arithmetic here encodes any rule about any particular zone.
 */
export function resolveLocalWallTime(wall: WallTime, zone: string): LocalTimeResolution {
  assertValidTimeZone(zone);
  if (!isCalendarValid(wall)) {
    throw new RangeError(`Not a valid calendar date/time: ${formatWallTime(wall)}`);
  }

  const anchor = wallAsUtcMillis(wall);
  const day = 24 * 60 * 60 * 1000;

  const candidateOffsets = new Set<number>();
  for (const probe of [anchor - day, anchor, anchor + day]) {
    candidateOffsets.add(zoneOffsetMinutesAt(zone, new Date(probe)));
  }

  const accepted: { instant: Date; offsetMinutes: number }[] = [];
  for (const offsetMinutes of [...candidateOffsets].sort((a, b) => a - b)) {
    const instant = new Date(anchor - offsetMinutes * 60_000);
    // The candidate must be self-consistent: the zone's actual offset at that instant
    // has to be the offset we assumed, and it has to render back to the same wall time.
    if (zoneOffsetMinutesAt(zone, instant) !== offsetMinutes) continue;
    if (!wallEquals(instantToWall(zone, instant), wall)) continue;
    if (accepted.some((existing) => existing.instant.getTime() === instant.getTime())) continue;
    accepted.push({ instant, offsetMinutes });
  }

  if (accepted.length === 1) {
    const only = accepted[0];
    if (only === undefined) throw new Error('unreachable: single candidate missing');
    return { kind: 'ok', instant: only.instant, offsetMinutes: only.offsetMinutes };
  }

  if (accepted.length > 1) {
    // Fall-back overlap: earliest instant first so "the first 01:30" is option one.
    const options = accepted
      .slice()
      .sort((a, b) => a.instant.getTime() - b.instant.getTime())
      .map((option) => ({ instant: option.instant, offsetMinutes: option.offsetMinutes }));
    return { kind: 'ambiguous', options };
  }

  // Spring-forward gap: locate the exact transition instant rather than inferring a
  // window from the requested minutes, which would drift with the requested time.
  const transitionAt = findOffsetTransition(zone, anchor - day, anchor + day);
  const offsetBefore = zoneOffsetMinutesAt(zone, new Date(transitionAt.getTime() - 1));
  const offsetAfter = zoneOffsetMinutesAt(zone, transitionAt);
  const gapMinutes = offsetAfter - offsetBefore;

  // Reading the requested wall time with the *pre-transition* offset preserves elapsed
  // time across the gap, which renders as the requested clock time shifted forward by
  // `gapMinutes` — 02:30 on a US spring-forward date becomes 03:30 local.
  const shiftedInstant = new Date(anchor - offsetBefore * 60_000);

  return {
    kind: 'nonexistent',
    transitionAt,
    gapMinutes,
    suggestions: [
      {
        instant: transitionAt,
        wall: instantToWall(zone, transitionAt),
        label: 'first-valid-after-change',
      },
      {
        instant: shiftedInstant,
        wall: instantToWall(zone, shiftedInstant),
        label: 'requested-shifted-forward',
      },
    ],
  };
}

/**
 * The first instant in `[loMillis, hiMillis]` at which the zone's UTC offset differs from
 * the offset at `loMillis`, to millisecond precision. Binary search over the zone
 * database — no rule about any particular zone is encoded here.
 */
function findOffsetTransition(zone: string, loMillis: number, hiMillis: number): Date {
  const startOffset = zoneOffsetMinutesAt(zone, new Date(loMillis));
  if (zoneOffsetMinutesAt(zone, new Date(hiMillis)) === startOffset) {
    throw new Error(`No offset transition found in ${zone} between the probed instants`);
  }

  let lo = loMillis;
  let hi = hiMillis;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (zoneOffsetMinutesAt(zone, new Date(mid)) === startOffset) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return new Date(hi);
}

/**
 * Convenience for code paths that have already handled ambiguity (for example a user who
 * explicitly chose an option, or a synthetic value known to be unambiguous).
 */
export function requireInstant(wall: WallTime, zone: string): Date {
  const resolution = resolveLocalWallTime(wall, zone);
  if (resolution.kind !== 'ok') {
    throw new RangeError(
      `Local time ${formatWallTime(wall)} in ${zone} is ${resolution.kind}; the caller must resolve it explicitly.`,
    );
  }
  return resolution.instant;
}

/** The wall-clock reading of an instant in a zone. */
export function toWallTime(instant: Date, zone: string): WallTime {
  assertValidTimeZone(zone);
  return instantToWall(zone, instant);
}

/** UTC offset in minutes that the zone is observing at that instant. */
export function offsetMinutesAt(zone: string, instant: Date): number {
  assertValidTimeZone(zone);
  return zoneOffsetMinutesAt(zone, instant);
}

/** ISO weekday in the zone: 1 = Monday … 7 = Sunday. Matches `operating_hours.weekday`. */
export function isoWeekdayIn(zone: string, instant: Date): number {
  assertValidTimeZone(zone);
  return DateTime.fromJSDate(instant, { zone }).weekday;
}

/** Local calendar date key (`YYYY-MM-DD`) of an instant in a zone. */
export function localDateKey(instant: Date, zone: string): string {
  assertValidTimeZone(zone);
  return DateTime.fromJSDate(instant, { zone }).toFormat('yyyy-LL-dd');
}

/** Start of the local calendar day containing `instant`, as a UTC instant. */
export function startOfLocalDay(instant: Date, zone: string): Date {
  assertValidTimeZone(zone);
  return DateTime.fromJSDate(instant, { zone }).startOf('day').toJSDate();
}

/** Adds whole days in local calendar terms (DST-safe), returning a UTC instant. */
export function addLocalDays(instant: Date, zone: string, days: number): Date {
  assertValidTimeZone(zone);
  return DateTime.fromJSDate(instant, { zone }).plus({ days }).toJSDate();
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export function differenceInMinutes(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 60_000);
}
