'use client';

import { useState, useTransition } from 'react';
import { priorityLabel } from '@/lib/domain-labels';
import { AlertTriangle, Check, Clock, Plane, X } from 'lucide-react';
import { Alert, Badge, Button, Card } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { acknowledgeOfferAction, declineOfferAction } from '@/app/provider/actions';

/**
 * One offer in the provider queue, with its accept and decline actions.
 *
 * Client contact details are absent because the server never sent them — before
 * acknowledgement they are not disclosed (CLAUDE.md §5, §13), and the card says so
 * plainly rather than showing an empty field the dispatcher might read as "no contact".
 *
 * The SLA clock is rendered from a server-computed deadline. It does not tick: a ticking
 * clock would need a timer in every card and would drift from the server's own view of
 * the deadline, which is the one that decides.
 */

export interface OfferCardData {
  readonly offerId: string;
  readonly reference: string;
  readonly serviceName: string;
  readonly serviceCode: string;
  readonly quantity: number;
  readonly unitLabel: string;
  readonly requirementsSummary: string;
  readonly airportLabel: string;
  readonly fboName: string | null;
  readonly aircraftLabel: string | null;
  readonly passengerCount: number;
  readonly serviceWindowLabel: string;
  readonly deadlineLabel: string;
  readonly minutesRemaining: number;
  readonly selectionReason: string;
  readonly priority: string;
  readonly canAct: boolean;
}

export function OfferCard({ offer }: { readonly offer: OfferCardData }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showDecline, setShowDecline] = useState(false);

  const urgency =
    offer.minutesRemaining <= 0
      ? 'lapsed'
      : offer.minutesRemaining <= 10
        ? 'critical'
        : offer.minutesRemaining <= 20
          ? 'soon'
          : 'ok';

  function submit(action: (data: FormData) => Promise<{ status: string; message?: string }>, data: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await action(data);
      if (result.status === 'error') setError(result.message ?? 'That did not work.');
    });
  }

  return (
    <Card
      className={cn(
        'overflow-hidden',
        urgency === 'critical' && 'border-danger/40',
        urgency === 'lapsed' && 'border-border opacity-70',
      )}
    >
      {/* SLA strip — the first thing a dispatcher needs to see. */}
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-2 border-b px-5 py-2.5',
          urgency === 'critical' && 'border-danger/30 bg-danger-wash',
          urgency === 'soon' && 'border-warning/30 bg-warning-wash',
          urgency === 'ok' && 'border-border bg-canvas-cool',
          urgency === 'lapsed' && 'border-border bg-canvas-cool',
        )}
      >
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-[13px] font-medium',
            urgency === 'critical' && 'text-danger',
            urgency === 'soon' && 'text-warning',
            urgency === 'ok' && 'text-text-secondary',
            urgency === 'lapsed' && 'text-text-secondary',
          )}
        >
          <Clock className="size-3.5" aria-hidden />
          {offer.minutesRemaining <= 0
            ? 'Deadline passed — this may already have moved on'
            : `${offer.minutesRemaining} min to respond`}
        </span>
        <span className="tabular text-[12px] text-text-secondary">by {offer.deadlineLabel}</span>
      </div>

      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-text-primary">
              {offer.quantity} × {offer.unitLabel}
              {offer.quantity === 1 ? '' : 's'} · {offer.serviceName}
            </h3>
            <p className="tabular mt-1 text-[12px] text-text-secondary">{offer.reference}</p>
          </div>
          {offer.priority !== 'normal' && (
            <Badge tone={offer.priority === 'urgent' ? 'danger' : 'warning'}>
              {priorityLabel(offer.priority)}
            </Badge>
          )}
        </div>

        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Detail label="Airport">
            <span className="inline-flex items-center gap-1.5">
              <Plane className="size-3.5 text-text-secondary" aria-hidden />
              {offer.airportLabel}
            </span>
          </Detail>
          <Detail label="Handler">{offer.fboName ?? 'any'}</Detail>
          <Detail label="Service window" numeric>
            {offer.serviceWindowLabel}
          </Detail>
          <Detail label="Passengers" numeric>
            {offer.passengerCount}
          </Detail>
        </dl>

        {offer.requirementsSummary !== '' && (
          <p className="mt-3 rounded-md bg-canvas-cool px-3 py-2 text-[12px] leading-relaxed text-text-secondary">
            {offer.requirementsSummary}
          </p>
        )}

        {offer.aircraftLabel !== null && (
          <p className="tabular mt-2 text-[12px] text-text-secondary">
            Aircraft: {offer.aircraftLabel}
          </p>
        )}

        {/* The concealment is stated, not implied by an empty field. */}
        <p className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-text-secondary">
          <AlertTriangle className="size-3.5" aria-hidden />
          Passenger contact details are released once you accept.
        </p>

        {error !== null && (
          <div className="mt-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}

        {!offer.canAct ? (
          <p className="mt-4 rounded-md border border-border bg-canvas-cool px-3 py-2 text-[12px] text-text-secondary">
            Your role can view this but not respond. A dispatcher or company admin must
            accept or decline.
          </p>
        ) : showDecline ? (
          <form
            className="mt-4 space-y-3"
            action={(data) => {
              data.set('offerId', offer.offerId);
              submit(declineOfferAction, data);
            }}
          >
            <label htmlFor={`reason-${offer.offerId}`} className="block text-[13px] font-medium text-text-primary">
              Why can you not cover this?
            </label>
            <textarea
              id={`reason-${offer.offerId}`}
              name="reason"
              rows={2}
              required
              minLength={3}
              maxLength={500}
              placeholder="Both night drivers are already committed."
              className="block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
            <p className="text-[12px] text-text-secondary">
              Operations sees this, and it decides whether the request is re-matched or
              escalated. It is recorded against your company.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="danger" size="sm" disabled={pending}>
                {pending ? 'Sending…' : 'Confirm decline'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowDecline(false)}
                disabled={pending}
              >
                Back
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <form
              action={(data) => {
                data.set('offerId', offer.offerId);
                submit(acknowledgeOfferAction, data);
              }}
            >
              <Button type="submit" disabled={pending} className="gap-2">
                <Check className="size-4" aria-hidden />
                {pending ? 'Accepting…' : 'Accept this job'}
              </Button>
            </form>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowDecline(true)}
              disabled={pending}
              className="gap-2"
            >
              <X className="size-4" aria-hidden />
              Can&rsquo;t cover
            </Button>
          </div>
        )}

        {offer.selectionReason !== '' && (
          <details className="mt-4">
            <summary className="cursor-pointer text-[12px] text-text-secondary hover:text-text-primary">
              Why you were selected
            </summary>
            <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
              {offer.selectionReason}
            </p>
          </details>
        )}
      </div>
    </Card>
  );
}

function Detail({
  label,
  children,
  numeric = false,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly numeric?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-text-secondary">
        {label}
      </dt>
      <dd className={cn('mt-0.5 truncate text-[13px] text-text-primary', numeric && 'tabular')}>
        {children}
      </dd>
    </div>
  );
}
