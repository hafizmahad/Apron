import '@/lib/server-guard';
import { getDb, type Executor } from '@/db/client';
import type { Airport, Fbo, ServiceCategory } from '@/db/schema';
import { runStructured, isAiAvailable } from '@/ai/client';
import { intakeExtractionPrompt } from '@/ai/intake/prompt';
import { emptyExtraction, type IntakeExtraction } from '@/ai/intake/schema';
import {
  describeAirport,
  listFbosForAirport,
  resolveAirportToken,
  resolveFboToken,
  type AirportCandidate,
} from '@/domain/airports/resolve';
import {
  listActiveServiceCategories,
  resolveServiceTokenAgainst,
} from '@/domain/services/resolve';
import { validateRequirements } from '@/domain/services/requirements';
import {
  planClarifications,
  type ClarificationOption,
  type ClarificationPlan,
  type ClarificationSnapshot,
} from '@/domain/requests/clarification';
import {
  formatWallTime,
  parseWallTime,
  resolveLocalWallTime,
  type WallTime,
} from '@/lib/time';
import { logger } from '@/lib/logging';

/**
 * The intake pipeline (CLAUDE.md §8).
 *
 * The strict order matters and is the whole point:
 *
 *   1. the model reads the sentence into TOKENS — never identifiers, never instants;
 *   2. code resolves each token against the live database;
 *   3. only once the airport is known (and therefore its timezone) is the local wall time
 *      converted to an instant;
 *   4. anything ambiguous is surfaced as an explicit choice, never guessed.
 *
 * With AI unavailable the pipeline still runs: the sentence is preserved verbatim, a
 * deterministic keyword pass produces what it honestly can, and the operator completes
 * the structured form (CLAUDE.md §22, Journey E).
 */

export type IntakeSource = 'ai' | 'deterministic';

export interface ResolvedTime {
  readonly wall: WallTime;
  readonly display: string;
  readonly instantUtc: Date | null;
  /** Set when the local time is ambiguous or does not exist (a DST edge). */
  readonly problem:
    | { readonly kind: 'ambiguous'; readonly options: readonly { instant: Date; label: string }[] }
    | { readonly kind: 'nonexistent'; readonly suggestions: readonly { instant: Date; label: string }[] }
    | null;
}

export interface ResolvedServiceLine {
  readonly token: string;
  readonly category: ServiceCategory | null;
  readonly candidates: readonly ServiceCategory[];
  readonly quantity: number | null;
  readonly requirements: Record<string, unknown>;
  readonly requirementIssues: readonly { key: string; label: string; message: string }[];
}

export interface IntakeDraft {
  /** Exactly what the user typed. Never rewritten (CLAUDE.md §22). */
  readonly sourceSentence: string;
  readonly source: IntakeSource;
  readonly confidence: 'high' | 'medium' | 'low';

  readonly airport: Airport | null;
  readonly airportCandidates: readonly AirportCandidate[];
  readonly airportToken: string | null;

  readonly fbo: Fbo | null;
  readonly fboCandidates: readonly Fbo[];
  readonly availableFbos: readonly Fbo[];

  readonly arrival: ResolvedTime | null;
  readonly departure: ResolvedTime | null;

  readonly passengers: number | null;
  readonly crew: number | null;
  readonly aircraftToken: string | null;

  readonly services: readonly ResolvedServiceLine[];
  readonly notes: string | null;

  /** Everything a person must decide before this can be dispatched. */
  readonly clarifications: readonly Clarification[];
  readonly aiUnavailableReason: string | null;
}

export interface Clarification {
  readonly field: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly severity: 'blocking' | 'advisory';
}

export interface IntakeInput {
  readonly sentence: string;
  /** The local date the user is composing on, `YYYY-MM-DD`. Supplied, never assumed. */
  readonly referenceDate: string;
  readonly referenceTimezone: string;
  readonly actorUserId?: string | null;
}

export async function runIntake(
  input: IntakeInput,
  executor: Executor = getDb(),
): Promise<IntakeDraft> {
  const sentence = input.sentence.trim();
  const categories = await listActiveServiceCategories(executor);

  let extraction: IntakeExtraction = emptyExtraction;
  let source: IntakeSource = 'deterministic';
  let aiUnavailableReason: string | null = null;

  if (isAiAvailable()) {
    const result = await runStructured(
      intakeExtractionPrompt,
      {
        sentence,
        referenceDate: input.referenceDate,
        referenceTimezone: input.referenceTimezone,
        availableServices: categories.map((category) => ({
          code: category.code,
          name: category.name,
        })),
      },
      { actorUserId: input.actorUserId ?? null },
    );

    if (result.ok) {
      extraction = result.data;
      source = 'ai';
    } else {
      // Degrade, do not fail. The operator still gets their sentence and a working form.
      aiUnavailableReason = describeAiFailure(result.reason, result.detail);
      extraction = deterministicExtraction(sentence, categories);
      logger().warn(
        { reason: result.reason, detail: result.detail },
        'intake fell back to deterministic extraction',
      );
    }
  } else {
    aiUnavailableReason = 'AI assistance is switched off for this environment.';
    extraction = deterministicExtraction(sentence, categories);
  }

  return resolveExtraction(sentence, extraction, source, aiUnavailableReason, categories, executor);
}

/**
 * Turns an extraction into resolved database rows and explicit questions.
 *
 * Exported so the eval suite can drive it with a fixed extraction and assert the
 * resolution half independently of the model (CLAUDE.md §26).
 */
export async function resolveExtraction(
  sentence: string,
  extraction: IntakeExtraction,
  source: IntakeSource,
  aiUnavailableReason: string | null,
  categories: readonly ServiceCategory[],
  executor: Executor = getDb(),
): Promise<IntakeDraft> {
  const clarifications: Clarification[] = [];

  // --- airport ------------------------------------------------------------
  let airport: Airport | null = null;
  let airportCandidates: readonly AirportCandidate[] = [];

  if (extraction.airportToken !== null) {
    const resolution = await resolveAirportToken(extraction.airportToken, executor);
    if (resolution.kind === 'resolved') {
      airport = resolution.airport;
    } else if (resolution.kind === 'ambiguous') {
      airportCandidates = resolution.candidates;
      clarifications.push({
        field: 'airport',
        question: `"${extraction.airportToken}" matches more than one airport. Which one?`,
        options: resolution.candidates.map((candidate) => describeAirport(candidate.airport)),
        severity: 'blocking',
      });
    } else {
      clarifications.push({
        field: 'airport',
        question: `We could not find an airport matching "${extraction.airportToken}". Which airport is this?`,
        options: [],
        severity: 'blocking',
      });
    }
  } else {
    clarifications.push({
      field: 'airport',
      question: 'Which airport is the aircraft arriving at?',
      options: [],
      severity: 'blocking',
    });
  }

  // --- FBO, only meaningful once the airport is known ---------------------
  let fbo: Fbo | null = null;
  let fboCandidates: readonly Fbo[] = [];
  let availableFbos: readonly Fbo[] = [];

  if (airport !== null) {
    availableFbos = await listFbosForAirport(airport.id, executor);

    if (extraction.fboToken !== null) {
      const resolution = await resolveFboToken(airport.id, extraction.fboToken, executor);
      if (resolution.kind === 'resolved') {
        fbo = resolution.fbo;
      } else if (resolution.kind === 'ambiguous') {
        fboCandidates = resolution.candidates;
        clarifications.push({
          field: 'fbo',
          question: `"${extraction.fboToken}" matches more than one handler at ${describeAirport(airport)}. Which one?`,
          options: resolution.candidates.map((candidate) => candidate.name),
          severity: 'advisory',
        });
      } else {
        clarifications.push({
          field: 'fbo',
          question: `We could not find a handler called "${extraction.fboToken}" at ${describeAirport(airport)}.`,
          options: availableFbos.map((candidate) => candidate.name),
          severity: 'advisory',
        });
      }
    }
  }

  // --- times, ONLY after the airport (and its zone) is known --------------
  const arrival = airport === null ? null : resolveTime(extraction.arrivalLocal, airport.timezoneIana);
  const departure =
    airport === null ? null : resolveTime(extraction.departureLocal, airport.timezoneIana);

  for (const [label, resolved] of [
    ['arrival', arrival],
    ['departure', departure],
  ] as const) {
    if (resolved?.problem?.kind === 'ambiguous') {
      clarifications.push({
        field: label,
        question: `The ${label} time happens twice on that date because the clocks go back. Which one?`,
        options: resolved.problem.options.map((option) => option.label),
        severity: 'blocking',
      });
    }
    if (resolved?.problem?.kind === 'nonexistent') {
      clarifications.push({
        field: label,
        question: `That ${label} time does not exist on that date because the clocks go forward. Did you mean one of these?`,
        options: resolved.problem.suggestions.map((option) => option.label),
        severity: 'blocking',
      });
    }
  }

  if (airport !== null && extraction.arrivalLocal === null && extraction.departureLocal === null) {
    clarifications.push({
      field: 'arrival',
      question: 'When does the aircraft arrive (local time at the airport)?',
      options: [],
      severity: 'blocking',
    });
  }

  // --- services -----------------------------------------------------------
  const services: ResolvedServiceLine[] = [];

  for (const [index, service] of extraction.services.entries()) {
    const resolution = resolveServiceTokenAgainst(
      categories,
      service.serviceNameToken,
      service.serviceCode,
    );

    const category = resolution.kind === 'resolved' ? resolution.category : null;
    const candidates = resolution.kind === 'ambiguous' ? resolution.candidates : [];

    let requirements: Record<string, unknown> = { ...service.requirements };
    let requirementIssues: { key: string; label: string; message: string }[] = [];

    if (category !== null) {
      const validation = validateRequirements(
        category.code,
        category.configSchemaJson,
        service.requirements,
      );
      if (validation.ok) {
        requirements = validation.value;
      } else {
        requirementIssues = [...validation.issues];
      }
    }

    if (category === null) {
      clarifications.push({
        field: `services[${index}]`,
        question:
          candidates.length > 0
            ? `"${service.serviceNameToken}" could be more than one service. Which did you mean?`
            : `We could not match "${service.serviceNameToken}" to a service we offer.`,
        options: (candidates.length > 0 ? candidates : categories).map((item) => item.name),
        severity: 'blocking',
      });
    }

    services.push({
      token: service.serviceNameToken,
      category,
      candidates,
      quantity: service.quantity,
      requirements,
      requirementIssues,
    });
  }

  if (services.length === 0) {
    clarifications.push({
      field: 'services',
      question: 'Which services are needed?',
      options: categories.map((category) => category.name),
      severity: 'blocking',
    });
  }

  // --- ambiguities the model itself flagged -------------------------------
  for (const ambiguity of extraction.ambiguities) {
    clarifications.push({
      field: ambiguity.field,
      question: ambiguity.issue,
      options: ambiguity.options,
      severity: 'advisory',
    });
  }

  return {
    sourceSentence: sentence,
    source,
    confidence: extraction.confidence,
    airport,
    airportCandidates,
    airportToken: extraction.airportToken,
    fbo,
    fboCandidates,
    availableFbos,
    arrival,
    departure,
    passengers: extraction.passengers,
    crew: extraction.crew,
    aircraftToken: extraction.aircraftToken,
    services,
    notes: extraction.notes,
    clarifications: dedupeClarifications(clarifications),
    aiUnavailableReason,
  };
}

/**
 * Converts a local wall time to an instant in the airport's zone.
 *
 * DST edges are reported, never coerced (CLAUDE.md §7). This is the only place in the
 * intake path where a conversion happens, and it cannot run before the airport is known.
 */
function resolveTime(local: string | null, timezone: string): ResolvedTime | null {
  if (local === null) return null;

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

/**
 * The AI-off extraction path (Journey E).
 *
 * Deliberately modest: it recognises service words and simple quantities, and it does NOT
 * attempt to parse dates or airports from free text. Half-guessing a date is worse than
 * leaving the field empty for a person to fill, because a wrong date looks correct.
 */
export function deterministicExtraction(
  sentence: string,
  categories: readonly ServiceCategory[],
): IntakeExtraction {
  const lowered = sentence.toLowerCase();
  const services: IntakeExtraction['services'] = [];

  const NUMBER_WORDS: Readonly<Record<string, number>> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };

  for (const category of categories) {
    const resolution = resolveServiceTokenAgainst(categories, category.name, category.code);
    if (resolution.kind !== 'resolved') continue;

    // Does the sentence mention this service at all?
    const mentioned = resolveServiceTokenAgainst(categories, lowered, null);
    const mentionsThis =
      (mentioned.kind === 'resolved' && mentioned.category.id === category.id) ||
      (mentioned.kind === 'ambiguous' && mentioned.candidates.some((c) => c.id === category.id));

    if (!mentionsThis) continue;

    // A quantity immediately before the service word, digits or words: "two cars".
    //
    // Digits are limited to one or two, and must not be part of a longer run. A three- or
    // four-digit number next to a service word is almost always a 24-hour time:
    // "PALM BEACH MONDAY 1300 TWO CARS" would otherwise be read as one thousand three
    // hundred cars — wrong, and outside the extraction schema's range, so the fallback
    // path itself would fail validation and hand the operator an error instead of a form.
    let quantity: number | null = null;
    const numberPattern = new RegExp(
      `(?<!\\d)(\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})\\s+\\w*\\s*(${escapeForRegex(category.name.toLowerCase())}|car|cars|vehicle|vehicles|bodyguard|bodyguards|officer|officers|room|rooms)`,
      'i',
    );
    const match = numberPattern.exec(lowered);
    if (match?.[1] !== undefined) {
      const raw = match[1].toLowerCase();
      const parsed = NUMBER_WORDS[raw] ?? (Number.isFinite(Number(raw)) ? Number(raw) : null);
      // Belt and braces: whatever the pattern admits must still be a quantity the schema
      // accepts. An unparseable or out-of-range reading becomes "not stated", which the
      // read-back then asks about — never a number nobody meant.
      quantity =
        parsed !== null && Number.isInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : null;
    }

    services.push({
      serviceCode: category.code as never,
      serviceNameToken: category.name,
      quantity,
      requirements: {},
    });
  }

  const missing: string[] = ['airport', 'arrival'];
  if (services.length === 0) missing.push('services');

  return {
    ...emptyExtraction,
    services,
    missingFields: missing,
    confidence: 'low',
  };
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function describeAiFailure(reason: string, detail: string): string {
  switch (reason) {
    case 'disabled':
      return 'AI assistance is switched off for this environment.';
    case 'timeout':
      return 'The reading assistant did not respond in time. Complete the details below.';
    case 'unavailable':
      return 'The reading assistant is unavailable. Complete the details below.';
    case 'schema_invalid':
      return 'The reading assistant returned something we could not use. Complete the details below.';
    case 'refused':
      return 'The reading assistant declined to read this request. Complete the details below.';
    default:
      return `The reading assistant could not help: ${detail}`;
  }
}

/** One question per field; a repeated field keeps its most severe form. */
function dedupeClarifications(items: readonly Clarification[]): Clarification[] {
  const byField = new Map<string, Clarification>();
  for (const item of items) {
    const existing = byField.get(item.field);
    if (existing === undefined || (existing.severity === 'advisory' && item.severity === 'blocking')) {
      byField.set(item.field, item);
    }
  }
  return [...byField.values()];
}

/**
 * Turns a resolved draft into the questions still outstanding.
 *
 * The snapshot is assembled here, where the database rows are, and handed to a pure engine
 * that decides what to ask. `attempts` carries how many times each question has already
 * been put, so a field that will not resolve is offered a plain correction control rather
 * than being asked a fourth time.
 */
export function clarificationPlanFor(
  draft: IntakeDraft,
  categories: readonly ServiceCategory[],
  attempts: Readonly<Record<string, number>> = {},
  skipped: readonly string[] = [],
): ClarificationPlan {
  const catalogueOptions: readonly ClarificationOption[] = categories.map((category) => ({
    value: category.id,
    label: category.name,
    ...(category.description === null ? {} : { hint: category.description }),
  }));

  const snapshot: ClarificationSnapshot = {
    airportResolved: draft.airport !== null,
    airportToken: draft.airportToken,
    airportOptions: draft.airportCandidates.map((candidate) => ({
      value: candidate.airport.id,
      label: describeAirport(candidate.airport),
      hint: candidate.airport.city,
    })),
    fboOptions: draft.availableFbos.map((fbo) => ({ value: fbo.id, label: fbo.name })),
    fboAmbiguous: draft.fbo === null && draft.fboCandidates.length > 0,
    fboToken: null,

    arrivalLocal: draft.arrival === null ? null : formatWallTime(draft.arrival.wall),
    departureLocal: draft.departure === null ? null : formatWallTime(draft.departure.wall),
    arrivalProblem: timeProblemOf(draft.arrival),
    departureProblem: timeProblemOf(draft.departure),

    services: draft.services.map((service, index) => ({
      index,
      token: service.token,
      categoryName: service.category?.name ?? null,
      categoryCode: service.category?.code ?? null,
      config: service.category?.configSchemaJson ?? null,
      categoryOptions: service.candidates.map((candidate) => ({
        value: candidate.id,
        label: candidate.name,
      })),
      quantity: service.quantity,
      unitLabel: service.category?.unitLabel ?? null,
      requirements: service.requirements,
      invalidFields: service.requirementIssues.map((issue) => issue.key),
    })),
    catalogueOptions,

    ambiguities: draft.clarifications
      .filter((item) => item.severity === 'advisory')
      .map((item) => ({ field: item.field, issue: item.question, options: item.options })),

    attempts,
    skipped,
  };

  return planClarifications(snapshot);
}

function timeProblemOf(resolved: ResolvedTime | null): ClarificationSnapshot['arrivalProblem'] {
  if (resolved?.problem == null) return null;

  return resolved.problem.kind === 'ambiguous'
    ? {
        kind: 'ambiguous',
        options: resolved.problem.options.map((option) => ({
          value: option.instant.toISOString(),
          label: option.label,
        })),
      }
    : {
        kind: 'nonexistent',
        options: resolved.problem.suggestions.map((option) => ({
          value: option.instant.toISOString(),
          label: option.label,
        })),
      };
}

/**
 * True when nothing blocking remains and the draft can be confirmed.
 *
 * The service-line half of this used to be missing: a draft whose ground transport line had
 * neither a vehicle class nor a passenger count — both declared `required` in the
 * catalogue — was reported as confirmable. Confirming it then failed inside `createRequest`
 * with the validator's own words ("Ground transport: Required"), which is a true statement
 * addressed to nobody. The engine now asks for those fields instead, and confirmation waits.
 */
export function isDraftDispatchable(
  draft: IntakeDraft,
  categories: readonly ServiceCategory[],
): boolean {
  if (draft.airport === null) return false;
  if (draft.arrival === null && draft.departure === null) return false;
  if (draft.services.length === 0) return false;
  if (draft.services.some((service) => service.category === null)) return false;
  if (draft.clarifications.some((item) => item.severity === 'blocking')) return false;

  return clarificationPlanFor(draft, categories).complete;
}

export { describeAirport };
