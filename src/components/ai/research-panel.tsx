'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Ban, Info, Radar, ShieldQuestion } from 'lucide-react';
import { Alert, Button, Card, CardHeader } from '@/components/ui/primitives';
import { askResearchAction, type ResearchState } from '@/app/ops/research/actions';

/**
 * The read-only research assistant panel (CLAUDE.md §12, Journey F).
 *
 * Three states are rendered differently on purpose, because conflating them is exactly
 * how an assistant becomes untrustworthy:
 *
 *  - **answered from the trace** — a normal answer, with the facts it used.
 *  - **not in the data** — shown as a limitation, not as an answer. The platform does not
 *    hold it, and saying so is the correct outcome.
 *  - **you asked me to act** — shown as a refusal with an explanation. The assistant
 *    cannot book, assign or contact anyone, and must never imply otherwise (§22).
 */

const INITIAL: ResearchState = { status: 'idle' };

const SUGGESTIONS = [
  'Why was this provider chosen over the others?',
  'Why was every other provider rejected?',
  'What is still uncovered on this request?',
  'Which provider had the most spare capacity?',
] as const;

export function ResearchPanel({ requestId }: { readonly requestId: string }) {
  const [state, formAction] = useActionState(askResearchAction, INITIAL);

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Radar className="size-4 text-accent" aria-hidden />
            Research assistant
          </span>
        }
        description="Answers from this request's own decision trace. Read-only — it cannot book, assign or contact anyone."
      />

      <form action={formAction} className="space-y-3 p-5">
        <input type="hidden" name="requestId" value={requestId} />

        <label htmlFor="question" className="sr-only">
          Ask about this request
        </label>
        <textarea
          id="question"
          name="question"
          rows={2}
          required
          minLength={3}
          maxLength={1000}
          defaultValue={state.question ?? ''}
          placeholder="Why was Gotham Livery rejected?"
          className="block w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary placeholder:text-text-secondary/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
        />

        <div className="flex flex-wrap items-center gap-2">
          <AskButton />
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={(event) => {
                const form = event.currentTarget.closest('form');
                const field = form?.querySelector<HTMLTextAreaElement>('#question');
                if (field != null) {
                  field.value = suggestion;
                  field.focus();
                }
              }}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </form>

      {state.status !== 'idle' && (
        <div className="border-t border-border p-5">
          {state.status === 'error' && <Alert tone="danger">{state.message}</Alert>}

          {state.status === 'unavailable' && (
            <Alert tone="warning" title="The assistant could not answer">
              {state.message} Everything it would have used is on this page already — the
              decision trace below holds the same facts.
            </Alert>
          )}

          {state.status === 'answered' && (
            <div className="space-y-3">
              {state.actionRequested === true && (
                <div className="flex items-start gap-2 rounded-md border border-warning/35 bg-warning-wash px-3 py-2.5">
                  <Ban className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <p className="text-[12px] leading-relaxed text-warning">
                    That asked for an action. The assistant is read-only and has not done
                    anything — use the controls on this page to act.
                  </p>
                </div>
              )}

              {state.answeredFromContext === false && (
                <div className="flex items-start gap-2 rounded-md border border-info/25 bg-info-wash px-3 py-2.5">
                  <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
                  <p className="text-[12px] leading-relaxed text-info">
                    The platform does not hold what was asked. The answer below says what is
                    missing rather than guessing.
                  </p>
                </div>
              )}

              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-primary">
                {state.answer}
              </p>

              {state.citedFacts !== undefined && state.citedFacts.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                    Based on
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {state.citedFacts.map((fact) => (
                      <li
                        key={fact}
                        className="flex items-start gap-1.5 text-[12px] leading-relaxed text-text-secondary"
                      >
                        <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                        {fact}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function AskButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Reading the trace…' : 'Ask'}
    </Button>
  );
}
