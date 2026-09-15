import type { IntakeExtraction } from '@/ai/intake/schema';
import type { IntakeCase, ServiceCode } from './cases/intake-cases';
import { INVENTABLE_IDENTIFIERS } from './cases/intake-cases';

/**
 * Eval scoring (CLAUDE.md §26).
 *
 * Scoring lives here, once, and both the offline and the online run use it. A metric
 * computed differently in two places is a metric that cannot be compared, which defeats the
 * purpose of having one.
 *
 * Every metric is a plain count of agreements over opportunities. Nothing is weighted or
 * smoothed: a number that needed explaining would not survive contact with a regression.
 */

export interface CaseScore {
  readonly id: string;
  readonly group: IntakeCase['group'];

  /** Graded only when the case states an expectation for that field. */
  readonly airportToken: Graded;
  readonly services: Graded;
  readonly quantities: Graded;
  readonly arrival: Graded;
  readonly departure: Graded;
  readonly passengers: Graded;
  readonly missingFieldRecall: Graded;
  readonly ambiguity: Graded;

  /** True when the extraction contains an identifier the sentence never mentioned. */
  readonly hallucinated: boolean;
  readonly hallucinationDetail: string | null;

  readonly latencyMs: number;
  readonly failures: readonly string[];
}

export type Graded = 'pass' | 'fail' | 'not_graded';

function grade(applicable: boolean, correct: boolean): Graded {
  if (!applicable) return 'not_graded';
  return correct ? 'pass' : 'fail';
}

/**
 * Does the model's airport token match what the user actually wrote?
 *
 * Compared case- and whitespace-insensitively, and a token that is a substring of the
 * expectation (or vice versa) counts — "Teterboro" for "Teterboro Airport" is a correct
 * reading of the same span, not a different airport.
 */
function airportTokenMatches(actual: string | null, expected: IntakeCase): boolean {
  if (expected.airportToken === null) return actual === null;
  if (actual === null) return false;

  const normalised = actual.trim().toLowerCase().replace(/\s+/g, ' ');
  const candidates = [expected.airportToken, ...(expected.airportTokenAlternatives ?? [])];

  return candidates.some(
    (candidate) => normalised === candidate || normalised.includes(candidate) || candidate.includes(normalised),
  );
}

/**
 * The hallucination check, and the reason this corpus exists.
 *
 * An extraction is hallucinated when it contains an airport identifier the user never
 * typed. A model that turns "Newark" into "KEWR" has chosen an airport on the user's
 * behalf, and §8 is explicit that it must not.
 */
function detectHallucination(
  extraction: IntakeExtraction,
  testCase: IntakeCase,
): { hallucinated: boolean; detail: string | null } {
  const sentence = testCase.sentence.toUpperCase();
  const haystack = [
    extraction.airportToken ?? '',
    extraction.fboToken ?? '',
    extraction.notes ?? '',
    ...extraction.services.map((service) => service.serviceNameToken),
  ]
    .join(' ')
    .toUpperCase();

  const forbidden = [
    ...(testCase.forbidden ?? []),
    // Any identifier the user did not type is fair game to check.
    ...INVENTABLE_IDENTIFIERS.filter((identifier) => !sentence.includes(identifier)),
  ];

  for (const identifier of new Set(forbidden)) {
    // Word-boundary match, so "TEB" does not fire on "TETERBORO".
    const pattern = new RegExp(`\\b${identifier.toUpperCase()}\\b`);
    if (pattern.test(haystack) && !sentence.includes(identifier.toUpperCase())) {
      return {
        hallucinated: true,
        detail: `extraction contains "${identifier}", which the sentence never said`,
      };
    }
  }

  return { hallucinated: false, detail: null };
}

export function scoreCase(
  testCase: IntakeCase,
  extraction: IntakeExtraction,
  latencyMs: number,
): CaseScore {
  const failures: string[] = [];

  // --- airport token ------------------------------------------------------
  const airportOk = airportTokenMatches(extraction.airportToken, testCase);
  if (!airportOk) {
    failures.push(
      `airportToken: expected ${testCase.airportToken === null ? 'null' : `"${testCase.airportToken}"`}, got ${
        extraction.airportToken === null ? 'null' : `"${extraction.airportToken}"`
      }`,
    );
  }

  // --- services -----------------------------------------------------------
  const extractedCodes = new Set(
    extraction.services
      .map((service) => service.serviceCode)
      .filter((code): code is ServiceCode => code !== null),
  );
  const expectedCodes = new Set(testCase.services);
  const servicesOk =
    expectedCodes.size === extractedCodes.size &&
    [...expectedCodes].every((code) => extractedCodes.has(code));

  if (!servicesOk) {
    failures.push(
      `services: expected [${[...expectedCodes].sort().join(', ')}], got [${[...extractedCodes].sort().join(', ')}]`,
    );
  }

  // --- quantities ---------------------------------------------------------
  const expectedQuantities = Object.entries(testCase.quantities ?? {}) as [ServiceCode, number][];
  let quantitiesOk = true;
  for (const [code, expected] of expectedQuantities) {
    const service = extraction.services.find((entry) => entry.serviceCode === code);
    if (service?.quantity !== expected) {
      quantitiesOk = false;
      failures.push(`quantity ${code}: expected ${String(expected)}, got ${String(service?.quantity ?? null)}`);
    }
  }

  // --- times --------------------------------------------------------------
  const arrivalOk = extraction.arrivalLocal === (testCase.arrivalLocal ?? null);
  if (testCase.arrivalLocal !== undefined && !arrivalOk) {
    failures.push(`arrivalLocal: expected ${testCase.arrivalLocal}, got ${String(extraction.arrivalLocal)}`);
  }

  const departureOk = extraction.departureLocal === (testCase.departureLocal ?? null);
  if (testCase.departureLocal !== undefined && !departureOk) {
    failures.push(
      `departureLocal: expected ${testCase.departureLocal}, got ${String(extraction.departureLocal)}`,
    );
  }

  // --- people -------------------------------------------------------------
  const passengersOk = extraction.passengers === (testCase.passengers ?? null);
  if (testCase.passengers !== undefined && !passengersOk) {
    failures.push(`passengers: expected ${String(testCase.passengers)}, got ${String(extraction.passengers)}`);
  }

  // --- missing-field recall ----------------------------------------------
  // Recall, not exact match: naming an extra missing field is cautious, not wrong.
  const reported = extraction.missingFields.map((field) => field.toLowerCase());
  const expectedMissing = testCase.missingFields ?? [];
  const recallOk = expectedMissing.every((field) =>
    reported.some((entry) => entry.includes(field.toLowerCase())),
  );
  if (expectedMissing.length > 0 && !recallOk) {
    failures.push(`missingFields: expected to include [${expectedMissing.join(', ')}], got [${reported.join(', ')}]`);
  }

  // --- ambiguity ----------------------------------------------------------
  const ambiguityOk = extraction.ambiguities.length > 0;
  if (testCase.expectsAmbiguity === true && !ambiguityOk) {
    failures.push('expected the model to declare an ambiguity rather than choose');
  }

  const hallucination = detectHallucination(extraction, testCase);
  if (hallucination.hallucinated && hallucination.detail !== null) {
    failures.push(hallucination.detail);
  }

  return {
    id: testCase.id,
    group: testCase.group,
    airportToken: grade(true, airportOk),
    services: grade(true, servicesOk),
    quantities: grade(expectedQuantities.length > 0, quantitiesOk),
    arrival: grade(testCase.arrivalLocal !== undefined, arrivalOk),
    departure: grade(testCase.departureLocal !== undefined, departureOk),
    passengers: grade(testCase.passengers !== undefined, passengersOk),
    missingFieldRecall: grade(expectedMissing.length > 0, recallOk),
    ambiguity: grade(testCase.expectsAmbiguity === true, ambiguityOk),
    hallucinated: hallucination.hallucinated,
    hallucinationDetail: hallucination.detail,
    latencyMs,
    failures,
  };
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

export interface MetricSummary {
  readonly graded: number;
  readonly passed: number;
  readonly rate: number;
}

export interface EvalReport {
  readonly cases: number;
  readonly airportToken: MetricSummary;
  readonly services: MetricSummary;
  readonly quantities: MetricSummary;
  readonly arrival: MetricSummary;
  readonly departure: MetricSummary;
  readonly passengers: MetricSummary;
  readonly missingFieldRecall: MetricSummary;
  readonly ambiguity: MetricSummary;
  readonly hallucinationRate: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  readonly byGroup: ReadonlyMap<string, MetricSummary>;
}

function summarise(scores: readonly CaseScore[], field: keyof CaseScore): MetricSummary {
  const graded = scores.filter((score) => score[field] !== 'not_graded');
  const passed = graded.filter((score) => score[field] === 'pass');
  return {
    graded: graded.length,
    passed: passed.length,
    // An ungraded metric reports 1, not 0 — "nothing to measure" is not a failure.
    rate: graded.length === 0 ? 1 : passed.length / graded.length,
  };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}

export function buildReport(scores: readonly CaseScore[]): EvalReport {
  const byGroup = new Map<string, MetricSummary>();

  for (const group of new Set(scores.map((score) => score.group))) {
    const inGroup = scores.filter((score) => score.group === group);
    // A group passes a case only when every graded metric on it passed.
    const passed = inGroup.filter((score) => score.failures.length === 0);
    byGroup.set(group, {
      graded: inGroup.length,
      passed: passed.length,
      rate: inGroup.length === 0 ? 1 : passed.length / inGroup.length,
    });
  }

  const latencies = scores.map((score) => score.latencyMs);

  return {
    cases: scores.length,
    airportToken: summarise(scores, 'airportToken'),
    services: summarise(scores, 'services'),
    quantities: summarise(scores, 'quantities'),
    arrival: summarise(scores, 'arrival'),
    departure: summarise(scores, 'departure'),
    passengers: summarise(scores, 'passengers'),
    missingFieldRecall: summarise(scores, 'missingFieldRecall'),
    ambiguity: summarise(scores, 'ambiguity'),
    hallucinationRate:
      scores.length === 0 ? 0 : scores.filter((score) => score.hallucinated).length / scores.length,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    byGroup,
  };
}

/** A readable report, printed by the suite so a regression is legible without a debugger. */
export function formatReport(title: string, report: EvalReport): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const line = (label: string, metric: MetricSummary): string =>
    `  ${label.padEnd(22)} ${percent(metric.rate).padStart(7)}  (${String(metric.passed)}/${String(metric.graded)})`;

  const groups = [...report.byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, metric]) => line(group, metric))
    .join('\n');

  return [
    ``,
    `${title} — ${String(report.cases)} cases`,
    `  ${'─'.repeat(44)}`,
    line('airport token', report.airportToken),
    line('service classification', report.services),
    line('quantity', report.quantities),
    line('arrival time', report.arrival),
    line('departure time', report.departure),
    line('passengers', report.passengers),
    line('missing-field recall', report.missingFieldRecall),
    line('ambiguity declared', report.ambiguity),
    `  ${'hallucination rate'.padEnd(22)} ${percent(report.hallucinationRate).padStart(7)}`,
    `  ${'latency p50 / p95'.padEnd(22)} ${String(report.latencyP50)}ms / ${String(report.latencyP95)}ms`,
    `  ${'─'.repeat(44)}`,
    `  by category:`,
    groups,
    ``,
  ].join('\n');
}
