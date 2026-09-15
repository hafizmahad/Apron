/**
 * The one module permitted to convert between wall-clock time and instants.
 *
 * CLAUDE.md §7:
 *  - instants are stored in UTC (`timestamptz`) and rendered in the airport's zone;
 *  - intake produces a local wall time plus an airport token; conversion may only happen
 *    *after* the airport (and therefore the IANA zone) has been resolved;
 *  - DST ambiguity and non-existent local times must force explicit user confirmation;
 *  - operating hours are weekday-based, zone-aware, and may cross midnight;
 *  - intervals are half-open `[start, end)`.
 *
 * A source-boundary test (`tests/unit/boundaries`) fails the build if `luxon` is
 * imported anywhere outside this directory.
 */

export * from './zone';
export * from './interval';
export * from './hours';
export * from './format';
