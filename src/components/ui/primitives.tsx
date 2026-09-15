import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The shared visual primitives (CLAUDE.md §21).
 *
 * Every colour, radius and shadow comes from a semantic design token — no component in
 * this file or any other contains a raw hex value, which a boundary test enforces.
 *
 * These are server components by default: none of them holds state. Interactivity is
 * added by wrapping them in a client component where it is actually needed, so the
 * operational screens ship almost no JavaScript.
 */

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-text-inverse hover:bg-accent-strong active:bg-accent-strong disabled:bg-accent/50',
  secondary:
    'bg-surface text-text-primary border border-border-strong hover:bg-canvas-cool active:bg-canvas',
  ghost: 'bg-transparent text-text-secondary hover:bg-canvas-cool hover:text-text-primary',
  danger: 'bg-danger text-text-inverse hover:brightness-110 active:brightness-95',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-[15px] gap-2',
};

export interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium',
        'transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'section'>) {
  return (
    <section
      className={cn(
        'rounded-lg border border-border bg-surface shadow-card',
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-border px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold leading-tight text-text-primary">{title}</h2>
        {description !== undefined && (
          <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{description}</p>
        )}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent' | 'gold';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-canvas-cool text-text-secondary ring-border-strong',
  info: 'bg-info-wash text-info ring-info/20',
  success: 'bg-success-wash text-success ring-success/20',
  warning: 'bg-warning-wash text-warning ring-warning/25',
  danger: 'bg-danger-wash text-danger ring-danger/20',
  accent: 'bg-accent-wash text-accent ring-accent/20',
  gold: 'bg-gold-wash text-gold ring-gold/30',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  readonly tone?: BadgeTone;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5',
        'text-[12px] font-medium leading-5 ring-1 ring-inset',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly children: ReactNode;
}) {
  const describedBy = [
    hint === undefined ? null : `${htmlFor}-hint`,
    error === undefined ? null : `${htmlFor}-error`,
  ].filter((id): id is string => id !== null);

  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-text-primary">
        {label}
        {required === true && (
          <span className="ml-1 text-accent" aria-hidden>
            *
          </span>
        )}
      </label>
      {children}
      {hint !== undefined && (
        <p id={`${htmlFor}-hint`} className="text-[12px] leading-relaxed text-text-secondary">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={`${htmlFor}-error`} role="alert" className="text-[12px] font-medium text-danger">
          {error}
        </p>
      )}
      {/* Consumers spread this onto the control so the association is explicit. */}
      <span hidden data-described-by={describedBy.join(' ')} />
    </div>
  );
}

export function TextInput({ className, ...props }: ComponentPropsWithoutRef<'input'>) {
  return (
    <input
      className={cn(
        'block w-full rounded-md border border-border-strong bg-surface px-3 py-2',
        'text-sm text-text-primary placeholder:text-text-secondary/70',
        'transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
        'disabled:cursor-not-allowed disabled:bg-canvas-cool disabled:text-text-secondary',
        'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/20',
        className,
      )}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Feedback states (CLAUDE.md §21: empty, loading and error states are required)
// ---------------------------------------------------------------------------

export function Alert({
  tone = 'danger',
  title,
  children,
}: {
  readonly tone?: 'danger' | 'warning' | 'info' | 'success';
  readonly title?: string;
  readonly children: ReactNode;
}) {
  const tones = {
    danger: 'border-danger/30 bg-danger-wash text-danger',
    warning: 'border-warning/35 bg-warning-wash text-warning',
    info: 'border-info/25 bg-info-wash text-info',
    success: 'border-success/25 bg-success-wash text-success',
  } as const;

  return (
    <div role="alert" className={cn('rounded-md border px-4 py-3 text-[13px]', tones[tone])}>
      {title !== undefined && <p className="font-semibold">{title}</p>}
      <div className={cn(title !== undefined && 'mt-1', 'leading-relaxed')}>{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <h3 className="font-display text-lg text-text-primary">{title}</h3>
      <p className="max-w-sm text-[13px] leading-relaxed text-text-secondary">{description}</p>
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Skeletons match the final geometry so nothing shifts when data arrives (§21). */
export function Skeleton({ className }: { readonly className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-md', className)} />;
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  readonly eyebrow?: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        {eyebrow !== undefined && (
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-secondary">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-[26px] leading-tight text-text-primary">{title}</h1>
        {description !== undefined && (
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-secondary">
            {description}
          </p>
        )}
      </div>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A labelled value, the unit operational detail pages are built from. */
export function DataPoint({
  label,
  children,
  numeric = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly numeric?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-secondary">
        {label}
      </dt>
      <dd
        className={cn('mt-1 text-sm text-text-primary', numeric && 'tabular')}
        {...(numeric ? { 'data-numeric': 'true' } : {})}
      >
        {children}
      </dd>
    </div>
  );
}
