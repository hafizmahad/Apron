import { CheckCircle2, CircleSlash, Cpu, ShieldCheck, ShieldX } from 'lucide-react';
import { Badge, Card, CardHeader } from '@/components/ui/primitives';
import { describeReason, isTransient, type RejectionReasonCode } from '@/domain/matching';
import type { TraceAttempt } from '@/db/queries/operations';
import { cn } from '@/lib/cn';

/**
 * The decision trace (CLAUDE.md §12, §14).
 *
 * This is the answer to "why this provider, and why not that one?" — the question
 * operations is asked on every escalation. Every candidate the engine considered is
 * listed with its structured reason codes rendered in plain words.
 *
 * The AI's part is shown honestly: whether it was consulted, what it chose, whether code
 * accepted that choice, and what ran instead when it did not. A trace that quietly hid a
 * rejected model answer would be worse than no trace.
 */
export function DecisionTrace({ attempts }: { readonly attempts: readonly TraceAttempt[] }) {
  if (attempts.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Decision trace"
          description="Recorded the first time this line is matched."
        />
        <p className="px-5 py-4 text-[13px] text-text-secondary">
          This line has not been matched yet.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Decision trace"
        description={`${attempts.length} evaluation${attempts.length === 1 ? '' : 's'}. Every candidate considered, with the reason each was rejected.`}
      />

      <div className="divide-y divide-border">
        {attempts.map((attempt) => (
          <div key={attempt.attemptNumber} className="px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-[13px] font-semibold text-text-primary">
                Attempt {attempt.attemptNumber}
              </h4>
              <span className="tabular text-[12px] text-text-secondary">
                evaluated as of {attempt.evaluationNowUtc.toISOString().slice(0, 16).replace('T', ' ')} UTC
                · engine {attempt.engineVersion}
              </span>
            </div>

            {/* What the model contributed, and whether code accepted it. */}
            <div className="mt-3 rounded-md border border-border bg-canvas-cool px-3 py-2.5">
              {!attempt.aiConsulted ? (
                <p className="flex items-start gap-2 text-[12px] leading-relaxed text-text-secondary">
                  <Cpu className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  The model was not consulted — there was no genuine choice to make, or AI is
                  switched off. The deterministic ranking decided.
                </p>
              ) : attempt.aiVerified === true ? (
                <div>
                  <p className="flex items-start gap-2 text-[12px] font-medium text-success">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    Model choice verified and used
                    {attempt.aiConfidence !== null && ` · ${attempt.aiConfidence} confidence`}
                  </p>
                  {attempt.aiReason !== null && (
                    <p className="mt-1.5 text-[12px] leading-relaxed text-text-secondary">
                      {attempt.aiReason}
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <p className="flex items-start gap-2 text-[12px] font-medium text-warning">
                    <ShieldX className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    Model choice rejected by verification — the deterministic candidate was used
                  </p>
                  {attempt.fallbackReason !== null && (
                    <p className="mt-1.5 text-[12px] leading-relaxed text-text-secondary">
                      {attempt.fallbackReason}
                    </p>
                  )}
                </div>
              )}
            </div>

            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-text-secondary">
                  Selected
                </dt>
                <dd className="mt-0.5 text-[13px] text-text-primary">
                  {attempt.chosenProviderName ?? 'no eligible provider'}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-text-secondary">
                  Deterministic top choice
                </dt>
                <dd className="mt-0.5 text-[13px] text-text-primary">
                  {attempt.deterministicTopName ?? '—'}
                  {attempt.chosenProviderName !== null &&
                    attempt.deterministicTopName !== null &&
                    attempt.chosenProviderName !== attempt.deterministicTopName && (
                      <span className="ml-2 text-[12px] text-text-secondary">(differed)</span>
                    )}
                </dd>
              </div>
            </dl>

            {attempt.eligible.length > 0 && (
              <CandidateList
                title={`Eligible (${attempt.eligible.length})`}
                candidates={attempt.eligible}
                chosenName={attempt.chosenProviderName}
              />
            )}

            {attempt.rejected.length > 0 && (
              <CandidateList
                title={`Rejected (${attempt.rejected.length})`}
                candidates={attempt.rejected}
                chosenName={null}
              />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function CandidateList({
  title,
  candidates,
  chosenName,
}: {
  readonly title: string;
  readonly candidates: readonly TraceAttempt['eligible'][number][];
  readonly chosenName: string | null;
}) {
  return (
    <div className="mt-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        {title}
      </p>
      <ul className="mt-2 space-y-1.5">
        {candidates.map((candidate) => {
          const chosen = chosenName !== null && candidate.providerName === chosenName;
          return (
            <li
              key={candidate.providerCompanyId}
              className={cn(
                'rounded-md border px-3 py-2',
                chosen ? 'border-success/30 bg-success-wash' : 'border-border bg-surface',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-text-primary">
                  {candidate.eligible ? (
                    <CheckCircle2 className="size-3.5 text-success" aria-hidden />
                  ) : (
                    <CircleSlash className="size-3.5 text-text-secondary" aria-hidden />
                  )}
                  {candidate.providerName}
                  {chosen && <Badge tone="success">selected</Badge>}
                </span>
                {candidate.eligible && (
                  <span className="tabular text-[12px] text-text-secondary">
                    {candidate.spareCapacity} spare
                    {candidate.leadTimeMarginMinutes !== null &&
                      ` · ${Math.round(candidate.leadTimeMarginMinutes / 60)} h margin`}
                  </span>
                )}
              </div>

              {candidate.reasonCodes.length > 0 && (
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {candidate.reasonCodes.map((code) => {
                    const reason = code as RejectionReasonCode;
                    let text: string;
                    let transient = false;
                    try {
                      text = describeReason(reason);
                      transient = isTransient(reason);
                    } catch {
                      // A code from an older engine version we no longer describe.
                      text = code.replace(/_/g, ' ');
                    }
                    return (
                      <li key={code}>
                        <Badge tone={transient ? 'warning' : 'neutral'}>{text}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
