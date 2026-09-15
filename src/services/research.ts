import '@/lib/server-guard';
import { isAiAvailable, runStructured } from '@/ai/client';
import { researchPrompt, type ResearchAnswer } from '@/ai/research/prompt';
import {
  loadDecisionTrace,
  loadOfferHistory,
  loadRequestDetail,
} from '@/db/queries/operations';
import { describeReason, type RejectionReasonCode } from '@/domain/matching';
import { describeDerivedStatus } from '@/domain/requests/state-machine';
import { ApronError } from '@/lib/errors';
import { formatOperational } from '@/lib/time';

/**
 * The research assistant service (CLAUDE.md §12, Journey F).
 *
 * Its job is to build an honest textual snapshot and hand it to a model that has no other
 * capability. Everything the assistant can possibly say comes from the text assembled
 * here — there is no tool call, no second query, no retrieval step it controls.
 *
 * With AI unavailable the caller still gets the snapshot and the trace; only the prose
 * answer is missing (§22: "model unavailable → show request data/trace without AI
 * summary").
 */

export interface ResearchResult {
  readonly kind: 'answered' | 'unavailable';
  readonly answer: ResearchAnswer | null;
  /** Always returned, so the UI can show the facts even when the model cannot help. */
  readonly snapshot: string;
  readonly unavailableReason: string | null;
}

export async function askAboutRequest(
  requestId: string,
  question: string,
  options: { readonly actorUserId?: string | null } = {},
): Promise<ResearchResult> {
  const trimmed = question.trim();
  if (trimmed.length < 3) {
    throw new ApronError('validation_failed', 'Ask a question of at least a few words');
  }

  const snapshot = await buildSnapshot(requestId);

  if (!isAiAvailable()) {
    return {
      kind: 'unavailable',
      answer: null,
      snapshot,
      unavailableReason:
        'The assistant is switched off for this environment. The request data and its full decision trace are below.',
    };
  }

  const result = await runStructured(
    researchPrompt,
    { question: trimmed, snapshot },
    { requestId, actorUserId: options.actorUserId ?? null },
  );

  if (!result.ok) {
    return {
      kind: 'unavailable',
      answer: null,
      snapshot,
      unavailableReason:
        result.reason === 'timeout'
          ? 'The assistant did not respond in time. The request data and its decision trace are below.'
          : 'The assistant is unavailable. The request data and its decision trace are below.',
    };
  }

  return { kind: 'answered', answer: result.data, snapshot, unavailableReason: null };
}

/**
 * Renders the request, its lines, offers and decision trace as plain text.
 *
 * Deliberately verbose about REJECTIONS — "why was provider B not used?" is the question
 * this assistant exists to answer, and it can only answer it if the reasons are in the
 * snapshot in words rather than as codes.
 *
 * Passenger contact details are NOT included. The assistant has no need for them and the
 * safest way to keep them out of a model prompt is never to put them in.
 */
export async function buildSnapshot(requestId: string): Promise<string> {
  const detail = await loadRequestDetail(requestId);
  if (detail === null) {
    throw new ApronError('not_found', 'That request does not exist');
  }

  const zone = detail.airportTimezone;
  const lines: string[] = [];

  lines.push(`Reference: ${detail.reference}`);
  lines.push(`Client: ${detail.clientName}`);
  lines.push(`Status: ${detail.status} — ${describeDerivedStatus(detail.status, detail.lines.map((line) => line.status))}`);
  lines.push(`Priority: ${detail.priority}`);
  lines.push(`Airport: ${detail.airportLabel} (${detail.airportCity}), timezone ${zone}`);
  lines.push(`Handler: ${detail.fboName ?? 'not specified'}`);
  lines.push(
    `Arrival (local): ${detail.arrivalUtc === null ? 'not set' : formatOperational(detail.arrivalUtc, zone)}`,
  );
  lines.push(
    `Departure (local): ${detail.departureUtc === null ? 'not set' : formatOperational(detail.departureUtc, zone)}`,
  );
  lines.push(`Passengers: ${detail.passengerCount}, crew: ${detail.crewCount}`);
  lines.push(`Aircraft: ${detail.aircraftLabel ?? 'not identified'}`);
  if (detail.aircraftDimensions !== null) {
    lines.push(`Aircraft dimensions: ${detail.aircraftDimensions}`);
  }
  if (detail.sourceSentence !== '') {
    lines.push(`Original request, verbatim: "${detail.sourceSentence}"`);
  }

  for (const line of detail.lines) {
    lines.push('');
    lines.push(`--- SERVICE: ${line.serviceName} (${line.serviceCode}) ---`);
    lines.push(`Quantity: ${line.quantity} ${line.unitLabel}`);
    lines.push(`Status: ${line.status}`);
    lines.push(
      `Service window (local): ${
        line.serviceStartUtc === null || line.serviceEndUtc === null
          ? 'not set'
          : `${formatOperational(line.serviceStartUtc, zone)} to ${formatOperational(line.serviceEndUtc, zone)}`
      }`,
    );

    if (Object.keys(line.requirements).length > 0) {
      lines.push(
        `Requirements: ${Object.entries(line.requirements)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(', ')}`,
      );
    }

    lines.push(`Current provider: ${line.currentProviderName ?? 'none'}`);
    lines.push(`Selection source: ${line.selectionSource ?? 'not yet matched'}`);
    lines.push(`Re-match attempts: ${line.rematchCount}`);
    if (line.failureReason !== null) lines.push(`Failure reason: ${line.failureReason}`);

    if (line.assignedResources.length > 0) {
      lines.push(
        `Committed resources: ${line.assignedResources.map((r) => `${r.kind} ${r.label}`).join('; ')}`,
      );
    } else {
      lines.push('Committed resources: none yet');
    }

    const offers = await loadOfferHistory(line.id);
    if (offers.length > 0) {
      lines.push('Offer history:');
      for (const offer of offers) {
        lines.push(
          `  #${offer.attemptNumber} ${offer.providerName} — ${offer.status}` +
            (offer.declineReason === null ? '' : ` (declined: "${offer.declineReason}")`) +
            ` — chosen ${offer.selectionSource}: ${offer.selectionReason}`,
        );
      }
    }

    const trace = await loadDecisionTrace(line.id);
    if (trace.length > 0) {
      lines.push('Decision trace:');
      for (const attempt of trace) {
        lines.push(`  Attempt ${attempt.attemptNumber} (engine ${attempt.engineVersion}):`);
        lines.push(`    Deterministic top choice: ${attempt.deterministicTopName ?? 'none'}`);
        lines.push(`    Selected: ${attempt.chosenProviderName ?? 'none eligible'}`);

        if (attempt.aiConsulted) {
          lines.push(
            `    Model consulted: yes, verification ${attempt.aiVerified === true ? 'PASSED' : 'FAILED'}` +
              (attempt.aiConfidence === null ? '' : `, confidence ${attempt.aiConfidence}`),
          );
          if (attempt.aiReason !== null) lines.push(`    Model reasoning: ${attempt.aiReason}`);
          if (attempt.fallbackReason !== null) {
            lines.push(`    Fallback reason: ${attempt.fallbackReason}`);
          }
        } else {
          lines.push('    Model consulted: no (deterministic ranking decided)');
        }

        if (attempt.eligible.length > 0) {
          lines.push('    Eligible providers:');
          for (const candidate of attempt.eligible) {
            lines.push(
              `      - ${candidate.providerName}: ${candidate.spareCapacity} spare capacity` +
                (candidate.leadTimeMarginMinutes === null
                  ? ''
                  : `, ${Math.round(candidate.leadTimeMarginMinutes / 60)} h lead-time margin`),
            );
          }
        }

        if (attempt.rejected.length > 0) {
          lines.push('    Rejected providers and why:');
          for (const candidate of attempt.rejected) {
            const reasons = candidate.reasonCodes
              .map((code) => {
                try {
                  return describeReason(code as RejectionReasonCode);
                } catch {
                  return code.replace(/_/g, ' ');
                }
              })
              .join('; ');
            lines.push(`      - ${candidate.providerName}: ${reasons}`);
          }
        }
      }
    }
  }

  return lines.join('\n');
}
