import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addLocalDays,
  formatWallTime,
  isoWeekdayIn,
  localDateKey,
  offsetMinutesAt,
  parseWallTime,
  requireInstant,
  resolveLocalWallTime,
  startOfLocalDay,
  toWallTime,
  type WallTime,
} from '@/lib/time';

/**
 * CLAUDE.md §7: "DST ambiguity/non-existent local times must force explicit user
 * confirmation". These tests pin the exact behaviour for the real transitions of the
 * zones the seeded network operates in.
 */

const wall = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): WallTime => ({ year, month, day, hour, minute });

describe('resolveLocalWallTime — unambiguous times', () => {
  it('resolves a normal New York winter time to the correct UTC instant', () => {
    const result = resolveLocalWallTime(wall(2026, 1, 15, 9, 30), 'America/New_York');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // EST is UTC-5, so 09:30 local is 14:30Z.
    expect(result.instant.toISOString()).toBe('2026-01-15T14:30:00.000Z');
    expect(result.offsetMinutes).toBe(-300);
  });

  it('resolves a normal New York summer time to the correct UTC instant', () => {
    const result = resolveLocalWallTime(wall(2026, 7, 15, 9, 30), 'America/New_York');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // EDT is UTC-4, so 09:30 local is 13:30Z.
    expect(result.instant.toISOString()).toBe('2026-07-15T13:30:00.000Z');
    expect(result.offsetMinutes).toBe(-240);
  });

  it('resolves the 03:00 arrival from the worked example in the brief', () => {
    const result = resolveLocalWallTime(wall(2026, 9, 18, 3, 0), 'America/New_York');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.instant.toISOString()).toBe('2026-09-18T07:00:00.000Z');
  });

  it('handles a zone with a non-whole-hour offset', () => {
    const result = resolveLocalWallTime(wall(2026, 6, 1, 12, 0), 'Asia/Kolkata');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.offsetMinutes).toBe(330);
    expect(result.instant.toISOString()).toBe('2026-06-01T06:30:00.000Z');
  });

  it('handles a zone that does not observe DST', () => {
    for (const month of [1, 7]) {
      const result = resolveLocalWallTime(wall(2026, month, 10, 8, 0), 'America/Phoenix');
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') continue;
      expect(result.offsetMinutes).toBe(-420);
    }
  });
});

describe('resolveLocalWallTime — spring forward (non-existent local times)', () => {
  // US DST 2026 begins 08 March at 02:00 local; 02:00-02:59 never happens in New York.
  it('reports 02:30 on the spring-forward date as non-existent', () => {
    const result = resolveLocalWallTime(wall(2026, 3, 8, 2, 30), 'America/New_York');
    expect(result.kind).toBe('nonexistent');
    if (result.kind !== 'nonexistent') return;

    // NY clocks jump from 02:00 EST straight to 03:00 EDT at 07:00Z.
    expect(result.transitionAt.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(result.gapMinutes).toBe(60);
    expect(result.suggestions).toHaveLength(2);

    // Both suggestions are real instants that render as real local times.
    expect(formatWallTime(result.suggestions[0]!.wall)).toBe('2026-03-08T03:00');
    expect(result.suggestions[0]!.label).toBe('first-valid-after-change');
    // 02:30 shifted forward by the 60-minute gap is 03:30 local.
    expect(formatWallTime(result.suggestions[1]!.wall)).toBe('2026-03-08T03:30');
    expect(result.suggestions[1]!.label).toBe('requested-shifted-forward');
  });

  it('does not treat 01:59 or 03:00 on the same date as a gap', () => {
    expect(resolveLocalWallTime(wall(2026, 3, 8, 1, 59), 'America/New_York').kind).toBe('ok');
    expect(resolveLocalWallTime(wall(2026, 3, 8, 3, 0), 'America/New_York').kind).toBe('ok');
  });

  it('reports the European spring-forward gap in its own zone and hour', () => {
    // EU DST 2026 begins 29 March at 01:00 UTC — 02:00 local in Central European Time.
    const result = resolveLocalWallTime(wall(2026, 3, 29, 2, 30), 'Europe/Zurich');
    expect(result.kind).toBe('nonexistent');
  });

  it('refuses to silently coerce a non-existent time through requireInstant', () => {
    expect(() => requireInstant(wall(2026, 3, 8, 2, 30), 'America/New_York')).toThrow(
      /nonexistent/i,
    );
  });
});

describe('resolveLocalWallTime — fall back (ambiguous local times)', () => {
  // US DST 2026 ends 01 November at 02:00 local; 01:00-01:59 happens twice in New York.
  it('reports 01:30 on the fall-back date as ambiguous with both instants', () => {
    const result = resolveLocalWallTime(wall(2026, 11, 1, 1, 30), 'America/New_York');
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;

    expect(result.options).toHaveLength(2);
    // First occurrence is still EDT (-4), second is EST (-5).
    expect(result.options[0]!.instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(result.options[0]!.offsetMinutes).toBe(-240);
    expect(result.options[1]!.instant.toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(result.options[1]!.offsetMinutes).toBe(-300);
  });

  it('orders the options earliest instant first', () => {
    const result = resolveLocalWallTime(wall(2026, 11, 1, 1, 0), 'America/New_York');
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous');
    expect(result.options[0]!.instant.getTime()).toBeLessThan(result.options[1]!.instant.getTime());
  });

  it('both ambiguous options render back to the requested wall time', () => {
    const requested = wall(2026, 11, 1, 1, 30);
    const result = resolveLocalWallTime(requested, 'America/New_York');
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous');
    for (const option of result.options) {
      expect(toWallTime(option.instant, 'America/New_York')).toEqual(requested);
    }
  });

  it('refuses to silently pick one through requireInstant', () => {
    expect(() => requireInstant(wall(2026, 11, 1, 1, 30), 'America/New_York')).toThrow(
      /ambiguous/i,
    );
  });
});

describe('resolveLocalWallTime — round-trip property', () => {
  it('any resolved instant renders back to the wall time it came from', () => {
    const zones = [
      'America/New_York',
      'America/Los_Angeles',
      'America/Phoenix',
      'Europe/London',
      'Europe/Zurich',
      'Asia/Dubai',
      'Asia/Kolkata',
      'Australia/Sydney',
      'UTC',
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...zones),
        fc.integer({ min: 2024, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 23 }),
        fc.constantFrom(0, 15, 30, 45),
        (zone, year, month, day, hour, minute) => {
          const requested = wall(year, month, day, hour, minute);
          const result = resolveLocalWallTime(requested, zone);

          switch (result.kind) {
            case 'ok':
              expect(toWallTime(result.instant, zone)).toEqual(requested);
              expect(offsetMinutesAt(zone, result.instant)).toBe(result.offsetMinutes);
              return;
            case 'ambiguous':
              expect(result.options.length).toBeGreaterThan(1);
              for (const option of result.options) {
                expect(toWallTime(option.instant, zone)).toEqual(requested);
              }
              return;
            case 'nonexistent':
              // No instant in the zone reads as this wall time.
              expect(toWallTime(result.transitionAt, zone)).not.toEqual(requested);
              expect(result.gapMinutes).toBeGreaterThan(0);
              for (const suggestion of result.suggestions) {
                expect(toWallTime(suggestion.instant, zone)).toEqual(suggestion.wall);
              }
              return;
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('calendar helpers', () => {
  it('rejects impossible calendar dates', () => {
    expect(parseWallTime('2026-02-31T10:00')).toBeNull();
    expect(parseWallTime('2025-02-29T10:00')).toBeNull();
    expect(parseWallTime('2024-02-29T10:00')).not.toBeNull();
  });

  it('parses both the T and space separators, with or without seconds', () => {
    expect(parseWallTime('2026-09-18T06:00')).toEqual(wall(2026, 9, 18, 6, 0));
    expect(parseWallTime('2026-09-18 06:00')).toEqual(wall(2026, 9, 18, 6, 0));
    expect(parseWallTime('2026-09-18T06:00:00')).toEqual(wall(2026, 9, 18, 6, 0));
    expect(parseWallTime('18/09/2026 06:00')).toBeNull();
  });

  it('reports ISO weekday in the target zone, not the host zone', () => {
    // 2026-09-18T02:00Z is Friday in London but still Thursday in Los Angeles.
    const instant = new Date('2026-09-18T02:00:00.000Z');
    expect(isoWeekdayIn('Europe/London', instant)).toBe(5);
    expect(isoWeekdayIn('America/Los_Angeles', instant)).toBe(4);
  });

  it('computes local day boundaries in the target zone', () => {
    const instant = new Date('2026-09-18T02:00:00.000Z');
    expect(startOfLocalDay(instant, 'America/New_York').toISOString()).toBe(
      '2026-09-17T04:00:00.000Z',
    );
    expect(localDateKey(instant, 'America/New_York')).toBe('2026-09-17');
    expect(localDateKey(instant, 'UTC')).toBe('2026-09-18');
  });

  it('adding local days keeps the wall-clock hour across a DST boundary', () => {
    const zone = 'America/New_York';
    // 07 March 2026 18:00 local, one day before the spring-forward transition.
    const start = requireInstant(wall(2026, 3, 7, 18, 0), zone);
    const nextDay = addLocalDays(start, zone, 1);
    expect(toWallTime(nextDay, zone).hour).toBe(18);
    // …and the elapsed real time is 23 hours, not 24.
    expect((nextDay.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it('rejects an unknown time zone rather than guessing', () => {
    expect(() => resolveLocalWallTime(wall(2026, 1, 1, 0, 0), 'Mars/Olympus')).toThrow(/time zone/i);
  });
});
