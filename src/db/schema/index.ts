/**
 * Typed schema barrel. Every table module is re-exported here so `drizzle(pool, { schema })`
 * sees the full relational graph and `db.query.*` is available everywhere.
 *
 * The SQL under `src/db/migrations/` is the artifact of record (ADR-003); this file is the
 * query surface. `tests/integration/db/schema-parity.test.ts` diffs the two — every table
 * and column here must exist in the live database, and every CHECK value list in
 * `enums.ts` must match the constraint the database actually enforces.
 */
export * from './enums';
export * from './_shared';
export * from './catalogue';
export * from './geography';
export * from './identity';
export * from './coverage';
export * from './resources';
export * from './requests';
export * from './matching';
export * from './assignments';
export * from './messaging';
export * from './pricing';
