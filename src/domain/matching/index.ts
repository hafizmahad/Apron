/**
 * The deterministic eligibility engine (CLAUDE.md §9, ADR-009).
 *
 * PURE: no database import, no network, no clock, no randomness anywhere under this
 * directory. Callers load data, build an immutable snapshot, evaluate, then persist.
 * `tests/unit/boundaries/matching.test.ts` fails the build if that is ever violated.
 *
 * The production matching service and the eval suite import these same functions — the
 * oracle is not duplicated (CLAUDE.md §26).
 */
export * from './types';
export * from './reasons';
export * from './eligibility';
export * from './services';
export * from './ranking';
