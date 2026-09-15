import '@/lib/server-guard';
import { eq, inArray } from 'drizzle-orm';
import { getDb, type Executor } from '@/db/client';
import { airports, fbos, serviceCategories, type Airport, type Fbo, type ServiceCategory } from '@/db/schema';
import { validateRequirements } from '@/domain/services/requirements';
import { listActiveServiceCategories } from '@/domain/services/resolve';
import type { Clarification, IntakeDraft, IntakeSource, ResolvedServiceLine, ResolvedTime } from '@/domain/requests/intake';
import { formatWallTime, parseWallTime, resolveLocalWallTime, type WallTime } from '@/lib/time';

/**
 * Rebuilding a draft between clarification rounds.
 *
 * Clarification is conversational, so the draft has to survive several exchanges. It is NOT
 * persisted — no table, no session store — because a draft is not yet a request and giving
 * it a row would make it one. The browser carries the state and posts it back.
 *
 * Which means none of it is trusted. Every identifier that arrives here is re-read from the
 * database: the airport must exist and be active, the handler must belong to that airport,
 * each service category must be active, and the local times are converted in the airport's
 * own zone — exactly the checks `confirmRequestAction` performs, applied a round earlier so
 * the user learns about a problem while they can still fix it (CLAUDE.md §27).
 *
 * The client's sentence is carried verbatim throughout and never rewritten (CLAUDE.md §22).
 */

export interface DraftServiceState {
  readonly token: string;
  readonly categoryId: string | null;
  readonly quantity: number | null;
  readonly requirements: Record<string, unknown>;
}

export interface DraftState {
  readonly sourceSentence: string;
  readonly source: IntakeSource;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly aiUnavailableReason: string | null;

  readonly airportId: string | null;
  readonly airportToken: string | null;
  /**
   * The airports an ambiguous token matched.
   *
   * Carried as IDS and re-read on the way back in. Without this the second round asks
   * "which airport did you mean?" and offers nothing to choose from — the question survives
   * the round trip but its answers do not, which is worse than not asking.
   */
  readonly airportCandidateIds: readonly string[];
  readonly fboId: string | null;

  readonly arrivalLocal: string | null;
  readonly departureLocal: string | null;

  readonly passengers: number | null;
  readonly crew: number | null;
  readonly aircraftToken: string | null;
  readonly notes: string | null;

  readonly services: readonly DraftServiceState[];
  /** Carried forward so the model's own words about an ambiguity survive the round trip. */
  readonly ambiguities: readonly Clarification[];

  /** Optional questions the user waved away. Never asked again. */
  readonly skipped: readonly string[];
  /** How many times each question has been asked and still not resolved. */
  readonly attempts: Readonly<Record<string, number>>;
}

/** The round-trippable state of a draft, for the browser to hold between rounds. */
export function toDraftState(draft: IntakeDraft): DraftState {
  return {
    sourceSentence: draft.sourceSentence,
    source: draft.source,
    confidence: draft.confidence,
    aiUnavailableReason: draft.aiUnavailableReason,

    airportId: draft.airport?.id ?? null,
    airportToken: draft.airportToken,
    airportCandidateIds: draft.airportCandidates.map((candidate) => candidate.airport.id),
    fboId: draft.fbo?.id ?? null,

    arrivalLocal: draft.arrival === null ? null : formatWallTime(draft.arrival.wall),
    departureLocal: draft.departure === null ? null : formatWallTime(draft.departure.wall),

    passengers: draft.passengers,
    crew: draft.crew,
    aircraftToken: draft.aircraftToken,
    notes: draft.notes,

    services: draft.services.map((service) => ({
      token: service.token,
      categoryId: service.category?.id ?? null,
      quantity: service.quantity,
      requirements: service.requirements,
    })),
    ambiguities: draft.clarifications.filter((item) => item.severity === 'advisory'),
    skipped: [],
    attempts: {},
  };
}

/** The value meaning "I do not mind" — only ever accepted for an optional field. */
export const NO_PREFERENCE = '__no_preference__';

export interface AnswerSet {
  /** Clarification item id to the answer given. */
  readonly [itemId: string]: string;
}

/**
 * Folds a round of answers into the draft state.
 *
 * Three properties matter here, and each is a test:
 *
 *  1. **Nothing already known is lost.** Answers are merged into the existing state; a value
 *     resolved two rounds ago is still there.
 *  2. **One answer can settle several questions.** Answers are keyed by field, so choosing a
 *     category resolves that service's identity and every question that hung off it.
 *  3. **An answer can raise a new question.** Setting a field may satisfy a conditional
 *     dependency, and the next plan asks for what that condition unlocked.
 *
 * It is pure: it rewrites state, and `rebuildDraft` then re-checks all of it against the
 * database. Nothing here decides whether an answer is acceptable.
 */
export function applyAnswers(state: DraftState, answers: AnswerSet): DraftState {
  let next: DraftState = state;
  const skipped = new Set(state.skipped);

  const services = state.services.map((service) => ({
    ...service,
    requirements: { ...service.requirements },
  }));

  for (const [itemId, rawValue] of Object.entries(answers)) {
    const value = rawValue.trim();
    if (value === '') continue;

    if (value === NO_PREFERENCE) {
      skipped.add(itemId);
      continue;
    }

    if (itemId === 'trip.airport') {
      // The id is re-read from the database by `rebuildDraft`; an invalid one resolves to
      // no airport and the question is simply asked again.
      next = { ...next, airportId: value };
      continue;
    }
    if (itemId === 'trip.fbo') {
      next = { ...next, fboId: value };
      continue;
    }
    if (itemId === 'trip.arrival') {
      next = { ...next, arrivalLocal: value };
      continue;
    }
    if (itemId === 'trip.departure') {
      next = { ...next, departureLocal: value };
      continue;
    }
    if (itemId === 'trip.services') {
      services.push({ token: value, categoryId: value, quantity: null, requirements: {} });
      continue;
    }

    const match = /^service\.(\d+)\.(.+)$/.exec(itemId);
    if (match === null) continue;

    const index = Number(match[1]);
    const field = match[2] as string;
    const service = services[index];
    if (service === undefined) continue;

    if (field === 'category') {
      services[index] = { ...service, categoryId: value };
      continue;
    }

    services[index] = {
      ...service,
      requirements: { ...service.requirements, [field]: value },
    };
  }

  return { ...next, services, skipped: [...skipped] };
}

/**
 * Counts a question as attempted when it was answered this round and is STILL outstanding.
 *
 * Asking again is reasonable; asking a fourth time is a loop. Past the ceiling the UI offers
 * a plain correction control instead of the same question in the same words.
 */
export function countAttempts(
  previous: Readonly<Record<string, number>>,
  answered: readonly string[],
  stillOutstanding: readonly string[],
): Record<string, number> {
  const outstanding = new Set(stillOutstanding);
  const next: Record<string, number> = { ...previous };

  for (const itemId of answered) {
    if (outstanding.has(itemId)) next[itemId] = (next[itemId] ?? 0) + 1;
  }

  return next;
}

/**
 * Re-resolves a posted state into a draft, entirely from database rows.
 *
 * A row that has gone inactive since the previous round is dropped rather than carried: the
 * question it raises ("which airport, then?") is better than a request against an airport
 * the platform no longer serves.
 */
export async function rebuildDraft(
  state: DraftState,
  executor: Executor = getDb(),
): Promise<IntakeDraft> {
  const categories = await listActiveServiceCategories(executor);
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  const airport = state.airportId === null ? null : await loadAirport(state.airportId, executor);

  // Re-read rather than trusted: the browser sends ids, the database says what they are.
  const airportCandidates =
    airport !== null || state.airportCandidateIds.length === 0
      ? []
      : (await loadAirports(state.airportCandidateIds, executor)).map((candidate) => ({
          airport: candidate,
          matchedOn: 'exact_name' as const,
          score: 0,
        }));
  const availableFbos = airport === null ? [] : await loadFbos(airport.id, executor);
  const fbo =
    airport === null || state.fboId === null
      ? null
      : (availableFbos.find((candidate) => candidate.id === state.fboId) ?? null);

  const arrival = airport === null ? null : resolveTime(state.arrivalLocal, airport.timezoneIana);
  const departure =
    airport === null ? null : resolveTime(state.departureLocal, airport.timezoneIana);

  const services: ResolvedServiceLine[] = state.services.map((service) => {
    const category = service.categoryId === null ? null : (categoryById.get(service.categoryId) ?? null);

    if (category === null) {
      return {
        token: service.token,
        category: null,
        candidates: [],
        quantity: service.quantity,
        requirements: service.requirements,
        requirementIssues: [],
      };
    }

    const validation = validateRequirements(
      category.code,
      category.configSchemaJson,
      service.requirements,
    );

    return {
      token: service.token,
      category,
      candidates: [],
      quantity: service.quantity,
      // A valid set is replaced by the PARSED value, so "3" typed into a number field is
      // stored as 3 and the next round sees it as answered.
      requirements: validation.ok ? validation.value : service.requirements,
      requirementIssues: validation.ok ? [] : validation.issues,
    };
  });

  return {
    sourceSentence: state.sourceSentence,
    source: state.source,
    confidence: state.confidence,

    airport,
    airportCandidates,
    airportToken: state.airportToken,

    fbo,
    fboCandidates: [],
    availableFbos,

    arrival,
    departure,

    passengers: state.passengers,
    crew: state.crew,
    aircraftToken: state.aircraftToken,

    services,
    notes: state.notes,
    clarifications: state.ambiguities,
    aiUnavailableReason: state.aiUnavailableReason,
  };
}

async function loadAirport(id: string, executor: Executor): Promise<Airport | null> {
  const [row] = await executor.select().from(airports).where(eq(airports.id, id)).limit(1);
  return row !== undefined && row.active ? row : null;
}

async function loadAirports(ids: readonly string[], executor: Executor): Promise<Airport[]> {
  const rows = await executor.select().from(airports).where(inArray(airports.id, [...ids]));
  return rows.filter((row) => row.active).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadFbos(airportId: string, executor: Executor): Promise<Fbo[]> {
  const rows = await executor.select().from(fbos).where(eq(fbos.airportId, airportId));
  return rows.filter((row) => row.active).sort((a, b) => a.name.localeCompare(b.name));
}

/** Only for the category-choice answer, which names a category that must still be active. */
export async function loadActiveCategories(
  ids: readonly string[],
  executor: Executor = getDb(),
): Promise<ServiceCategory[]> {
  if (ids.length === 0) return [];
  const rows = await executor
    .select()
    .from(serviceCategories)
    .where(inArray(serviceCategories.id, [...ids]));
  return rows.filter((row) => row.active);
}

/**
 * Converts a local wall time in the airport's zone.
 *
 * Identical in behaviour to the intake path's own resolution — a DST gap or a doubled hour
 * is reported, never coerced (CLAUDE.md §7).
 */
function resolveTime(local: string | null, timezone: string): ResolvedTime | null {
  if (local === null || local === '') return null;

  const wall = parseWallTime(local);
  if (wall === null) return null;

  const resolution = resolveLocalWallTime(wall, timezone);
  const display = formatWallTime(wall).replace('T', ' ');

  if (resolution.kind === 'ok') {
    return { wall, display, instantUtc: resolution.instant, problem: null };
  }

  if (resolution.kind === 'ambiguous') {
    return {
      wall,
      display,
      instantUtc: null,
      problem: {
        kind: 'ambiguous',
        options: resolution.options.map((option) => ({
          instant: option.instant,
          label: `${display} (UTC${formatOffset(option.offsetMinutes)})`,
        })),
      },
    };
  }

  return {
    wall,
    display,
    instantUtc: null,
    problem: {
      kind: 'nonexistent',
      suggestions: resolution.suggestions.map((suggestion) => ({
        instant: suggestion.instant,
        label: formatWallTime(suggestion.wall).replace('T', ' '),
      })),
    },
  };
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

export type { WallTime };
