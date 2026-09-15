import type { RequestLineStatus, RequestStatus } from '@/db/schema/enums';
import { ApronError } from '@/lib/errors';

/**
 * Request and service-line lifecycles as explicit transition functions (CLAUDE.md §29).
 *
 * PURE — no database, no clock. Status is never assigned directly anywhere in the
 * codebase; every change goes through `transitionRequest` or `transitionLine`, which
 * means an impossible transition is a typed error at the call site rather than a row
 * that quietly holds a state nothing can act on.
 *
 * The request's own status is DERIVED from its lines (`deriveRequestStatus`) rather than
 * tracked independently. Two sources of truth for "is this request covered?" would
 * inevitably disagree.
 */

// ---------------------------------------------------------------------------
// service line
// ---------------------------------------------------------------------------

export type LineEvent =
  | 'submit'            // draft → matching
  | 'offer_sent'        // matching/rematching → offered
  | 'provider_viewed'   // offered → waiting
  | 'acknowledge'       // offered/waiting → acknowledged
  | 'decline'           // offered/waiting → declined
  | 'expire'            // offered/waiting → rematching
  | 'rematch'           // declined/rematching → matching
  | 'assign'            // acknowledged → assigned
  | 'release'           // assigned → acknowledged (resources given back)
  | 'start'             // assigned → in_progress
  | 'complete'          // in_progress/assigned → completed
  | 'cancel'            // almost anything → cancelled
  | 'fail';             // matching/rematching → failed (no providers left)

const LINE_TRANSITIONS: Readonly<Record<RequestLineStatus, Partial<Record<LineEvent, RequestLineStatus>>>> =
  Object.freeze({
    draft: { submit: 'matching', cancel: 'cancelled' },

    matching: { offer_sent: 'offered', fail: 'failed', cancel: 'cancelled' },

    // `waiting` records that the provider has opened the offer. It does not extend the
    // deadline — it exists so operations can tell "unseen" from "seen and sitting on it".
    offered: {
      provider_viewed: 'waiting',
      acknowledge: 'acknowledged',
      decline: 'declined',
      expire: 'rematching',
      cancel: 'cancelled',
    },

    waiting: {
      acknowledge: 'acknowledged',
      decline: 'declined',
      expire: 'rematching',
      cancel: 'cancelled',
    },

    // A decline is terminal for THIS offer, not for the line: re-match moves on.
    declined: { rematch: 'matching', fail: 'failed', cancel: 'cancelled' },

    rematching: { offer_sent: 'offered', rematch: 'matching', fail: 'failed', cancel: 'cancelled' },

    acknowledged: {
      assign: 'assigned',
      // A provider who acknowledged then cannot deliver still declines; the line
      // re-matches rather than silently stalling.
      decline: 'declined',
      cancel: 'cancelled',
    },

    assigned: {
      start: 'in_progress',
      complete: 'completed',
      release: 'acknowledged',
      cancel: 'cancelled',
    },

    in_progress: { complete: 'completed', cancel: 'cancelled' },

    // Terminal.
    completed: {},
    cancelled: {},
    failed: { rematch: 'matching', cancel: 'cancelled' },
  });

export const TERMINAL_LINE_STATUSES: readonly RequestLineStatus[] = Object.freeze([
  'completed',
  'cancelled',
]);

/** True when the line is settled and no further work is expected. */
export function isLineTerminal(status: RequestLineStatus): boolean {
  return TERMINAL_LINE_STATUSES.includes(status);
}

/** True when the line is waiting on a provider to respond. */
export function isLineAwaitingProvider(status: RequestLineStatus): boolean {
  return status === 'offered' || status === 'waiting';
}

/** True when the line has a provider committed to it. */
export function isLineCovered(status: RequestLineStatus): boolean {
  return (
    status === 'acknowledged' ||
    status === 'assigned' ||
    status === 'in_progress' ||
    status === 'completed'
  );
}

/** True when the line needs operations to intervene. */
export function isLineException(status: RequestLineStatus): boolean {
  return status === 'failed';
}

export function canTransitionLine(from: RequestLineStatus, event: LineEvent): boolean {
  return LINE_TRANSITIONS[from][event] !== undefined;
}

export function nextLineStatus(
  from: RequestLineStatus,
  event: LineEvent,
): RequestLineStatus | null {
  return LINE_TRANSITIONS[from][event] ?? null;
}

/**
 * Applies an event, or throws `invalid_transition`.
 *
 * Throwing rather than returning null is deliberate: a caller that forgets to check a
 * returned null would write an unchanged status and appear to succeed.
 */
export function transitionLine(from: RequestLineStatus, event: LineEvent): RequestLineStatus {
  const next = nextLineStatus(from, event);
  if (next === null) {
    throw new ApronError(
      'invalid_transition',
      `A service line in "${from}" cannot handle "${event}"`,
      { details: { from, event, allowed: allowedLineEvents(from) } },
    );
  }
  return next;
}

export function allowedLineEvents(from: RequestLineStatus): LineEvent[] {
  return Object.keys(LINE_TRANSITIONS[from]) as LineEvent[];
}

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

export type RequestEvent =
  | 'submit_for_confirmation'  // draft → awaiting_confirmation
  | 'confirm'                  // draft/awaiting_confirmation → sent
  | 'begin_sourcing'           // sent → sourcing
  | 'derive'                   // recomputed from the lines
  | 'cancel'
  | 'fail';

const REQUEST_TRANSITIONS: Readonly<Record<RequestStatus, Partial<Record<RequestEvent, RequestStatus>>>> =
  Object.freeze({
    draft: { submit_for_confirmation: 'awaiting_confirmation', confirm: 'sent', cancel: 'cancelled' },
    awaiting_confirmation: { confirm: 'sent', cancel: 'cancelled' },
    sent: { begin_sourcing: 'sourcing', derive: 'sourcing', cancel: 'cancelled', fail: 'failed' },
    sourcing: { derive: 'sourcing', cancel: 'cancelled', fail: 'failed' },
    partial: { derive: 'partial', cancel: 'cancelled', fail: 'failed' },
    confirmed: { derive: 'confirmed', cancel: 'cancelled' },
    in_progress: { derive: 'in_progress', cancel: 'cancelled' },
    completed: {},
    cancelled: {},
    failed: { derive: 'sourcing', cancel: 'cancelled' },
  });

export function canTransitionRequest(from: RequestStatus, event: RequestEvent): boolean {
  return REQUEST_TRANSITIONS[from][event] !== undefined;
}

export function transitionRequest(from: RequestStatus, event: RequestEvent): RequestStatus {
  const next = REQUEST_TRANSITIONS[from][event];
  if (next === undefined) {
    throw new ApronError(
      'invalid_transition',
      `A request in "${from}" cannot handle "${event}"`,
      { details: { from, event, allowed: Object.keys(REQUEST_TRANSITIONS[from]) } },
    );
  }
  return next;
}

export function isRequestTerminal(status: RequestStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/**
 * Derives the request's status from the state of its lines (CLAUDE.md §29: "Derived
 * request status should consider all service-line states").
 *
 * Precedence, and why:
 *
 *  1. **cancelled** if it was cancelled outright — an explicit human decision outranks
 *     anything the lines say.
 *  2. **completed** only when every non-cancelled line is completed. One outstanding line
 *     means the request is not finished, however small that line is.
 *  3. **in_progress** as soon as any line is actually being delivered.
 *  4. **partial** when some lines are covered and others are not. This is the honest
 *     middle state the brief calls for: it must not read as "confirmed" while a line is
 *     still unplaced, nor as "failed" while most of it is fine.
 *  5. **confirmed** when every line is covered.
 *  6. **failed** only when EVERY line failed. A single failed line among covered ones is
 *     `partial` — operations still has a request worth saving.
 *  7. **sourcing** otherwise: work is in flight.
 */
export function deriveRequestStatus(
  current: RequestStatus,
  lineStatuses: readonly RequestLineStatus[],
): RequestStatus {
  if (current === 'cancelled') return 'cancelled';
  if (current === 'draft' || current === 'awaiting_confirmation') return current;

  const live = lineStatuses.filter((status) => status !== 'cancelled');
  if (live.length === 0) {
    // Every line was cancelled individually; the request has nothing left to do.
    return lineStatuses.length === 0 ? current : 'cancelled';
  }

  if (live.every((status) => status === 'completed')) return 'completed';

  // Work has demonstrably begun once any line is running OR already delivered. Reporting
  // "confirmed" when a service has actually been completed would understate the request.
  if (live.some((status) => status === 'in_progress' || status === 'completed')) {
    return 'in_progress';
  }

  const covered = live.filter(isLineCovered).length;
  const failed = live.filter(isLineException).length;

  if (failed === live.length) return 'failed';
  if (covered === live.length) return 'confirmed';
  if (covered > 0) return 'partial';

  return 'sourcing';
}

/** A short explanation of the derived status, for the operations timeline. */
export function describeDerivedStatus(
  status: RequestStatus,
  lineStatuses: readonly RequestLineStatus[],
): string {
  const live = lineStatuses.filter((item) => item !== 'cancelled');
  const covered = live.filter(isLineCovered).length;
  const awaiting = live.filter(isLineAwaitingProvider).length;
  const failed = live.filter(isLineException).length;

  switch (status) {
    case 'completed':
      return `All ${live.length} services completed.`;
    case 'confirmed':
      return `All ${live.length} services have a provider committed.`;
    case 'in_progress':
      return `${covered} of ${live.length} services under way.`;
    case 'partial':
      return `${covered} of ${live.length} services covered${failed > 0 ? `, ${failed} needs attention` : ''}.`;
    case 'failed':
      return `No provider could be found for any of the ${live.length} services.`;
    case 'sourcing':
      return awaiting > 0
        ? `${awaiting} of ${live.length} services awaiting a provider response.`
        : `Sourcing ${live.length} services.`;
    case 'cancelled':
      return 'Request cancelled.';
    default:
      return `${live.length} services.`;
  }
}
