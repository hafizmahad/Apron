'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { Alert, Button } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

/**
 * Reusable action controls for governance and intervention (CLAUDE.md §21, §5).
 *
 * Two rules these enforce at the interaction level:
 *
 *  - **A destructive or irreversible action asks first.** Suspending a provider, cancelling
 *    a request or overriding a choice opens a confirmation with the consequence spelled out
 *    — never a single click that quietly does something large.
 *  - **A reason is captured where one is required**, and the button stays disabled until it
 *    is written. The server and the database both refuse without it, so the form simply
 *    matches what the system actually demands.
 *
 * The client never decides authorisation; every one of these posts to a server action that
 * re-checks the permission.
 */

export type ActionFn = (formData: FormData) => Promise<{ status: string; message?: string }>;

/** A button that performs an action directly, with an optional confirmation step. */
export function ActionButton({
  action,
  fields,
  label,
  pendingLabel,
  variant = 'secondary',
  size = 'sm',
  confirm,
}: {
  readonly action: ActionFn;
  readonly fields: Readonly<Record<string, string>>;
  readonly label: string;
  readonly pendingLabel?: string;
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  readonly size?: 'sm' | 'md';
  /** When set, the action is performed only after the user confirms. */
  readonly confirm?: { readonly title: string; readonly body: string; readonly confirmLabel: string };
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  function run(): void {
    setError(null);
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);

    startTransition(async () => {
      const result = await action(data);
      if (result.status === 'error') setError(result.message ?? 'That did not work.');
      else {
        setNotice(result.message ?? null);
        setAsking(false);
      }
    });
  }

  if (asking && confirm !== undefined) {
    return (
      <div className="rounded-md border border-warning/35 bg-warning-wash p-3">
        <p className="text-[13px] font-semibold text-warning">{confirm.title}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">{confirm.body}</p>
        {error !== null && (
          <p className="mt-2 text-[12px] font-medium text-danger">{error}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant={variant} size="sm" onClick={run} disabled={pending}>
            {pending ? (pendingLabel ?? 'Working…') : confirm.confirmLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAsking(false)}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={pending}
        onClick={() => (confirm === undefined ? run() : setAsking(true))}
      >
        {pending ? (pendingLabel ?? 'Working…') : label}
      </Button>
      {error !== null && <p className="mt-1.5 text-[12px] font-medium text-danger">{error}</p>}
      {notice !== null && <p className="mt-1.5 text-[12px] text-success">{notice}</p>}
    </div>
  );
}

/**
 * An action that cannot proceed without a written reason.
 *
 * The consequence is stated before the reason box, so the person writing it knows what
 * they are authorising. Used for suspensions, cancellations, overrides and releases.
 */
export function ReasonedAction({
  action,
  fields,
  trigger,
  title,
  consequence,
  reasonLabel,
  reasonPlaceholder,
  confirmLabel,
  variant = 'danger',
  extraFields,
}: {
  readonly action: ActionFn;
  readonly fields: Readonly<Record<string, string>>;
  readonly trigger: string;
  readonly title: string;
  readonly consequence: string;
  readonly reasonLabel: string;
  readonly reasonPlaceholder: string;
  readonly confirmLabel: string;
  readonly variant?: 'primary' | 'secondary' | 'danger';
  /** Rendered above the reason box — a select, a number input, whatever the action needs. */
  readonly extraFields?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  if (notice !== null) {
    return <Alert tone="success">{notice}</Alert>;
  }

  if (!open) {
    return (
      <Button type="button" variant={variant === 'danger' ? 'secondary' : variant} size="sm" onClick={() => setOpen(true)}>
        {trigger}
      </Button>
    );
  }

  return (
    <form
      className={cn(
        'rounded-md border p-3',
        variant === 'danger' ? 'border-danger/30 bg-danger-wash' : 'border-border bg-canvas-cool',
      )}
      action={(data) => {
        for (const [key, value] of Object.entries(fields)) data.set(key, value);
        setError(null);
        startTransition(async () => {
          const result = await action(data);
          if (result.status === 'error') setError(result.message ?? 'That did not work.');
          else {
            setNotice(result.message ?? 'Done.');
            setOpen(false);
          }
        });
      }}
    >
      <p className={cn('text-[13px] font-semibold', variant === 'danger' ? 'text-danger' : 'text-text-primary')}>
        {title}
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">{consequence}</p>

      {extraFields !== undefined && <div className="mt-3">{extraFields}</div>}

      <label className="mt-3 block text-[12px] font-medium text-text-primary">
        {reasonLabel}
        <textarea
          name="reason"
          rows={2}
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={reasonPlaceholder}
          className="mt-1 block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
        />
      </label>
      <p className="mt-1 text-[11px] text-text-secondary">
        Recorded in the audit trail against your name. This action is refused without it.
      </p>

      {error !== null && <p className="mt-2 text-[12px] font-medium text-danger">{error}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="submit" variant={variant} size="sm" disabled={pending || reason.trim().length < 3}>
          {pending ? 'Working…' : reason.trim().length < 3 ? 'Write a reason first' : confirmLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A small inline form for a single typed value, such as a rank. */
export function InlineValueForm({
  action,
  fields,
  name,
  label,
  defaultValue,
  submitLabel,
  type = 'text',
  hint,
}: {
  readonly action: ActionFn;
  readonly fields: Readonly<Record<string, string>>;
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string;
  readonly submitLabel: string;
  readonly type?: 'text' | 'number';
  readonly hint?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      action={(data) => {
        for (const [key, value] of Object.entries(fields)) data.set(key, value);
        setError(null);
        setNotice(null);
        startTransition(async () => {
          const result = await action(data);
          if (result.status === 'error') setError(result.message ?? 'That did not work.');
          else setNotice('Saved.');
        });
      }}
    >
      <label className="text-[12px] font-medium text-text-secondary">
        {label}
        <input
          name={name}
          type={type}
          defaultValue={defaultValue}
          className="mt-1 block h-9 w-28 rounded-md border border-border-strong bg-surface px-2 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
        />
      </label>
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? 'Saving…' : submitLabel}
      </Button>
      {hint !== undefined && <span className="text-[11px] text-text-secondary">{hint}</span>}
      {error !== null && <span className="text-[12px] font-medium text-danger">{error}</span>}
      {notice !== null && <span className="text-[12px] text-success">{notice}</span>}
    </form>
  );
}

/** One declared input in a {@link RecordForm}. */
export interface RecordFieldSpec {
  readonly name: string;
  readonly label: string;
  readonly type: 'text' | 'number' | 'email' | 'password' | 'textarea' | 'select';
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly defaultValue?: string;
  /** Required when `type` is `'select'`. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** Full-width in the two-column grid. */
  readonly wide?: boolean;
}

/**
 * A disclosed form that creates one record.
 *
 * Kept collapsed by default so a configuration page reads as a register first and an
 * editor second. Validation is declared here for the browser, but the server action
 * re-parses every field with Zod and re-checks the permission — this form is a
 * convenience, never the gate.
 */
export function RecordForm({
  action,
  fields,
  trigger,
  title,
  description,
  submitLabel,
  hiddenFields,
}: {
  readonly action: ActionFn;
  readonly fields: readonly RecordFieldSpec[];
  readonly trigger: string;
  readonly title: string;
  readonly description: string;
  readonly submitLabel: string;
  readonly hiddenFields?: Readonly<Record<string, string>>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  if (!open) {
    return (
      <div className="space-y-2">
        <Button type="button" variant="primary" size="sm" onClick={() => setOpen(true)}>
          {trigger}
        </Button>
        {notice !== null && <Alert tone="success">{notice}</Alert>}
      </div>
    );
  }

  return (
    <form
      key={nonce}
      className="rounded-lg border border-border bg-canvas-cool p-4"
      action={(data) => {
        for (const [key, value] of Object.entries(hiddenFields ?? {})) data.set(key, value);
        setError(null);
        setNotice(null);
        startTransition(async () => {
          const result = await action(data);
          if (result.status === 'error') {
            setError(result.message ?? 'That did not work.');
            return;
          }
          setNotice(result.message ?? 'Created.');
          setOpen(false);
          // A fresh key clears the inputs, so a second record does not inherit the first.
          setNonce((value) => value + 1);
        });
      }}
    >
      <p className="text-[13px] font-semibold text-text-primary">{title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">{description}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {fields.map((field) => {
          const id = `rf-${field.name}-${String(nonce)}`;
          const control =
            field.type === 'textarea' ? (
              <textarea
                id={id}
                name={field.name}
                rows={2}
                required={field.required === true}
                placeholder={field.placeholder ?? ''}
                defaultValue={field.defaultValue ?? ''}
                className="block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
            ) : field.type === 'select' ? (
              <select
                id={id}
                name={field.name}
                required={field.required === true}
                defaultValue={field.defaultValue ?? ''}
                className="block h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              >
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                name={field.name}
                type={field.type}
                required={field.required === true}
                placeholder={field.placeholder ?? ''}
                defaultValue={field.defaultValue ?? ''}
                autoComplete={field.type === 'password' ? 'new-password' : 'off'}
                className="block h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
            );

          return (
            <div key={field.name} className={cn('space-y-1', field.wide === true && 'sm:col-span-2')}>
              <label htmlFor={id} className="block text-[12px] font-medium text-text-primary">
                {field.label}
                {field.required === true && (
                  <span className="ml-1 text-accent" aria-hidden>
                    *
                  </span>
                )}
              </label>
              {control}
              {field.hint !== undefined && (
                <p className="text-[11px] leading-relaxed text-text-secondary">{field.hint}</p>
              )}
            </div>
          );
        })}
      </div>

      {error !== null && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
