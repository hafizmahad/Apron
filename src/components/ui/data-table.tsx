import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { EmptyState } from './primitives';

/**
 * The operational table (CLAUDE.md §21).
 *
 * Data-led and quiet: no zebra striping, no heavy borders, no decoration competing with
 * the values. Numeric columns get tabular figures so times and counts line up down the
 * column and do not jitter between rows.
 *
 * A server component. Sorting and filtering are URL state handled by the page, so a
 * filtered table is a shareable link and ships no JavaScript.
 */

export interface Column<Row> {
  readonly key: string;
  readonly header: string;
  readonly render: (row: Row) => ReactNode;
  /** Times, counts and money: tabular figures and right alignment. */
  readonly numeric?: boolean;
  readonly align?: 'left' | 'right' | 'center';
  readonly widthClass?: string;
  /** Dropped below `sm`, for columns that are context rather than identity. */
  readonly secondary?: boolean;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  emptyTitle,
  emptyDescription,
  caption,
}: {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly caption?: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    // Tables are the one thing allowed to scroll horizontally, inside their own container.
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        {caption !== undefined && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'whitespace-nowrap px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-secondary',
                  column.align === 'right' && 'text-right',
                  column.align === 'center' && 'text-center',
                  column.secondary === true && 'hidden sm:table-cell',
                  column.widthClass,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-b border-border/70 transition-colors last:border-0 hover:bg-canvas-cool"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    'px-4 py-3 align-top text-[13px] text-text-primary',
                    column.numeric === true && 'tabular',
                    column.align === 'right' && 'text-right',
                    column.align === 'center' && 'text-center',
                    column.secondary === true && 'hidden sm:table-cell',
                  )}
                  {...(column.numeric === true ? { 'data-numeric': 'true' } : {})}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * An honest placeholder for a surface whose backing workflow does not exist yet.
 *
 * Deliberately NOT a fake screen with invented rows. It says what the page will do, which
 * phase builds it, and what already works — so nobody mistakes a placeholder for a
 * feature (CLAUDE.md §35: "A polished UI with mocked actions is not done").
 */
export function PendingSurface({
  title,
  description,
  dependsOn,
  liveNow,
}: {
  readonly title: string;
  readonly description: string;
  readonly dependsOn: string;
  readonly liveNow?: readonly string[];
}) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-canvas-cool px-6 py-10">
      <div className="mx-auto max-w-lg text-center">
        <h3 className="font-display text-lg text-text-primary">{title}</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{description}</p>
        <p className="mt-4 inline-flex rounded-full bg-surface px-3 py-1 text-[12px] text-text-secondary ring-1 ring-inset ring-border-strong">
          Needs {dependsOn}
        </p>
        {liveNow !== undefined && liveNow.length > 0 && (
          <div className="mt-6 text-left">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
              Already working
            </p>
            <ul className="mt-2 space-y-1">
              {liveNow.map((item) => (
                <li key={item} className="text-[12px] leading-relaxed text-text-secondary">
                  · {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
