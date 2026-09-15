'use server';

import '@/lib/server-guard';
import { z } from 'zod';
import { requireActor } from '@/auth/context';
import { can } from '@/domain/permissions';
import {
  clarificationPlanFor,
  isDraftDispatchable,
  runIntake,
  type IntakeDraft,
} from '@/domain/requests/intake';
import { listActiveServiceCategories } from '@/domain/services/resolve';
import {
  applyAnswers,
  countAttempts,
  rebuildDraft,
  toDraftState,
  type DraftState,
} from '@/domain/requests/draft-state';
import type { ClarificationPlan } from '@/domain/requests/clarification';
import type { ServiceCategory } from '@/db/schema';
import { formatWallTime } from '@/lib/time';
import { ApronError } from '@/lib/errors';
import { checkRateLimit } from '@/lib/rate-limit';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';

/**
 * Intake server actions.
 *
 * Reading a sentence is a READ: it resolves tokens against the registry and returns a
 * draft. Nothing is persisted and nothing is dispatched until the user confirms the
 * read-back (CLAUDE.md §8 step 3: "Nothing is dispatched before confirmation").
 */

const composeSchema = z.object({
  sentence: z.string().trim().min(3, 'Describe the request in a sentence').max(4000),
  referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  referenceTimezone: z.string().min(1).max(64),
});

/** What the composer renders. Plain data — no database rows leak to the client. */
export interface ComposeResult {
  readonly status: 'ok' | 'error';
  readonly message?: string;
  readonly draft?: SerializableDraft;
}

export interface SerializableDraft {
  readonly sourceSentence: string;
  readonly source: 'ai' | 'deterministic';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly aiUnavailableReason: string | null;
  readonly dispatchable: boolean;

  readonly airport: { id: string; label: string; city: string; timezone: string } | null;
  readonly airportToken: string | null;
  readonly airportCandidates: readonly { id: string; label: string; city: string }[];

  readonly fbo: { id: string; name: string } | null;
  readonly availableFbos: readonly { id: string; name: string }[];

  /**
   * `local` is the wall-clock reading at the airport, `YYYY-MM-DDTHH:mm`, and it is what
   * confirmation posts back. The instant is for display only: converting a local time to
   * an instant needs the airport's zone, and the server does that once, on confirm
   * (CLAUDE.md §7).
   */
  readonly arrival: { display: string; local: string; instantUtc: string | null } | null;
  readonly departure: { display: string; local: string; instantUtc: string | null } | null;

  readonly passengers: number | null;
  readonly crew: number | null;
  readonly aircraftToken: string | null;

  readonly services: readonly {
    readonly token: string;
    readonly categoryId: string | null;
    readonly categoryName: string | null;
    readonly categoryCode: string | null;
    readonly unitLabel: string | null;
    readonly quantity: number | null;
    readonly requirements: Record<string, unknown>;
    readonly issues: readonly { key: string; label: string; message: string }[];
  }[];

  readonly notes: string | null;
  readonly clarifications: readonly {
    readonly field: string;
    readonly question: string;
    readonly options: readonly string[];
    readonly severity: 'blocking' | 'advisory';
  }[];

  /** Everything still to be settled, and whether anything blocks confirmation. */
  readonly clarification: ClarificationPlan;
  /**
   * The draft as the browser should post it back for the next round.
   *
   * It carries identifiers, not decisions: every one is re-read from the database on the
   * way back in, so this is a convenience for the conversation, not a trust boundary.
   */
  readonly state: DraftState;
}

export async function composeRequestAction(
  _previous: ComposeResult,
  formData: FormData,
): Promise<ComposeResult> {
  const correlationId = newCorrelationId();

  return withCorrelation({ correlationId, route: 'client/compose' }, async () => {
    try {
      const actor = await requireActor();

      if (!can(actor, 'request.create')) {
        throw new ApronError('forbidden', 'You do not have permission to create requests');
      }

      const parsed = composeSchema.safeParse({
        sentence: formData.get('sentence'),
        referenceDate: formData.get('referenceDate'),
        referenceTimezone: formData.get('referenceTimezone'),
      });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the request and try again.',
        };
      }

      // Reading costs a model call, so it is rate limited per user.
      const limit = await checkRateLimit({
        key: `intake:${actor.userId}`,
        limit: 30,
        windowSeconds: 300,
      });
      if (!limit.allowed) {
        return {
          status: 'error',
          message: `Too many requests in a short time. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
        };
      }

      const draft = await runIntake({
        sentence: parsed.data.sentence,
        referenceDate: parsed.data.referenceDate,
        referenceTimezone: parsed.data.referenceTimezone,
        actorUserId: actor.userId,
      });

      const categories = await listActiveServiceCategories();

      return { status: 'ok', draft: toSerializable(draft, categories, toDraftState(draft)) };
    } catch (error) {
      logError('intake compose failed', error);
      return {
        status: 'error',
        message:
          error instanceof ApronError
            ? error.publicMessage
            : 'We could not read that request. Try again, or enter the details directly.',
      };
    }
  });
}

/**
 * One round of clarification (CLAUDE.md §8 step 3).
 *
 * The browser sends the state it is holding plus the answers just given. The server merges
 * them, re-resolves EVERY identifier against the database, re-runs the catalogue's own
 * validation, and re-plans. If the answers settled everything, the plan comes back complete
 * and confirmation opens. If an answer unlocked a conditional requirement, the next question
 * is in the same response.
 *
 * No model call happens here at all. Clarification is deterministic work: configuration
 * decides what is still needed, and the user decides the value.
 */
const answerSchema = z.object({
  state: z.custom<DraftState>((value) => typeof value === 'object' && value !== null),
  answers: z.record(z.string().max(200), z.string().max(4000)).default({}),
});

export async function clarifyRequestAction(payload: unknown): Promise<ComposeResult> {
  const correlationId = newCorrelationId();

  return withCorrelation({ correlationId, route: 'client/clarify' }, async () => {
    try {
      const actor = await requireActor();

      if (!can(actor, 'request.create')) {
        throw new ApronError('forbidden', 'You do not have permission to create requests');
      }

      const parsed = answerSchema.safeParse(payload);
      if (!parsed.success) {
        return { status: 'error', message: 'We lost track of that draft. Read the request again.' };
      }

      const answered = Object.keys(parsed.data.answers);
      const merged = applyAnswers(parsed.data.state, parsed.data.answers);

      const draft = await rebuildDraft(merged);
      const categories = await listActiveServiceCategories();

      // Plan once to see what the answers left outstanding, so an attempt can be counted
      // against the questions that were actually tried and did not stick.
      const provisional = clarificationPlanFor(draft, categories, merged.attempts, merged.skipped);
      const attempts = countAttempts(
        merged.attempts,
        answered,
        provisional.items.map((item) => item.id),
      );

      return {
        status: 'ok',
        draft: toSerializable(draft, categories, { ...merged, attempts }),
      };
    } catch (error) {
      logError('intake clarification failed', error);
      return {
        status: 'error',
        message:
          error instanceof ApronError
            ? error.publicMessage
            : 'We could not apply that answer. Try again.',
      };
    }
  });
}

function toSerializable(
  draft: IntakeDraft,
  categories: readonly ServiceCategory[],
  state: DraftState,
): SerializableDraft {
  return {
    sourceSentence: draft.sourceSentence,
    source: draft.source,
    confidence: draft.confidence,
    aiUnavailableReason: draft.aiUnavailableReason,
    dispatchable: isDraftDispatchable(draft, categories),

    airport:
      draft.airport === null
        ? null
        : {
            id: draft.airport.id,
            label:
              draft.airport.icao === null
                ? draft.airport.name
                : `${draft.airport.name} (${draft.airport.icao})`,
            city: draft.airport.city,
            timezone: draft.airport.timezoneIana,
          },
    airportToken: draft.airportToken,
    airportCandidates: draft.airportCandidates.map((candidate) => ({
      id: candidate.airport.id,
      label:
        candidate.airport.icao === null
          ? candidate.airport.name
          : `${candidate.airport.name} (${candidate.airport.icao})`,
      city: candidate.airport.city,
    })),

    fbo: draft.fbo === null ? null : { id: draft.fbo.id, name: draft.fbo.name },
    availableFbos: draft.availableFbos.map((fbo) => ({ id: fbo.id, name: fbo.name })),

    arrival:
      draft.arrival === null
        ? null
        : {
            display: draft.arrival.display,
            local: formatWallTime(draft.arrival.wall),
            instantUtc: draft.arrival.instantUtc?.toISOString() ?? null,
          },
    departure:
      draft.departure === null
        ? null
        : {
            display: draft.departure.display,
            local: formatWallTime(draft.departure.wall),
            instantUtc: draft.departure.instantUtc?.toISOString() ?? null,
          },

    passengers: draft.passengers,
    crew: draft.crew,
    aircraftToken: draft.aircraftToken,

    services: draft.services.map((service) => ({
      token: service.token,
      categoryId: service.category?.id ?? null,
      categoryName: service.category?.name ?? null,
      categoryCode: service.category?.code ?? null,
      unitLabel: service.category?.unitLabel ?? null,
      quantity: service.quantity,
      requirements: service.requirements,
      issues: service.requirementIssues,
    })),

    notes: draft.notes,
    clarifications: draft.clarifications,
    clarification: clarificationPlanFor(draft, categories, state.attempts, state.skipped),
    state,
  };
}
