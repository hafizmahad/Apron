import type { ServiceConfigSchema, ServiceRequirementField } from '@/db/schema';
import { dependencyMet, missingRequiredFields } from '@/domain/services/requirements';

/**
 * The clarification engine (CLAUDE.md §8 step 3).
 *
 * One generic engine, driven entirely by configuration. It holds no knowledge of ground
 * transport, hotels or fuel: it reads a service category's declared requirement fields out
 * of `config_schema_json` and asks for the ones that are required and absent. A category an
 * admin adds tomorrow is asked about by this same code, with no component written for it.
 *
 * **The model does not decide what is required.** Configuration does. The model's only
 * contribution here is the wording of an ambiguity it noticed in the sentence, which is
 * attached to the relevant question as context — never as a value.
 *
 * Pure: no database, no clock, no network. It is handed a snapshot and returns questions,
 * which is what lets every rule below be unit-tested exhaustively.
 */

export type UnresolvedState =
  /** Configuration requires it, it is absent, and nothing can proceed without it. */
  | 'blocking_missing'
  /** Stated, but it could mean more than one thing and code must not choose. */
  | 'blocking_ambiguous'
  /** Configuration allows it to be absent. Offered quietly, and never blocking. */
  | 'optional_missing'
  | 'resolved';

export interface ClarificationOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export type ClarificationControl =
  | {
      readonly kind: 'enum';
      readonly options: readonly ClarificationOption[];
      readonly allowNoPreference: boolean;
    }
  | { readonly kind: 'boolean'; readonly allowNoPreference: boolean }
  | {
      readonly kind: 'integer';
      readonly min: number | null;
      readonly max: number | null;
      readonly unit: string | null;
    }
  | {
      readonly kind: 'number';
      readonly min: number | null;
      readonly max: number | null;
      readonly unit: string | null;
    }
  | { readonly kind: 'text'; readonly long: boolean }
  | { readonly kind: 'datetime' }
  /** Backed by real rows. The options ARE the database; nothing here may be invented. */
  | { readonly kind: 'entity'; readonly options: readonly ClarificationOption[] };

export interface ClarificationItem {
  /** Stable across rounds, so an answer always lands on the field it was asked for. */
  readonly id: string;
  readonly scope: 'trip' | 'service';
  readonly serviceIndex: number | null;
  readonly serviceName: string | null;
  /** The configuration key. Never rendered — `label` is what a person reads. */
  readonly field: string;
  readonly label: string;
  readonly question: string;
  readonly help: string | null;
  readonly state: UnresolvedState;
  readonly control: ClarificationControl;
  /**
   * How many times this has been asked without being resolved. Past the ceiling the UI
   * stops re-asking the same way and offers a plain correction control instead, because
   * asking a fourth time the same way is not going to work either.
   */
  readonly attempts: number;
  readonly exhausted: boolean;
}

/** Asking more than this many times is a loop, not a conversation. */
export const CLARIFICATION_ATTEMPT_CEILING = 3;

export interface ServiceClarificationSnapshot {
  readonly index: number;
  readonly token: string;
  readonly categoryName: string | null;
  readonly categoryCode: string | null;
  readonly config: ServiceConfigSchema | null;
  /** Candidate categories when the token matched more than one. */
  readonly categoryOptions: readonly ClarificationOption[];
  readonly quantity: number | null;
  readonly unitLabel: string | null;
  readonly requirements: Record<string, unknown>;
  /**
   * Declared keys whose supplied value failed the catalogue's own validation.
   *
   * A value being PRESENT is not the same as it being usable. The model returning a vehicle
   * class the catalogue does not declare leaves a value in place that creation will refuse,
   * so the engine must ask again rather than treat the field as settled.
   */
  readonly invalidFields: readonly string[];
}

export interface ClarificationSnapshot {
  readonly airportResolved: boolean;
  readonly airportToken: string | null;
  readonly airportOptions: readonly ClarificationOption[];
  readonly fboOptions: readonly ClarificationOption[];
  readonly fboAmbiguous: boolean;
  readonly fboToken: string | null;

  readonly arrivalLocal: string | null;
  readonly departureLocal: string | null;
  readonly arrivalProblem: TimeProblem | null;
  readonly departureProblem: TimeProblem | null;

  readonly services: readonly ServiceClarificationSnapshot[];
  /** Every active category, for the "which service did you mean" question. */
  readonly catalogueOptions: readonly ClarificationOption[];

  /** What the model itself said was unclear. Context for a question, never an answer. */
  readonly ambiguities: readonly {
    readonly field: string;
    readonly issue: string;
    readonly options: readonly string[];
  }[];

  /** Attempts so far, keyed by item id. Absent means never asked. */
  readonly attempts: Readonly<Record<string, number>>;
  /**
   * Item ids the user has waved away with "no preference". Only an OPTIONAL field can be
   * skipped, and remembering it is what stops the same question reappearing every round.
   */
  readonly skipped: readonly string[];
}

export interface TimeProblem {
  readonly kind: 'ambiguous' | 'nonexistent';
  readonly options: readonly ClarificationOption[];
}

export interface ClarificationPlan {
  readonly items: readonly ClarificationItem[];
  readonly blocking: readonly ClarificationItem[];
  readonly optional: readonly ClarificationItem[];
  /** True only when nothing blocking remains. Confirmation reads this and nothing else. */
  readonly complete: boolean;
}

export function planClarifications(snapshot: ClarificationSnapshot): ClarificationPlan {
  const items: ClarificationItem[] = [];

  const skipped = new Set(snapshot.skipped);

  const push = (item: Omit<ClarificationItem, 'attempts' | 'exhausted'>): void => {
    // A required field can never be skipped, whatever arrives from the browser.
    if (skipped.has(item.id) && item.state === 'optional_missing') return;

    const attempts = snapshot.attempts[item.id] ?? 0;
    items.push({ ...item, attempts, exhausted: attempts >= CLARIFICATION_ATTEMPT_CEILING });
  };

  // --- the trip ------------------------------------------------------------
  if (!snapshot.airportResolved) {
    push({
      id: 'trip.airport',
      scope: 'trip',
      serviceIndex: null,
      serviceName: null,
      field: 'airport',
      label: 'Airport',
      question:
        snapshot.airportToken === null
          ? 'Which airport is the aircraft arriving at?'
          : snapshot.airportOptions.length > 0
            ? `Which airport did you mean by "${snapshot.airportToken}"?`
            : `We could not find an airport matching "${snapshot.airportToken}". Which one is it?`,
      help: null,
      state: snapshot.airportOptions.length > 0 ? 'blocking_ambiguous' : 'blocking_missing',
      control: { kind: 'entity', options: snapshot.airportOptions },
    });
  }

  if (snapshot.fboAmbiguous && snapshot.fboOptions.length > 0) {
    push({
      id: 'trip.fbo',
      scope: 'trip',
      serviceIndex: null,
      serviceName: null,
      field: 'fbo',
      label: 'Handler',
      question:
        snapshot.fboToken === null
          ? 'Which handler should we use?'
          : `Which handler did you mean by "${snapshot.fboToken}"?`,
      // Optional by configuration: a request without a named handler is perfectly valid.
      help: 'Optional — we can arrange this with any handler at the field.',
      state: 'optional_missing',
      control: { kind: 'entity', options: snapshot.fboOptions },
    });
  }

  for (const [field, problem, label] of [
    ['arrival', snapshot.arrivalProblem, 'Arrival'],
    ['departure', snapshot.departureProblem, 'Departure'],
  ] as const) {
    if (problem === null) continue;

    push({
      id: `trip.${field}`,
      scope: 'trip',
      serviceIndex: null,
      serviceName: null,
      field,
      label: `${label} time`,
      question:
        problem.kind === 'ambiguous'
          ? `That ${field} time happens twice on that date, because the clocks go back. Which did you mean?`
          : `That ${field} time does not exist on that date, because the clocks go forward. What is the correct time?`,
      // A date-and-time control rather than a list, because both cases are answered the
      // same way — by stating the time again unambiguously. The readings we computed are
      // offered as context so the choice is informed rather than guessed at.
      help:
        problem.options.length === 0
          ? null
          : `The readings on that date are ${problem.options.map((option) => option.label).join(' and ')}.`,
      state: 'blocking_ambiguous',
      control: { kind: 'datetime' },
    });
  }

  // Arrival and departure are alternatives, not both required: every service category
  // derives its window from whichever instant it has. Departure is asked for only when
  // there is no arrival to anchor to — never merely because it went unmentioned.
  if (
    snapshot.airportResolved &&
    snapshot.arrivalLocal === null &&
    snapshot.departureLocal === null
  ) {
    push({
      id: 'trip.arrival',
      scope: 'trip',
      serviceIndex: null,
      serviceName: null,
      field: 'arrival',
      label: 'Arrival time',
      question: 'When does the aircraft arrive, in local time at the airport?',
      help: 'If this is a departure-only trip, give the departure time instead.',
      state: 'blocking_missing',
      control: { kind: 'datetime' },
    });
  }

  // --- services ------------------------------------------------------------
  if (snapshot.services.length === 0) {
    push({
      id: 'trip.services',
      scope: 'trip',
      serviceIndex: null,
      serviceName: null,
      field: 'services',
      label: 'Services',
      question: 'Which services do you need?',
      help: null,
      state: 'blocking_missing',
      control: { kind: 'enum', options: snapshot.catalogueOptions, allowNoPreference: false },
    });
  }

  for (const service of snapshot.services) {
    if (service.categoryCode === null || service.config === null) {
      push({
        id: `service.${String(service.index)}.category`,
        scope: 'service',
        serviceIndex: service.index,
        serviceName: null,
        field: 'category',
        label: 'Service',
        question:
          service.categoryOptions.length > 0
            ? `"${service.token}" could be more than one service. Which did you mean?`
            : `Which of our services is "${service.token}"?`,
        help: null,
        state: 'blocking_ambiguous',
        control: {
          kind: 'enum',
          options:
            service.categoryOptions.length > 0 ? service.categoryOptions : snapshot.catalogueOptions,
          allowNoPreference: false,
        },
      });
      continue;
    }

    const ambiguity = findAmbiguity(snapshot.ambiguities, service);
    const missing = missingRequiredFields(service.config, service.requirements);
    const invalid = new Set(service.invalidFields);

    for (const field of service.config.fields) {
      // A conditional field is not a question until its condition is met. Asking which
      // grade of de-icing fluid before anyone said de-icing is needed is noise.
      if (!dependencyMet(field, service.requirements)) continue;

      const value = service.requirements[field.key];
      const supplied = value !== undefined && value !== null && value !== '';
      const usable = supplied && !invalid.has(field.key);
      if (usable) continue;

      const required = field.required || missing.some((item) => item.key === field.key);

      push({
        id: `service.${String(service.index)}.${field.key}`,
        scope: 'service',
        serviceIndex: service.index,
        serviceName: service.categoryName,
        field: field.key,
        label: field.label,
        question: phraseQuestion(field),
        // The model's own words about what was unclear, shown where they are useful:
        // beside the field that the ambiguity is actually about.
        // Only when a value was actually given and could not be used. A field that is
        // simply absent is also reported by the validator, and telling someone we could not
        // use "undefined" is nonsense.
        help: supplied && invalid.has(field.key)
          ? `We could not use "${String(value)}". Please choose from the options.`
          : required && ambiguity !== null
            ? ambiguity
            : (field.help ?? null),
        state: required ? 'blocking_missing' : 'optional_missing',
        control: controlFor(field),
      });
    }
  }

  const blocking = items.filter(
    (item) => item.state === 'blocking_missing' || item.state === 'blocking_ambiguous',
  );

  return {
    items,
    blocking,
    optional: items.filter((item) => item.state === 'optional_missing'),
    complete: blocking.length === 0,
  };
}

/**
 * A natural question built from a declared field.
 *
 * Derived from the label and type rather than a per-service lookup, so a category added
 * from Admin reads as a sentence on the day it is added: "Covers", declared as an integer,
 * is asked as "How many covers for catering?" — not "Covers:".
 */
function phraseQuestion(field: ServiceRequirementField): string {
  const subject = field.label.toLowerCase();

  switch (field.type) {
    case 'integer':
    case 'number':
      // A label already phrased as a count keeps its own wording.
      return /^(how many|number of)/i.test(field.label) ? `${field.label}?` : `How many ${subject}?`;

    case 'boolean':
      // "Armed detail" asked as "Armed detail?" is a label with punctuation, not a question.
      // "Heated hangar required" already reads as one, so it is left alone.
      return /^(is|are|do|does|should|can|will)\b/i.test(field.label) ||
        /\b(required|needed)$/i.test(field.label)
        ? `${field.label}?`
        : `Do you need ${subject}?`;

    case 'enum':
      return `Which ${subject}?`;

    case 'text':
    case 'string':
    default:
      // The service name is shown above the question, so a bare label reads naturally here
      // and never turns into "What required languages for close protection?".
      return `${field.label}?`;
  }
}

function controlFor(field: ServiceRequirementField): ClarificationControl {
  switch (field.type) {
    case 'enum':
      return {
        kind: 'enum',
        options: (field.options ?? []).map((option) => ({ value: option, label: option })),
        // Only an optional choice may be waved away; a required one must be answered.
        allowNoPreference: !field.required,
      };
    case 'boolean':
      return { kind: 'boolean', allowNoPreference: !field.required };
    case 'integer':
      return {
        kind: 'integer',
        min: field.min ?? null,
        max: field.max ?? null,
        unit: field.unit ?? null,
      };
    case 'number':
      return {
        kind: 'number',
        min: field.min ?? null,
        max: field.max ?? null,
        unit: field.unit ?? null,
      };
    case 'text':
      return { kind: 'text', long: true };
    case 'string':
    default:
      return { kind: 'text', long: false };
  }
}

/** The model's ambiguity note for this service, matched on its own words. */
function findAmbiguity(
  ambiguities: ClarificationSnapshot['ambiguities'],
  service: ServiceClarificationSnapshot,
): string | null {
  const needles = [service.categoryCode, service.categoryName, service.token]
    .filter((value): value is string => value !== null)
    .map((value) => value.toLowerCase());

  const match = ambiguities.find((ambiguity) => {
    const field = ambiguity.field.toLowerCase();
    return needles.some((needle) => field.includes(needle) || needle.includes(field));
  });

  return match?.issue ?? null;
}
