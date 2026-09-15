'use client';

import { useState } from 'react';
import { Check, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { configValueLabel } from '@/lib/domain-labels';
import type { ClarificationItem, ClarificationPlan } from '@/domain/requests/clarification';

/**
 * The clarification conversation (CLAUDE.md §8 step 3, §21).
 *
 * A missing detail is not an error, so this does not look like one. Each outstanding item is
 * a short question with the control that suits its declared type — chips for a choice, a
 * small number box for a count, Yes/No for a flag — and the whole thing reads as the next
 * part of a conversation rather than a form that has rejected you.
 *
 * Every question here was decided by configuration. This component renders whatever the
 * engine hands it and knows nothing about ground transport, hotels or fuel, so a service an
 * admin adds tomorrow is asked about correctly without a line changing here.
 *
 * The declared field key is never shown. A person reads "Vehicle class", never
 * `vehicleClass`.
 */

/** Mirrors `NO_PREFERENCE` on the server; only ever accepted for an optional field. */
const NO_PREFERENCE = '__no_preference__';

export type AnswerMap = Readonly<Record<string, string>>;

export function ClarificationPanel({
  plan,
  pending,
  onSubmit,
}: {
  readonly plan: ClarificationPlan;
  readonly pending: boolean;
  readonly onSubmit: (answers: AnswerMap) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const set = (id: string, value: string): void => {
    setAnswers((current) => ({ ...current, [id]: value }));
  };

  const blocking = plan.blocking;
  const optional = plan.optional;

  if (blocking.length === 0 && optional.length === 0) return null;

  const answeredBlocking = blocking.filter((item) => (answers[item.id] ?? '') !== '').length;
  const ready = answeredBlocking === blocking.length && blocking.length > 0;
  const anyAnswer = Object.values(answers).some((value) => value !== '');

  return (
    <section className="rounded-lg border border-accent/20 bg-accent-wash/40 p-5">
      <header>
        <h3 className="text-[15px] font-semibold text-text-primary">
          {blocking.length === 0
            ? 'Anything else we should know?'
            : blocking.length === 1
              ? 'One more detail'
              : 'A few details are still needed'}
        </h3>
        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
          {blocking.length === 0
            ? 'Optional — everything required is already settled.'
            : 'These decide who can cover the work, so we would rather ask than assume.'}
        </p>
      </header>

      <div className="mt-4 space-y-4">
        {blocking.map((item) => (
          <Question
            key={item.id}
            item={item}
            value={answers[item.id] ?? ''}
            onChange={(value) => set(item.id, value)}
          />
        ))}

        {optional.length > 0 && (
          <details className="group rounded-md border border-border bg-surface/70">
            <summary className="cursor-pointer list-none px-4 py-3 text-[13px] font-medium text-text-primary marker:hidden">
              <span className="inline-flex items-center gap-2">
                <PencilLine className="size-4 text-text-secondary" aria-hidden />
                {optional.length} optional detail{optional.length === 1 ? '' : 's'} you can add
                <span className="text-[12px] font-normal text-text-secondary">
                  — not needed to continue
                </span>
              </span>
            </summary>
            <div className="space-y-4 border-t border-border px-4 py-4">
              {optional.map((item) => (
                <Question
                  key={item.id}
                  item={item}
                  value={answers[item.id] ?? ''}
                  onChange={(value) => set(item.id, value)}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-accent/15 pt-4">
        <p className="text-[12px] text-text-secondary">
          {blocking.length === 0
            ? 'Add anything useful, or continue without.'
            : ready
              ? 'That is everything we need.'
              : `${String(blocking.length - answeredBlocking)} of ${String(blocking.length)} still to answer.`}
        </p>
        <Button
          type="button"
          disabled={pending || !anyAnswer}
          onClick={() => {
            onSubmit(answers);
          }}
        >
          {pending ? 'Saving…' : ready ? 'Continue' : 'Save these answers'}
        </Button>
      </div>
    </section>
  );
}

/** One question, rendered with the control its declared type calls for. */
function Question({
  item,
  value,
  onChange,
}: {
  readonly item: ClarificationItem;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const answered = value !== '';

  return (
    <div
      className={cn(
        'rounded-md border bg-surface px-4 py-3.5 transition-colors',
        answered ? 'border-success/40' : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {item.serviceName !== null && (
            <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-text-secondary">
              {item.serviceName}
            </p>
          )}
          <p className="mt-0.5 text-[14px] font-medium leading-snug text-text-primary">
            {item.question}
          </p>
          {item.help !== null && (
            <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">{item.help}</p>
          )}
        </div>
        {answered && <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />}
      </div>

      <div className="mt-3">
        {item.exhausted ? (
          <ManualCorrection item={item} value={value} onChange={onChange} />
        ) : (
          <Control item={item} value={value} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

function Control({
  item,
  value,
  onChange,
}: {
  readonly item: ClarificationItem;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const control = item.control;
  const inputId = `clarify-${item.id}`;

  switch (control.kind) {
    case 'enum':
    case 'entity': {
      const options = control.options;
      const allowNone = control.kind === 'enum' && control.allowNoPreference;

      if (options.length === 0) {
        return (
          <TextInput
            id={inputId}
            label={item.label}
            value={value}
            onChange={onChange}
            placeholder={item.label}
          />
        );
      }

      return (
        <div role="group" aria-label={item.label} className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Chip
              key={option.value}
              selected={value === option.value}
              label={option.label === option.value ? configValueLabel(option.label) : option.label}
              {...(option.hint === undefined ? {} : { hint: option.hint })}
              onSelect={() => {
                onChange(value === option.value ? '' : option.value);
              }}
            />
          ))}
          {allowNone && (
            <Chip
              selected={value === NO_PREFERENCE}
              label="No preference"
              muted
              onSelect={() => {
                onChange(value === NO_PREFERENCE ? '' : NO_PREFERENCE);
              }}
            />
          )}
        </div>
      );
    }

    case 'boolean':
      return (
        <div role="group" aria-label={item.label} className="flex flex-wrap gap-2">
          <Chip selected={value === 'true'} label="Yes" onSelect={() => { onChange(value === 'true' ? '' : 'true'); }} />
          <Chip selected={value === 'false'} label="No" onSelect={() => { onChange(value === 'false' ? '' : 'false'); }} />
          {control.allowNoPreference && (
            <Chip
              selected={value === NO_PREFERENCE}
              label="No preference"
              muted
              onSelect={() => {
                onChange(value === NO_PREFERENCE ? '' : NO_PREFERENCE);
              }}
            />
          )}
        </div>
      );

    case 'integer':
    case 'number':
      return (
        <div className="flex items-center gap-2">
          <label htmlFor={inputId} className="sr-only">
            {item.label}
          </label>
          <input
            id={inputId}
            type="number"
            inputMode="numeric"
            value={value === NO_PREFERENCE ? '' : value}
            min={control.min ?? undefined}
            max={control.max ?? undefined}
            step={control.kind === 'integer' ? 1 : 'any'}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            className="tabular w-28 rounded-md border border-border-strong bg-surface px-3 py-2 text-[14px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          />
          {control.unit !== null && (
            <span className="text-[13px] text-text-secondary">{control.unit}</span>
          )}
        </div>
      );

    case 'datetime':
      return (
        <div>
          <label htmlFor={inputId} className="sr-only">
            {item.label}
          </label>
          <input
            id={inputId}
            type="datetime-local"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            className="tabular rounded-md border border-border-strong bg-surface px-3 py-2 text-[14px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          />
          <p className="mt-1 text-[12px] text-text-secondary">Local time at the airport.</p>
        </div>
      );

    case 'text':
    default:
      return control.long ? (
        <>
          <label htmlFor={inputId} className="sr-only">
            {item.label}
          </label>
          <textarea
            id={inputId}
            rows={2}
            maxLength={4000}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            className="block w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[14px] text-text-primary placeholder:text-text-secondary/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          />
        </>
      ) : (
        <TextInput id={inputId} label={item.label} value={value} onChange={onChange} />
      );
  }
}

/**
 * The way out of a loop.
 *
 * After the same question has been asked and not answered enough times, asking it again in
 * the same words will not help. This says so plainly and takes whatever the person writes,
 * which operations can read on the request.
 */
function ManualCorrection({
  item,
  value,
  onChange,
}: {
  readonly item: ClarificationItem;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="rounded-md border border-warning/30 bg-warning-wash px-3 py-2.5">
      <p className="text-[12px] leading-relaxed text-text-secondary">
        We have not managed to settle this. Write it in your own words and our operations team
        will pick it up with you.
      </p>
      <div className="mt-2">
        <TextInput
          id={`clarify-${item.id}`}
          label={item.label}
          value={value}
          onChange={onChange}
          placeholder={`${item.label} — in your own words`}
        />
      </div>
    </div>
  );
}

function TextInput({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="text"
        maxLength={500}
        value={value}
        placeholder={placeholder ?? label}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[14px] text-text-primary placeholder:text-text-secondary/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
      />
    </>
  );
}

function Chip({
  selected,
  label,
  hint,
  muted,
  onSelect,
}: {
  readonly selected: boolean;
  readonly label: string;
  readonly hint?: string;
  readonly muted?: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'rounded-full border px-3.5 py-1.5 text-[13px] transition-colors',
        selected
          ? 'border-accent bg-accent text-text-inverse'
          : muted === true
            ? 'border-border bg-surface text-text-secondary hover:border-border-strong'
            : 'border-border-strong bg-surface text-text-primary hover:border-accent hover:text-accent',
      )}
    >
      {label}
      {hint !== undefined && (
        <span className={cn('ml-1.5 text-[11px]', selected ? 'text-text-inverse/75' : 'text-text-secondary')}>
          {hint}
        </span>
      )}
    </button>
  );
}
