import { DateTime } from 'luxon';
import { assertValidTimeZone } from './zone';

/**
 * Presentation formatting. Every operational timestamp in the product is rendered in the
 * airport's local zone with the zone abbreviation shown, so an operator is never left
 * guessing which clock a time refers to (CLAUDE.md §7, §21).
 *
 * Formatting is locale-fixed to `en-US` deliberately: operational readouts must be
 * byte-identical between the server render and the client hydration, and between two
 * operators on different machines.
 */

const LOCALE = 'en-US';

export interface ZonedFormatOptions {
  /** Include the zone abbreviation, e.g. "EDT". Default true. */
  readonly withZone?: boolean;
}

function dt(instant: Date, zone: string): DateTime {
  assertValidTimeZone(zone);
  return DateTime.fromJSDate(instant, { zone }).setLocale(LOCALE);
}

/** `Fri 18 Sep · 06:00 EDT` — the standard operational stamp used across the portals. */
export function formatOperational(instant: Date, zone: string, options: ZonedFormatOptions = {}): string {
  const withZone = options.withZone ?? true;
  const value = dt(instant, zone);
  const base = value.toFormat('ccc d LLL · HH:mm');
  return withZone ? `${base} ${value.toFormat('ZZZZ')}` : base;
}

/** `06:00 EDT` */
export function formatTimeOfDay(instant: Date, zone: string, options: ZonedFormatOptions = {}): string {
  const withZone = options.withZone ?? true;
  const value = dt(instant, zone);
  return withZone ? value.toFormat('HH:mm ZZZZ') : value.toFormat('HH:mm');
}

/** `Fri 18 Sep 2026` */
export function formatDate(instant: Date, zone: string): string {
  return dt(instant, zone).toFormat('ccc d LLL yyyy');
}

/** `2026-09-18` — stable key for grouping and for date inputs. */
export function formatDateKey(instant: Date, zone: string): string {
  return dt(instant, zone).toFormat('yyyy-LL-dd');
}

/** `2026-09-18T06:00` — value shape for `<input type="datetime-local">`. */
export function formatDateTimeLocalInput(instant: Date, zone: string): string {
  return dt(instant, zone).toFormat("yyyy-LL-dd'T'HH:mm");
}

/** `EDT` */
export function formatZoneAbbreviation(instant: Date, zone: string): string {
  return dt(instant, zone).toFormat('ZZZZ');
}

/**
 * Compact elapsed/remaining label: `17m`, `2h 05m`, `3d 04h`.
 * Deterministic: the caller supplies both instants, never an implicit "now".
 */
export function formatDuration(fromInstant: Date, toInstant: Date): string {
  const totalMinutes = Math.floor(Math.abs(toInstant.getTime() - fromInstant.getTime()) / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${String(minutes).padStart(2, '0')}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${String(hours % 24).padStart(2, '0')}h`;
}

/** `17 minutes ago` / `in 45 minutes`. `now` is always supplied by the caller. */
export function formatRelative(instant: Date, now: Date): string {
  const deltaMinutes = Math.round((instant.getTime() - now.getTime()) / 60_000);
  const magnitude = Math.abs(deltaMinutes);
  const past = deltaMinutes < 0;

  const label = ((): string => {
    if (magnitude < 1) return 'just now';
    if (magnitude < 60) return `${magnitude} minute${magnitude === 1 ? '' : 's'}`;
    const hours = Math.round(magnitude / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  })();

  if (label === 'just now') return label;
  return past ? `${label} ago` : `in ${label}`;
}
