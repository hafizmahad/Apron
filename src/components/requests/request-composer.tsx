'use client';

import { useActionState, useEffect, useMemo, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
import { AlertTriangle, ArrowRight, Check, RotateCcw, Sparkles } from 'lucide-react';
import { Alert, Badge, Button, Card, CardHeader } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import {
  clarifyRequestAction,
  composeRequestAction,
  type ComposeResult,
  type SerializableDraft,
} from '@/app/client/actions';
import { ClarificationPanel, type AnswerMap } from '@/components/requests/clarification-panel';
import { confirmRequestAction, type ConfirmResult } from '@/app/client/confirm';

/**
 * The one-sentence request composer and its structured read-back (CLAUDE.md §8).
 *
 * The client component holds only what a browser legitimately needs: the sentence being
 * typed and the draft that came back. Reading, resolving and validating all happen on the
 * server. Nothing here decides anything.
 *
 * The reference date is captured from the browser so "Friday" means the user's Friday,
 * and is sent to the server explicitly rather than being read from a clock anywhere in
 * the pipeline (ADR-009).
 */

export interface ComposerService {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly unitLabel: string;
  readonly iconPath: string;
  /**
   * Card photography for this service, or null when the pack has none.
   *
   * Derived from the category CODE by the page, not stored against the category — the
   * catalogue is the source of truth for what a service *is*, and an admin adding one
   * should not have to supply artwork before it can appear.
   */
  readonly imagePath: string | null;
}

const INITIAL: ComposeResult = { status: 'ok' };

const EXAMPLES = [
  'Landing at Teterboro Friday at 3am, two cars, three bodyguards, hotel for nine, catering, and fuel.',
  'Gulfstream into Van Nuys tomorrow 14:30, one SUV and hangar overnight.',
  'Arriving Opa Locka Saturday 09:00, 6 passengers, two SUVs and breakfast catering.',
] as const;

export function RequestComposer({ services }: { readonly services: readonly ComposerService[] }) {
  const [state, formAction] = useActionState(composeRequestAction, INITIAL);

  /**
   * The draft is held here rather than read straight off the action state, because it
   * changes for two reasons — a fresh reading, or a round of clarification — and because
   * the user must be able to put it down and start again.
   */
  const [draft, setDraft] = useState<SerializableDraft | null>(null);
  const [clarifying, startClarifying] = useTransition();
  const [clarifyError, setClarifyError] = useState<string | null>(null);

  useEffect(() => {
    if (state.draft !== undefined) setDraft(state.draft);
  }, [state.draft]);

  function answer(answers: AnswerMap): void {
    if (draft === null) return;

    setClarifyError(null);
    startClarifying(async () => {
      const outcome = await clarifyRequestAction({ state: draft.state, answers });

      if (outcome.status === 'error' || outcome.draft === undefined) {
        setClarifyError(outcome.message ?? 'We could not apply that answer.');
        return;
      }
      setDraft(outcome.draft);
    });
  }

  // Captured once per render pass; the server never reads a clock of its own.
  const reference = useMemo(() => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return {
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }, []);

  return (
    <div className="mt-8 space-y-6">
      <Card>
        <CardHeader
          title="Describe the request"
          description="One sentence is enough. We will read it back before anything is sent."
        />

        <form action={formAction} className="space-y-4 p-5">
          <input type="hidden" name="referenceDate" value={reference.date} />
          <input type="hidden" name="referenceTimezone" value={reference.timezone} />

          <label htmlFor="sentence" className="sr-only">
            Describe the request
          </label>
          <textarea
            id="sentence"
            name="sentence"
            rows={3}
            required
            minLength={3}
            maxLength={4000}
            defaultValue={state.draft?.sourceSentence ?? ''}
            placeholder="Landing at Teterboro Friday at 3am, two cars, three bodyguards, hotel for nine, catering, and fuel."
            className={cn(
              'block w-full resize-y rounded-md border border-border-strong bg-surface px-4 py-3',
              'text-[15px] leading-relaxed text-text-primary placeholder:text-text-secondary/60',
              'transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
            )}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((example, index) => (
                <button
                  key={example}
                  type="button"
                  onClick={(event) => {
                    const form = event.currentTarget.closest('form');
                    const field = form?.querySelector<HTMLTextAreaElement>('#sentence');
                    if (field !== null && field !== undefined) {
                      field.value = example;
                      field.focus();
                    }
                  }}
                  className="rounded-full border border-border px-3 py-1 text-[12px] text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
                >
                  Example {index + 1}
                </button>
              ))}
            </div>
            <ReadButton />
          </div>

          {state.status === 'error' && state.message !== undefined && (
            <Alert tone="danger">{state.message}</Alert>
          )}
        </form>
      </Card>

      {draft !== null && (
        <ReadBack
          draft={draft}
          services={services}
          clarifying={clarifying}
          clarifyError={clarifyError}
          onAnswer={answer}
          onStartOver={() => {
            setDraft(null);
            setClarifyError(null);
          }}
        />
      )}

      {draft === null && <ServiceOverview services={services} />}
    </div>
  );
}

function ReadButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="gap-2">
      <Sparkles className="size-4" aria-hidden />
      {pending ? 'Reading…' : 'Read my request'}
    </Button>
  );
}

/**
 * The read-back: what we understood, as editable structured detail.
 *
 * Every uncertainty is shown as a question, not resolved silently. A draft with a blocking
 * question cannot be confirmed — the button says so rather than being mysteriously
 * disabled (CLAUDE.md §21 "buttons state exactly what they do").
 */
function ReadBack({
  draft,
  services,
  clarifying,
  clarifyError,
  onAnswer,
  onStartOver,
}: {
  readonly draft: SerializableDraft;
  readonly services: readonly ComposerService[];
  readonly clarifying: boolean;
  readonly clarifyError: string | null;
  readonly onAnswer: (answers: AnswerMap) => void;
  readonly onStartOver: () => void;
}) {
  const plan = draft.clarification;
  const serviceByCode = new Map(services.map((service) => [service.code, service]));

  return (
    <Card>
      <CardHeader
        title="What we understood"
        description={
          plan.complete
            ? 'Everything we need is here. Nothing is sent to a supplier until you confirm.'
            : 'Here is what we have so far. A few details below decide who can cover the work.'
        }
        action={
          <Badge
            tone={
              draft.confidence === 'high'
                ? 'success'
                : draft.confidence === 'medium'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {draft.source === 'ai' ? `${draft.confidence} confidence` : 'entered manually'}
          </Badge>
        }
      />

      <div className="space-y-5 p-5">
        {draft.aiUnavailableReason !== null && (
          <Alert tone="warning" title="Assisted reading was not available">
            {draft.aiUnavailableReason} Your wording has been kept exactly as you typed it.
          </Alert>
        )}

        {/* The sentence, verbatim and never rewritten. */}
        <blockquote className="border-l-2 border-accent/40 bg-canvas-cool px-4 py-3 text-[13px] italic leading-relaxed text-text-secondary">
          {draft.sourceSentence}
        </blockquote>

        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ReadBackField
            label="Airport"
            value={draft.airport?.label ?? null}
            missing={draft.airportToken ?? 'not stated'}
          />
          <ReadBackField label="Handler (FBO)" value={draft.fbo?.name ?? null} missing="any" />
          <ReadBackField
            label="Arrival (local)"
            value={draft.arrival?.display ?? null}
            missing="not stated"
            numeric
          />
          <ReadBackField
            label="Departure (local)"
            value={draft.departure?.display ?? null}
            missing="not stated"
            numeric
          />
          <ReadBackField
            label="Passengers"
            value={draft.passengers === null ? null : String(draft.passengers)}
            missing="not stated"
            numeric
          />
          <ReadBackField
            label="Crew"
            value={draft.crew === null ? null : String(draft.crew)}
            missing="not stated"
            numeric
          />
          <ReadBackField label="Aircraft" value={draft.aircraftToken} missing="not stated" />
          <ReadBackField
            label="Timezone"
            value={draft.airport?.timezone ?? null}
            missing="resolved with the airport"
          />
        </dl>

        {/* Services */}
        <div>
          <h3 className="text-[13px] font-semibold text-text-primary">Services</h3>
          {draft.services.length === 0 ? (
            <p className="mt-2 text-[13px] text-text-secondary">
              No services were identified in the sentence.
            </p>
          ) : (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {draft.services.map((service, index) => {
                const known = service.categoryCode === null ? undefined : serviceByCode.get(service.categoryCode);
                return (
                  <li
                    key={`${service.token}-${index}`}
                    className={cn(
                      'flex items-start gap-3 rounded-md border px-3 py-2.5',
                      service.categoryId === null
                        ? 'border-warning/35 bg-warning-wash'
                        : 'border-border bg-canvas-cool',
                    )}
                  >
                    <span className="mt-0.5 shrink-0 text-text-secondary">
                      {service.categoryId === null ? (
                        <AlertTriangle className="size-4 text-warning" aria-hidden />
                      ) : (
                        <Check className="size-4 text-success" aria-hidden />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-text-primary">
                        {service.categoryName ?? `Unrecognised: "${service.token}"`}
                      </p>
                      <p className="mt-0.5 text-[12px] text-text-secondary">
                        {service.quantity === null
                          ? 'quantity not stated'
                          : `${service.quantity} ${known?.unitLabel ?? service.unitLabel ?? 'unit'}${service.quantity === 1 ? '' : 's'}`}
                        {Object.keys(service.requirements).length > 0 &&
                          ` · ${describeRequirements(service.requirements)}`}
                      </p>
                      {/*
                        A validator message is written for whoever wrote the schema —
                        "Invalid enum value. Expected 'sedan' | 'suv' …" names internal
                        values and helps nobody here. Each of these is already a question in
                        the panel below, phrased for a person, so the service says only that
                        something is still needed.
                      */}
                      {service.issues.length > 0 && (
                        <p className="mt-1 text-[12px] text-text-secondary">
                          {service.issues.length === 1
                            ? 'One detail still needed below.'
                            : `${String(service.issues.length)} details still needed below.`}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {clarifyError !== null && <Alert tone="danger">{clarifyError}</Alert>}

        {/*
          The questions configuration says are still outstanding. Deciding any of these for
          the user would be inventing a value, so the engine asks instead.
        */}
        <ClarificationPanel plan={plan} pending={clarifying} onSubmit={onAnswer} />

        <ConfirmBar draft={draft} blockingCount={plan.blocking.length} onStartOver={onStartOver} />
      </div>
    </Card>
  );
}

/**
 * Confirming the read-back — the step that actually creates the request.
 *
 * The browser posts back the RESOLVED selections it was shown: an airport id, an optional
 * FBO id, the local wall times, and a category id and quantity per service. Every one is
 * re-checked on the server, so this is a convenience, not a trust boundary.
 *
 * A service the resolver could not identify is left out of the payload rather than guessed
 * at, and the bar says how many were dropped — sending a line with a null category would
 * be refused anyway, and silently dropping one would be worse.
 */
function ConfirmBar({
  draft,
  blockingCount,
  onStartOver,
}: {
  readonly draft: SerializableDraft;
  readonly blockingCount: number;
  readonly onStartOver: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ConfirmResult | null>(null);

  const resolvedServices = draft.services.filter(
    (service): service is typeof service & { categoryId: string } => service.categoryId !== null,
  );
  const droppedCount = draft.services.length - resolvedServices.length;

  if (result?.status === 'created') {
    return <Created result={result} />;
  }

  function confirm(): void {
    if (draft.airport === null || resolvedServices.length === 0) return;

    startTransition(async () => {
      const outcome = await confirmRequestAction({
        sourceSentence: draft.sourceSentence,
        airportId: draft.airport!.id,
        fboId: draft.fbo?.id ?? null,
        arrivalLocal: draft.arrival?.local ?? null,
        departureLocal: draft.departure?.local ?? null,
        passengerCount: draft.passengers ?? 0,
        crewCount: draft.crew ?? 0,
        operationalNotes: draft.notes ?? '',
        lines: resolvedServices.map((service) => ({
          serviceCategoryId: service.categoryId,
          // An unstated quantity becomes 1 only here, at the point of committing, and the
          // read-back above showed "not stated" rather than pretending it knew.
          quantity: service.quantity ?? 1,
          requirements: service.requirements,
        })),
      });

      setResult(outcome);
    });
  }

  // One source of truth: the engine's plan. The server enforces the same rule on the way
  // in, so this governs what the button SAYS, never whether the rule holds.
  const canConfirm =
    draft.dispatchable &&
    draft.clarification.complete &&
    draft.airport !== null &&
    resolvedServices.length > 0;

  return (
    <div className="space-y-3 border-t border-border pt-4">
      {result?.status === 'error' && (
        <Alert tone="danger" title="The request was not created">
          {result.timeProblem?.message ?? result.message ?? 'Something went wrong.'}
          {result.unresolved !== undefined && result.unresolved.length > 0 && (
            <ul className="mt-1.5 list-disc pl-4">
              {result.unresolved.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      {droppedCount > 0 && (
        <Alert tone="warning">
          {droppedCount} service{droppedCount === 1 ? '' : 's'} could not be matched to our
          catalogue and will not be included. Reword {droppedCount === 1 ? 'it' : 'them'} above,
          or confirm without {droppedCount === 1 ? 'it' : 'them'}.
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-text-secondary">
          {canConfirm
            ? `Confirming creates the request and starts finding suppliers for ${String(resolvedServices.length)} service${resolvedServices.length === 1 ? '' : 's'}.`
            : blockingCount > 0
              ? `${String(blockingCount)} question${blockingCount === 1 ? '' : 's'} still to answer.`
              : 'Add a service and an airport before confirming.'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/*
            The way out. A read-back the user does not want should not trap them in it —
            this puts the draft down and returns the empty sentence box. Nothing has been
            persisted at this point, so there is nothing to undo.
          */}
          <Button type="button" variant="ghost" onClick={onStartOver} disabled={pending}>
            <RotateCcw className="size-4" aria-hidden />
            Start over
          </Button>
          <Button type="button" disabled={!canConfirm || pending} onClick={confirm}>
            {pending
              ? 'Creating…'
              : canConfirm
                ? 'Confirm and create request'
                : 'Answer the questions above'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** What the client sees the moment the request exists. */
function Created({ result }: { readonly result: ConfirmResult }) {
  const dispatch = result.dispatch;

  return (
    <div className="border-t border-border pt-4">
      <div className="rounded-lg border border-success/30 bg-success-wash p-5">
        <div className="flex items-start gap-3">
          <Check className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-text-primary">
              Request {result.reference} created
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
              {dispatch === undefined
                ? 'We are finding suppliers now.'
                : dispatch.mode === 'queued'
                  ? `We are contacting suppliers for ${String(dispatch.lines)} service${dispatch.lines === 1 ? '' : 's'} now. You will see each one confirmed as they respond.`
                  : dispatch.failed === 0
                    ? `All ${String(dispatch.offered)} service${dispatch.offered === 1 ? '' : 's'} have been offered to a supplier. You will see each one confirmed as they accept.`
                    : `${String(dispatch.offered)} of ${String(dispatch.lines)} services have been offered to a supplier. Our operations team is working on the ${String(dispatch.failed)} we could not place automatically, and will be in touch.`}
            </p>

            {result.requestId !== undefined && (
              <a
                href={`/client/requests/${result.requestId}`}
                className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline"
              >
                Track this request
                <ArrowRight className="size-4" aria-hidden />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReadBackField({
  label,
  value,
  missing,
  numeric = false,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly missing: string;
  readonly numeric?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-secondary">
        {label}
      </dt>
      <dd
        className={cn(
          'mt-1 truncate text-sm',
          value === null ? 'text-text-secondary/70 italic' : 'text-text-primary',
          numeric && value !== null && 'tabular',
        )}
      >
        {value ?? missing}
      </dd>
    </div>
  );
}

function describeRequirements(requirements: Record<string, unknown>): string {
  return Object.entries(requirements)
    .slice(0, 4)
    .map(([key, value]) => `${humanise(key)} ${String(value)}`)
    .join(', ');
}

function humanise(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
}

/** Shown before the first read: what the platform can actually arrange. */
/**
 * What the platform can arrange, as service cards.
 *
 * Presentation only. The services, their names and their descriptions all come from the
 * live catalogue through the `services` prop — nothing is hard-coded here, so a category an
 * administrator adds appears with the rest (ADR-008). A service whose code has no artwork
 * in the pack falls back to its icon on a tinted field rather than a broken image.
 *
 * `auto-rows-fr` plus `h-full` is what keeps every card the same height regardless of how
 * long a description is; the image aspect ratio is fixed at ingest, so the grid cannot go
 * ragged (§21: service-card images stay consistent in crop, radius and aspect ratio).
 */
function ServiceOverview({ services }: { readonly services: readonly ComposerService[] }) {
  return (
    <Card>
      <CardHeader
        title="What we can arrange"
        description="Mention any of these in your sentence, in your own words."
      />

      <ul className="grid auto-rows-fr gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
        {services.map((service) => (
          <li key={service.id} className="h-full">
            <article
              className={cn(
                'group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface',
                'transition-all duration-200 hover:border-border-strong hover:shadow-[0_2px_14px_rgba(15,34,56,0.10)]',
              )}
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-canvas-cool">
                {service.imagePath === null ? (
                  // No photograph for this code: the icon on a tinted field is a deliberate
                  // fallback, never a broken image (§21).
                  <span className="flex h-full items-center justify-center bg-sidebar/5">
                    <Sparkles className="size-6 text-text-secondary/50" aria-hidden />
                  </span>
                ) : (
                  <>
                    {/* Decorative: the service is named in text directly beneath. */}
                    {/* eslint-disable-next-line @next/next/no-img-element -- plain img keeps
                        this a client component without threading next/image config here */}
                    <img
                      src={service.imagePath}
                      alt=""
                      aria-hidden
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                    {/* A restrained navy wash, so six photographs read as one set rather
                        than six unrelated pictures. */}
                    <span className="absolute inset-0 bg-gradient-to-t from-sidebar-deep/25 via-transparent to-transparent" />
                  </>
                )}
              </div>

              <div className="flex flex-1 flex-col gap-1 p-4">
                <p className="text-[14px] font-semibold text-text-primary">{service.name}</p>
                <p className="text-[12px] leading-relaxed text-text-secondary">
                  {service.description}
                </p>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </Card>
  );
}
