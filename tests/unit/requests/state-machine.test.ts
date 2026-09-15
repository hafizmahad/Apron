import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { requestLineStatuses, requestStatuses } from '@/db/schema/enums';
import type { RequestLineStatus, RequestStatus } from '@/db/schema/enums';
import {
  allowedLineEvents,
  canTransitionLine,
  canTransitionRequest,
  deriveRequestStatus,
  describeDerivedStatus,
  isLineAwaitingProvider,
  isLineCovered,
  isLineTerminal,
  transitionLine,
  transitionRequest,
  type LineEvent,
  type RequestEvent,
} from '@/domain/requests/state-machine';

/**
 * Lifecycle transitions (CLAUDE.md §29: "Unit-test all valid and invalid transitions").
 *
 * Valid transitions are asserted individually; the invalid ones are asserted
 * exhaustively — every status is tried against every event, and anything not explicitly
 * permitted must throw. That is the only way to be sure a status cannot be reached by an
 * unintended route.
 */

const ALL_LINE_EVENTS: readonly LineEvent[] = [
  'submit', 'offer_sent', 'provider_viewed', 'acknowledge', 'decline',
  'expire', 'rematch', 'assign', 'release', 'start', 'complete', 'cancel', 'fail',
];

const ALL_REQUEST_EVENTS: readonly RequestEvent[] = [
  'submit_for_confirmation', 'confirm', 'begin_sourcing', 'derive', 'cancel', 'fail',
];

describe('the service-line happy path', () => {
  it('walks draft → matching → offered → acknowledged → assigned → completed', () => {
    let status: RequestLineStatus = 'draft';
    status = transitionLine(status, 'submit');
    expect(status).toBe('matching');
    status = transitionLine(status, 'offer_sent');
    expect(status).toBe('offered');
    status = transitionLine(status, 'acknowledge');
    expect(status).toBe('acknowledged');
    status = transitionLine(status, 'assign');
    expect(status).toBe('assigned');
    status = transitionLine(status, 'start');
    expect(status).toBe('in_progress');
    status = transitionLine(status, 'complete');
    expect(status).toBe('completed');
  });

  it('records that a provider opened the offer without changing the outcome', () => {
    const seen = transitionLine('offered', 'provider_viewed');
    expect(seen).toBe('waiting');
    // Both states accept exactly the same responses.
    expect(transitionLine('waiting', 'acknowledge')).toBe('acknowledged');
    expect(transitionLine('offered', 'acknowledge')).toBe('acknowledged');
  });
});

describe('decline and timeout both lead back to matching', () => {
  it('a decline moves the line to declined, then re-matches', () => {
    const declined = transitionLine('offered', 'decline');
    expect(declined).toBe('declined');
    expect(transitionLine(declined, 'rematch')).toBe('matching');
  });

  it('an expiry moves the line to rematching', () => {
    expect(transitionLine('offered', 'expire')).toBe('rematching');
    expect(transitionLine('waiting', 'expire')).toBe('rematching');
  });

  it('a line with no providers left fails rather than looping', () => {
    expect(transitionLine('matching', 'fail')).toBe('failed');
    expect(transitionLine('rematching', 'fail')).toBe('failed');
    expect(transitionLine('declined', 'fail')).toBe('failed');
  });

  it('a failed line can be re-matched after operations intervenes', () => {
    expect(transitionLine('failed', 'rematch')).toBe('matching');
  });

  it('a provider who acknowledged but cannot deliver can still decline', () => {
    expect(transitionLine('acknowledged', 'decline')).toBe('declined');
  });

  it('releasing resources returns an assigned line to acknowledged, not to matching', () => {
    // The provider is still committed; only the concrete resources were given back.
    expect(transitionLine('assigned', 'release')).toBe('acknowledged');
  });
});

describe('invalid transitions are exhaustively refused', () => {
  it('every status/event pair not explicitly permitted throws', () => {
    for (const status of requestLineStatuses) {
      const allowed = new Set(allowedLineEvents(status));
      for (const event of ALL_LINE_EVENTS) {
        if (allowed.has(event)) {
          expect(() => transitionLine(status, event)).not.toThrow();
        } else {
          expect(() => transitionLine(status, event)).toThrow(/cannot handle/);
          expect(canTransitionLine(status, event)).toBe(false);
        }
      }
    }
  });

  it('a completed line accepts nothing at all', () => {
    for (const event of ALL_LINE_EVENTS) {
      expect(canTransitionLine('completed', event)).toBe(false);
    }
  });

  it('a cancelled line accepts nothing at all', () => {
    for (const event of ALL_LINE_EVENTS) {
      expect(canTransitionLine('cancelled', event)).toBe(false);
    }
  });

  it('a line cannot be assigned before it is acknowledged', () => {
    for (const status of ['draft', 'matching', 'offered', 'waiting', 'declined', 'rematching'] as const) {
      expect(canTransitionLine(status, 'assign')).toBe(false);
    }
  });

  it('a line cannot be acknowledged before an offer exists', () => {
    for (const status of ['draft', 'matching', 'rematching'] as const) {
      expect(canTransitionLine(status, 'acknowledge')).toBe(false);
    }
  });

  it('a line cannot skip straight from matching to completed', () => {
    expect(canTransitionLine('matching', 'complete')).toBe(false);
  });

  it('the thrown error names what would have been allowed', () => {
    try {
      transitionLine('completed', 'assign');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).toMatch(/cannot handle "assign"/);
    }
  });
});

describe('cancellation', () => {
  it('is possible from every non-terminal status', () => {
    for (const status of requestLineStatuses) {
      if (isLineTerminal(status)) continue;
      expect(canTransitionLine(status, 'cancel')).toBe(true);
    }
  });

  it('is not possible from a terminal status', () => {
    expect(canTransitionLine('completed', 'cancel')).toBe(false);
    expect(canTransitionLine('cancelled', 'cancel')).toBe(false);
  });
});

describe('line predicates', () => {
  it('classifies coverage correctly', () => {
    expect(isLineCovered('acknowledged')).toBe(true);
    expect(isLineCovered('assigned')).toBe(true);
    expect(isLineCovered('in_progress')).toBe(true);
    expect(isLineCovered('completed')).toBe(true);

    expect(isLineCovered('matching')).toBe(false);
    expect(isLineCovered('offered')).toBe(false);
    expect(isLineCovered('declined')).toBe(false);
    expect(isLineCovered('failed')).toBe(false);
  });

  it('classifies awaiting-provider correctly', () => {
    expect(isLineAwaitingProvider('offered')).toBe(true);
    expect(isLineAwaitingProvider('waiting')).toBe(true);
    expect(isLineAwaitingProvider('acknowledged')).toBe(false);
  });
});

describe('derived request status', () => {
  it('is confirmed only when every line is covered', () => {
    expect(deriveRequestStatus('sourcing', ['acknowledged', 'assigned'])).toBe('confirmed');
    expect(deriveRequestStatus('sourcing', ['acknowledged', 'offered'])).toBe('partial');
  });

  it('is partial when some lines are covered and others are not', () => {
    expect(deriveRequestStatus('sourcing', ['assigned', 'matching'])).toBe('partial');
    expect(deriveRequestStatus('sourcing', ['assigned', 'failed'])).toBe('partial');
  });

  it('is failed only when EVERY line failed', () => {
    expect(deriveRequestStatus('sourcing', ['failed', 'failed'])).toBe('failed');
    // One good line means the request is still worth saving.
    expect(deriveRequestStatus('sourcing', ['failed', 'acknowledged'])).toBe('partial');
  });

  it('is completed only when every live line is completed', () => {
    expect(deriveRequestStatus('in_progress', ['completed', 'completed'])).toBe('completed');
    expect(deriveRequestStatus('in_progress', ['completed', 'assigned'])).toBe('in_progress');
  });

  it('ignores individually cancelled lines when judging completion', () => {
    expect(deriveRequestStatus('in_progress', ['completed', 'cancelled'])).toBe('completed');
    expect(deriveRequestStatus('sourcing', ['acknowledged', 'cancelled'])).toBe('confirmed');
  });

  it('is cancelled when every line was cancelled', () => {
    expect(deriveRequestStatus('sourcing', ['cancelled', 'cancelled'])).toBe('cancelled');
  });

  it('shows in_progress as soon as any line is under way', () => {
    expect(deriveRequestStatus('confirmed', ['in_progress', 'assigned'])).toBe('in_progress');
  });

  it('never leaves a cancelled request', () => {
    for (const statuses of [['acknowledged'], ['completed'], ['failed']] as const) {
      expect(deriveRequestStatus('cancelled', statuses)).toBe('cancelled');
    }
  });

  it('leaves a draft alone — derivation begins after confirmation', () => {
    expect(deriveRequestStatus('draft', ['matching'])).toBe('draft');
    expect(deriveRequestStatus('awaiting_confirmation', ['matching'])).toBe('awaiting_confirmation');
  });

  it('is sourcing while work is in flight with nothing covered yet', () => {
    expect(deriveRequestStatus('sent', ['matching', 'offered'])).toBe('sourcing');
  });

  it('always returns a declared status, whatever the line mix', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...requestStatuses),
        fc.array(fc.constantFrom(...requestLineStatuses), { maxLength: 8 }),
        (current, lines) => {
          const derived = deriveRequestStatus(current, lines);
          expect(requestStatuses).toContain(derived);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('is idempotent — deriving twice changes nothing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...requestStatuses),
        fc.array(fc.constantFrom(...requestLineStatuses), { minLength: 1, maxLength: 8 }),
        (current, lines) => {
          const once = deriveRequestStatus(current, lines);
          expect(deriveRequestStatus(once, lines)).toBe(once);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never reports confirmed while any live line is uncovered', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...requestLineStatuses), { minLength: 1, maxLength: 8 }),
        (lines) => {
          const derived = deriveRequestStatus('sourcing', lines);
          if (derived !== 'confirmed') return;
          const live = lines.filter((line) => line !== 'cancelled');
          expect(live.every(isLineCovered)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('describes every derived status in words', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...requestLineStatuses), { minLength: 1, maxLength: 6 }),
        (lines) => {
          const derived = deriveRequestStatus('sourcing', lines);
          const description = describeDerivedStatus(derived, lines);
          expect(description.length).toBeGreaterThan(0);
          expect(description).not.toMatch(/undefined|NaN/);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('request transitions', () => {
  it('walks draft → awaiting_confirmation → sent → sourcing', () => {
    let status: RequestStatus = 'draft';
    status = transitionRequest(status, 'submit_for_confirmation');
    expect(status).toBe('awaiting_confirmation');
    status = transitionRequest(status, 'confirm');
    expect(status).toBe('sent');
    status = transitionRequest(status, 'begin_sourcing');
    expect(status).toBe('sourcing');
  });

  it('refuses every pair not explicitly permitted', () => {
    for (const status of requestStatuses) {
      for (const event of ALL_REQUEST_EVENTS) {
        if (canTransitionRequest(status, event)) {
          expect(() => transitionRequest(status, event)).not.toThrow();
        } else {
          expect(() => transitionRequest(status, event)).toThrow(/cannot handle/);
        }
      }
    }
  });

  it('cannot confirm a request twice', () => {
    expect(canTransitionRequest('sent', 'confirm')).toBe(false);
  });

  it('cannot revive a completed request', () => {
    for (const event of ALL_REQUEST_EVENTS) {
      expect(canTransitionRequest('completed', event)).toBe(false);
    }
  });
});
