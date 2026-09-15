import { z } from 'zod';

/**
 * The intake extraction schema (CLAUDE.md §8).
 *
 * Design rules this encodes:
 *
 *  - **Every field is nullable.** The model reports what the sentence actually says and
 *    nothing else. There is no default that could quietly become a fact.
 *  - **Tokens, not identifiers.** The model returns `"Teterboro"`, never `"KTEB"`, unless
 *    the user typed an ICAO code themselves. Resolving a token to a database row is code's
 *    job (§2: the model is not the source of truth for airport identity).
 *  - **Local wall time, not an instant.** `arrivalLocal` is what the clock at the airport
 *    reads. Converting it to UTC requires the airport's timezone, which is not known until
 *    after resolution (§7).
 *  - **Ambiguities are first-class.** "Newark" is genuinely ambiguous; the schema has a
 *    place to say so rather than forcing a guess.
 */

/** `YYYY-MM-DDTHH:mm` — a wall-clock reading, deliberately with no zone or offset. */
const localDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    'Local times must be YYYY-MM-DDTHH:mm with no timezone',
  );

export const intakeServiceSchema = z.object({
  /**
   * One of the platform's service codes when the model is confident, otherwise null.
   * Code re-resolves this against the live catalogue either way; the model's answer is a
   * hint, never the decision.
   */
  serviceCode: z
    .enum(['ground_transport', 'close_protection', 'hotel', 'catering', 'fuel', 'hangar'])
    .nullable(),
  /** The user's own words for the service — "cars", "bodyguards", "jet a". */
  serviceNameToken: z.string().min(1).max(120),
  quantity: z.number().int().min(1).max(500).nullable(),
  /**
   * Service-specific details the sentence mentioned, as key/value **pairs**. Validated
   * against the category's declared requirement schema after resolution — the model does
   * not get to invent field names that mean something.
   *
   * Why a list of pairs rather than an object: OpenAI's strict structured outputs cannot
   * express an open-ended map. Every object in a strict schema must declare its properties
   * up front, and the requirement fields here are per-category and admin-definable
   * (ADR-008), so there is no fixed list to declare. A list of pairs is open-ended and
   * strict-compatible, and the transform below hands the rest of the codebase the record it
   * expects — so this is a wire-format detail, not a change to the domain.
   */
  requirements: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        value: z.union([z.string().max(200), z.number(), z.boolean()]),
      }),
    )
    .max(20)
    .transform((pairs) => {
      const record: Record<string, string | number | boolean> = {};
      // Last write wins, which matters for a correction in one sentence: "SUV, no, sedan".
      for (const pair of pairs) record[pair.key] = pair.value;
      return record;
    }),
});

export const intakeAmbiguitySchema = z.object({
  /** Which extracted field is uncertain: `airportToken`, `arrivalLocal`, `services[0]`. */
  field: z.string().min(1).max(80),
  issue: z.string().min(1).max(400),
  /** Candidate readings to offer the user. Never auto-selected. */
  options: z.array(z.string().min(1).max(160)).max(8),
});

export const intakeExtractionSchema = z.object({
  /**
   * The airport as the user referred to it. An ICAO code appears here ONLY if the user
   * typed one — the model must not translate "Teterboro" into "KTEB" (§8).
   */
  airportToken: z.string().min(1).max(120).nullable(),
  fboToken: z.string().min(1).max(120).nullable(),

  arrivalLocal: localDateTime.nullable(),
  departureLocal: localDateTime.nullable(),

  passengers: z.number().int().min(0).max(400).nullable(),
  crew: z.number().int().min(0).max(100).nullable(),

  /** A tail number or aircraft type as written. Resolved against the registry by code. */
  aircraftToken: z.string().min(1).max(60).nullable(),

  services: z.array(intakeServiceSchema).max(20),

  notes: z.string().max(2000).nullable(),

  /** Fields the request clearly needs but the sentence did not supply. */
  missingFields: z.array(z.string().min(1).max(80)).max(20),

  ambiguities: z.array(intakeAmbiguitySchema).max(12),

  confidence: z.enum(['high', 'medium', 'low']),
});

/**
 * The wire form of a service line — what the provider actually returns, before the
 * transform folds the requirement pairs into a record.
 *
 * Exported because anything that needs to *produce* an extraction for the schema to parse
 * (the deterministic fallback driving the eval's offline adapter, a recorded fixture) must
 * produce this shape, not the parsed one.
 */
export type IntakeServiceWire = z.input<typeof intakeServiceSchema>;
export type IntakeExtractionWire = z.input<typeof intakeExtractionSchema>;

/** Turns a parsed extraction back into the wire form the schema accepts. */
export function toWireExtraction(extraction: IntakeExtraction): IntakeExtractionWire {
  return {
    ...extraction,
    services: extraction.services.map((service) => ({
      ...service,
      requirements: Object.entries(service.requirements).map(([key, value]) => ({ key, value })),
    })),
  };
}

export type IntakeExtraction = z.infer<typeof intakeExtractionSchema>;
export type IntakeService = z.infer<typeof intakeServiceSchema>;
export type IntakeAmbiguity = z.infer<typeof intakeAmbiguitySchema>;

/**
 * The empty extraction used when AI is unavailable.
 *
 * It preserves nothing but the truth: we know nothing yet, and the sentence itself is
 * held separately and verbatim. The operator completes the structured form by hand
 * (CLAUDE.md §22 "do not fabricate parse").
 */
export const emptyExtraction: IntakeExtraction = Object.freeze({
  airportToken: null,
  fboToken: null,
  arrivalLocal: null,
  departureLocal: null,
  passengers: null,
  crew: null,
  aircraftToken: null,
  services: [],
  notes: null,
  missingFields: ['airport', 'arrival', 'services'],
  ambiguities: [],
  confidence: 'low',
});
