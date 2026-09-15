import { Card, CardHeader } from '@/components/ui/primitives';
import { ReasonedAction } from '@/components/ui/action-controls';
import {
  cancelRequestAction,
  overrideProviderAction,
  releaseContactsAction,
  retryLineAction,
} from '@/app/ops/actions';
import type { OverrideCandidate } from '@/db/queries/operations';
import type { RequestLineStatus, RequestStatus } from '@/db/schema/enums';

/**
 * Manual intervention controls (CLAUDE.md §12, §5).
 *
 * Every control here overrules something the platform decided, so every one captures a
 * written reason and lands in the audit trail against the person who used it. What is
 * shown depends on the state the line is actually in — a retry appears only on a failed
 * line, a contacts release only where a provider is holding an offer they have not yet
 * acknowledged — so the panel never offers an action the server would refuse.
 *
 * The permission is checked by the action itself. Rendering is the courtesy; refusal is
 * the guarantee.
 */

const RETRYABLE: ReadonlySet<RequestLineStatus> = new Set<RequestLineStatus>(['failed']);

/** Statuses where redirecting the line to another provider still makes sense. */
const OVERRIDABLE: ReadonlySet<RequestLineStatus> = new Set<RequestLineStatus>([
  'draft',
  'matching',
  'offered',
  'waiting',
  'declined',
  'rematching',
  'failed',
]);

export function LineInterventions({
  requestId,
  lineId,
  lineStatus,
  serviceName,
  currentProviderName,
  currentProviderId,
  currentOfferStatus,
  candidates,
  canOverride,
  canRetry,
  canReleaseContacts,
}: {
  readonly requestId: string;
  readonly lineId: string;
  readonly lineStatus: RequestLineStatus;
  readonly serviceName: string;
  readonly currentProviderName: string | null;
  readonly currentProviderId: string | null;
  readonly currentOfferStatus: string | null;
  readonly candidates: readonly OverrideCandidate[];
  readonly canOverride: boolean;
  readonly canRetry: boolean;
  readonly canReleaseContacts: boolean;
}) {
  const showOverride = canOverride && OVERRIDABLE.has(lineStatus) && candidates.length > 0;
  const showRetry = canRetry && RETRYABLE.has(lineStatus);
  // Contacts are hidden until acknowledgement; releasing early only means anything while
  // a provider is holding an offer they have not yet acknowledged.
  const showRelease =
    canReleaseContacts && currentProviderId !== null && currentOfferStatus === 'sent';

  if (!showOverride && !showRetry && !showRelease) return null;

  return (
    <div className="border-t border-border bg-canvas-cool px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        Manual intervention
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
        Each of these overrules the platform and is recorded against your name with the reason
        you give.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {showOverride && (
          <ReasonedAction
            action={overrideProviderAction}
            fields={{ requestId, requestServiceLineId: lineId }}
            trigger="Send to a specific provider"
            title={`Override the choice for ${serviceName}`}
            consequence={
              currentProviderName === null
                ? 'A real offer is sent to the provider you choose, with a normal acknowledgement deadline. They can still decline.'
                : `The live offer to ${currentProviderName} is withdrawn and a fresh one is sent to the provider you choose, with a normal deadline. They can still decline.`
            }
            reasonLabel="Why is this going to a different provider?"
            reasonPlaceholder="Client asked for Meridian specifically for this arrival."
            confirmLabel="Send the offer"
            variant="primary"
            extraFields={
              <label className="block text-[12px] font-medium text-text-primary">
                Provider
                <select
                  name="providerCompanyId"
                  required
                  defaultValue=""
                  className="mt-1 block h-9 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
                >
                  <option value="" disabled>
                    Choose a provider…
                  </option>
                  {candidates.map((candidate) => (
                    <option key={candidate.providerCompanyId} value={candidate.providerCompanyId}>
                      {candidate.displayName} · rank {candidate.rank}
                      {candidate.previouslyRefused ? ' · already refused this line' : ''}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-[11px] text-text-secondary">
                  Only approved companies that cover {serviceName} at this airport are listed. The
                  server refuses anyone else, however this form is submitted.
                </span>
              </label>
            }
          />
        )}

        {showRetry && (
          <ReasonedAction
            action={retryLineAction}
            fields={{ requestId, requestServiceLineId: lineId }}
            trigger="Put back into matching"
            title={`Retry ${serviceName}`}
            consequence="The line goes back into matching and the re-match counter resets. Providers that declined stay excluded — this does not re-ask them."
            reasonLabel="What changed since it failed?"
            reasonPlaceholder="Meridian confirmed a second crew is now available for the 03:00 arrival."
            confirmLabel="Retry matching"
            variant="primary"
          />
        )}

        {showRelease && currentProviderId !== null && (
          <ReasonedAction
            action={releaseContactsAction}
            fields={{
              requestId,
              requestServiceLineId: lineId,
              providerCompanyId: currentProviderId,
            }}
            trigger="Release passenger contacts early"
            title={`Release contacts to ${currentProviderName ?? 'this provider'}`}
            consequence="Passenger names and phone numbers normally stay hidden until acknowledgement. This releases them now, before that, to one provider on one service line."
            reasonLabel="Why do they need the contacts before acknowledging?"
            reasonPlaceholder="Driver is already at the FBO and needs to reach the principal directly."
            confirmLabel="Release contacts"
          />
        )}
      </div>
    </div>
  );
}

/** Statuses from which a request can still be cancelled. */
const CANCELLABLE: ReadonlySet<RequestStatus> = new Set<RequestStatus>([
  'draft',
  'awaiting_confirmation',
  'sent',
  'sourcing',
  'partial',
  'confirmed',
  'in_progress',
  'failed',
]);

export function RequestInterventions({
  requestId,
  reference,
  status,
  liveOfferCount,
  assignmentCount,
  canCancel,
}: {
  readonly requestId: string;
  readonly reference: string;
  readonly status: RequestStatus;
  readonly liveOfferCount: number;
  readonly assignmentCount: number;
  readonly canCancel: boolean;
}) {
  if (!canCancel || !CANCELLABLE.has(status)) return null;

  const consequence = [
    'Every service on this request stops.',
    liveOfferCount > 0
      ? `${String(liveOfferCount)} live offer${liveOfferCount === 1 ? ' is' : 's are'} withdrawn.`
      : null,
    assignmentCount > 0
      ? `${String(assignmentCount)} confirmed assignment${assignmentCount === 1 ? ' is' : 's are'} released, freeing those vehicles, drivers and officers.`
      : null,
    'The history and audit trail are kept in full. This cannot be undone from the product.',
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  return (
    <Card>
      <CardHeader
        title="Cancel this request"
        description="The last resort. Everything below is released; nothing is deleted."
      />
      <div className="p-5">
        <ReasonedAction
          action={cancelRequestAction}
          fields={{ requestId }}
          trigger="Cancel request"
          title={`Cancel ${reference}?`}
          consequence={consequence}
          reasonLabel="Why is this request being cancelled?"
          reasonPlaceholder="Client cancelled the trip — aircraft went technical at Van Nuys."
          confirmLabel="Cancel the request"
        />
      </div>
    </Card>
  );
}
