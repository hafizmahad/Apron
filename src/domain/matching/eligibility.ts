import {
  durationMinutes,
  isWithinOpeningHours,
  overlaps,
  type Interval,
  type OpeningWindow,
} from '@/lib/time';
import type { RejectionReasonCode } from './reasons';
import { checkServiceRules } from './services';
import type {
  EligibilityInput,
  EligibilityResult,
  MatchingContext,
  OpeningSchedule,
  ProviderCandidate,
  ResourceCommitment,
  ServiceLineSnapshot,
} from './types';

/**
 * The deterministic oracle (CLAUDE.md §9, ADR-009).
 *
 * PURE. No database import, no network, no `Date.now()`, no randomness — the module
 * boundary is enforced by `tests/unit/boundaries/matching.test.ts`. Given the same
 * snapshot it always returns the same answer, which is what makes a decision trace
 * reproducible months later and lets the eval suite call these exact functions.
 *
 * Order of checks is deliberate: cheap, structural disqualifications first (governance,
 * coverage), then timing, then capacity, then the expensive per-service concrete-resource
 * rules. A candidate accumulates ALL applicable reasons rather than short-circuiting on
 * the first, because operations needs the full picture — "not approved AND outside desk
 * hours" is more useful than either alone.
 */

export const ENGINE_VERSION = '2.0.0';

/** Evaluates one provider against one service line. */
export function couldProviderCover(
  context: MatchingContext,
  line: ServiceLineSnapshot,
  candidate: ProviderCandidate,
): EligibilityResult {
  const reasons: RejectionReasonCode[] = [];

  checkGovernance(context, candidate, reasons);
  checkCoverage(context, line, candidate, reasons);

  const window = line.serviceWindow;
  if (window === null) {
    reasons.push('service_window_unknown');
    return reject(candidate, reasons);
  }

  const leadTimeMarginMinutes = checkTiming(context, window, candidate, reasons);
  const spareCapacity = checkCapacity(line, candidate, reasons);

  // Per-service concrete-resource rules run even when something above already failed, so
  // the trace shows every reason at once rather than one at a time across re-matches.
  const serviceOutcome = checkServiceRules({ context, line, candidate, window });
  reasons.push(...serviceOutcome.reasonCodes);

  const eligible = reasons.length === 0;

  return {
    providerCompanyId: candidate.providerCompanyId,
    displayName: candidate.displayName,
    eligible,
    reasonCodes: dedupe(reasons),
    spareCapacity: eligible ? spareCapacity : 0,
    leadTimeMarginMinutes,
    feasibleResourceIds: eligible ? serviceOutcome.feasibleResourceIds : [],
  };
}

/** Evaluates every candidate. Never throws on a single bad candidate. */
export function evaluateCandidates(input: EligibilityInput): EligibilityResult[] {
  return input.candidates.map((candidate) =>
    couldProviderCover(input.context, input.line, candidate),
  );
}

// ---------------------------------------------------------------------------
// individual checks
// ---------------------------------------------------------------------------

function checkGovernance(
  context: MatchingContext,
  candidate: ProviderCandidate,
  reasons: RejectionReasonCode[],
): void {
  if (candidate.status !== 'approved') {
    reasons.push('provider_not_approved');
  }
  if (!candidate.active) {
    reasons.push('provider_inactive');
  }
  if (context.excludedProviderIds.includes(candidate.providerCompanyId)) {
    reasons.push('provider_excluded_by_previous_decline');
  }
}

function checkCoverage(
  context: MatchingContext,
  line: ServiceLineSnapshot,
  candidate: ProviderCandidate,
  reasons: RejectionReasonCode[],
): void {
  const coverage = candidate.coverage;

  if (coverage.serviceCategoryId !== line.serviceCategoryId) {
    reasons.push('service_not_offered');
  }
  if (coverage.airportId !== context.airportId) {
    reasons.push('airport_not_covered');
  }
  if (!coverage.active) {
    reasons.push('coverage_inactive');
  }

  // FBO-scoped coverage only satisfies a request naming that same FBO. Airport-wide
  // coverage satisfies any FBO at the airport — but a NULL is never "everywhere":
  // `airportId` above has already pinned the location (CLAUDE.md §6).
  if (coverage.fboId !== null && coverage.fboId !== context.fboId) {
    reasons.push('fbo_not_covered');
  }
}

/**
 * Returns the lead-time margin in minutes: how much earlier than the provider's cutoff
 * the request arrived. Negative means the cutoff has passed. Used by the ranker as a
 * comfort signal, and reported in the trace either way.
 */
function checkTiming(
  context: MatchingContext,
  window: Interval,
  candidate: ProviderCandidate,
  reasons: RejectionReasonCode[],
): number {
  const coverage = candidate.coverage;

  const noticeMinutes = Math.floor(
    (window.start.getTime() - context.evaluationNow.getTime()) / 60_000,
  );
  const leadTimeMarginMinutes = noticeMinutes - coverage.leadTimeMinutes;

  if (leadTimeMarginMinutes < 0) {
    reasons.push('lead_time_insufficient');
  }

  if (coverage.maxNoticeDays !== null) {
    const maxNoticeMinutes = coverage.maxNoticeDays * 24 * 60;
    if (noticeMinutes > maxNoticeMinutes) {
      reasons.push('booked_too_far_ahead');
    }
  }

  if (!isScheduleOpenThroughout(coverage.schedule, window)) {
    reasons.push('outside_desk_hours');
  }

  if (candidate.blackouts.some((blackout) => overlaps(blackout.interval, window))) {
    reasons.push('blackout_window');
  }

  return leadTimeMarginMinutes;
}

/**
 * Spare capacity is `totalCapacity - committedUnitsInWindow`, compared against the
 * quantity the line asks for. `committedUnitsInWindow` is derived from real overlapping
 * assignments by the caller, never from a stored counter that could drift.
 */
function checkCapacity(
  line: ServiceLineSnapshot,
  candidate: ProviderCandidate,
  reasons: RejectionReasonCode[],
): number {
  const spare = candidate.coverage.totalCapacity - candidate.coverage.committedUnitsInWindow;
  if (spare < line.quantity) {
    reasons.push('provider_capacity_exhausted');
  }
  return Math.max(0, spare);
}

// ---------------------------------------------------------------------------
// shared helpers, also used by the per-service rules
// ---------------------------------------------------------------------------

/** True when the schedule covers the whole interval. A 24/7 schedule always does. */
export function isScheduleOpenThroughout(schedule: OpeningSchedule, interval: Interval): boolean {
  if (schedule.is247) return true;
  if (schedule.windows.length === 0) return false;
  return isWithinOpeningHours(toOpeningWindows(schedule), schedule.timezone, interval);
}

function toOpeningWindows(schedule: OpeningSchedule): OpeningWindow[] {
  return schedule.windows.map((window) => ({
    weekday: window.weekday,
    openMinute: window.openMinute,
    closeMinute: window.closeMinute,
  }));
}

/**
 * True when none of the resource's existing commitments overlaps `window`.
 *
 * Uses the same half-open `[start, end)` comparison as the Postgres exclusion constraint,
 * so the engine and the database can never disagree about what a conflict is — a
 * back-to-back handover at the exact boundary is free in both.
 */
export function isFreeThroughout(
  commitments: readonly ResourceCommitment[],
  window: Interval,
): boolean {
  return !commitments.some((commitment) => overlaps(commitment.interval, window));
}

/** Units of a pooled resource already committed across `window`. */
export function committedQuantityIn(
  commitments: readonly ResourceCommitment[],
  window: Interval,
): number {
  return commitments
    .filter((commitment) => overlaps(commitment.interval, window))
    .reduce((total, commitment) => total + commitment.quantity, 0);
}

/** Length of the service window in whole minutes. */
export function windowMinutes(window: Interval): number {
  return durationMinutes(window);
}

function reject(candidate: ProviderCandidate, reasons: RejectionReasonCode[]): EligibilityResult {
  return {
    providerCompanyId: candidate.providerCompanyId,
    displayName: candidate.displayName,
    eligible: false,
    reasonCodes: dedupe(reasons),
    spareCapacity: 0,
    leadTimeMarginMinutes: null,
    feasibleResourceIds: [],
  };
}

/** Stable order, no duplicates — the trace must read the same on every evaluation. */
function dedupe(reasons: readonly RejectionReasonCode[]): RejectionReasonCode[] {
  return [...new Set(reasons)];
}
