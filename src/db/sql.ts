import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';

/**
 * A fully-qualified column reference for use inside raw `sql` templates.
 *
 * WHY THIS EXISTS. Drizzle renders `${airports.id}` in a `sql` template as a BARE
 * `"id"` when `airports` is the query's primary table. That is fine in the top-level
 * WHERE clause, but inside a correlated subquery it is a trap:
 *
 *   select "id", (select count(*) from fbos f where f.airport_id = "id") from airports
 *                                                                    ^^^^
 * Postgres resolves an unqualified name against the INNERMOST scope first, so `"id"`
 * binds to `fbos.id`, not `airports.id`. When the inner scope has exactly one `id` the
 * query runs and returns silently wrong numbers; when it has two it fails with
 * "column reference id is ambiguous" (SQLSTATE 42702). The first case is far worse.
 *
 * `qualified(airports.id)` always renders `"airports"."id"`, so a correlated reference
 * means what it says. Use it for every outer-table reference inside a subquery.
 */
export function qualified(column: PgColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table as PgTable))}.${sql.identifier(column.name)}`;
}
