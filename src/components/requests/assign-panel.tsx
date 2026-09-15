'use client';

import { useState, useTransition } from 'react';
import { CircleSlash } from 'lucide-react';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { assignResourcesAction } from '@/app/provider/actions';

/**
 * Committing concrete resources to an acknowledged line (CLAUDE.md §13).
 *
 * Resources already committed in this window are shown **disabled with the reason**, not
 * hidden — a dispatcher needs to see that the car exists and why they cannot have it.
 *
 * That greying out is a convenience only. The database's exclusion constraint is the real
 * guarantee, and if two dispatchers submit at the same moment the second is refused with
 * a message naming the conflict. The UI never claims to be the check (CLAUDE.md §30).
 */

export interface AssignableOption {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly detail: string;
  readonly busy: boolean;
  readonly busyReason: string | null;
}

export interface AssignPanelProps {
  readonly requestServiceLineId: string;
  readonly reference: string;
  readonly serviceName: string;
  readonly quantity: number;
  readonly unitLabel: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly windowLabel: string;
  readonly options: readonly AssignableOption[];
  readonly canAssign: boolean;
}

const KIND_LABELS: Record<string, string> = {
  vehicle: 'Vehicles',
  driver: 'Drivers',
  officer: 'Officers',
};

export function AssignPanel(props: AssignPanelProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const grouped = new Map<string, AssignableOption[]>();
  for (const option of props.options) {
    grouped.set(option.kind, [...(grouped.get(option.kind) ?? []), option]);
  }

  const available = props.options.filter((option) => !option.busy).length;

  function toggle(value: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  if (done) {
    return (
      <Alert tone="success" title="Resources assigned">
        {props.reference} is now covered. The commitment is recorded and those resources are
        blocked for this window.
      </Alert>
    );
  }

  if (!props.canAssign) {
    return (
      <p className="rounded-md border border-border bg-canvas-cool px-3 py-2 text-[12px] text-text-secondary">
        Your role can view this but not assign resources.
      </p>
    );
  }

  if (props.options.length === 0) {
    return (
      <p className="rounded-md border border-border bg-canvas-cool px-3 py-2 text-[13px] text-text-secondary">
        This service commits pooled capacity rather than named resources — no selection is
        needed here.
      </p>
    );
  }

  return (
    <form
      className="space-y-4"
      action={(data) => {
        data.set('requestServiceLineId', props.requestServiceLineId);
        data.set('startUtc', props.startUtc);
        data.set('endUtc', props.endUtc);
        setError(null);
        startTransition(async () => {
          const result = await assignResourcesAction(data);
          if (result.status === 'error') setError(result.message ?? 'That did not work.');
          else setDone(true);
        });
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] text-text-secondary">
          {props.windowLabel} · {available} of {props.options.length} free
        </p>
        <p className="text-[12px] text-text-secondary">
          Needs {props.quantity} {props.unitLabel}
          {props.quantity === 1 ? '' : 's'}
        </p>
      </div>

      {[...grouped.entries()].map(([kind, options]) => (
        <fieldset key={kind}>
          <legend className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
            {KIND_LABELS[kind] ?? kind}
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {options.map((option) => {
              const value = `${option.kind}:${option.id}`;
              const isSelected = selected.has(value);

              return (
                <label
                  key={option.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors',
                    option.busy
                      ? 'cursor-not-allowed border-border bg-canvas-cool opacity-60'
                      : isSelected
                        ? 'border-accent bg-accent-wash'
                        : 'border-border-strong bg-surface hover:bg-canvas-cool',
                  )}
                >
                  <input
                    type="checkbox"
                    name="resource"
                    value={value}
                    disabled={option.busy || pending}
                    checked={isSelected}
                    onChange={() => toggle(value)}
                    className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-text-primary">
                      {option.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-text-secondary">
                      {option.detail}
                    </span>
                    {option.busy && option.busyReason !== null && (
                      <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-warning">
                        <CircleSlash className="size-3" aria-hidden />
                        {option.busyReason}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}

      {error !== null && <Alert tone="danger">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || selected.size === 0}>
          {pending
            ? 'Assigning…'
            : selected.size === 0
              ? 'Select resources to assign'
              : `Assign ${selected.size} resource${selected.size === 1 ? '' : 's'}`}
        </Button>
        {selected.size > 0 && (
          <Badge tone="accent">
            {selected.size} selected
          </Badge>
        )}
      </div>
    </form>
  );
}
