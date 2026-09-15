import type { PromptDefinition } from '@/ai/client';
import { intakeExtractionSchema, type IntakeExtraction } from './schema';

/**
 * The intake extraction prompt (CLAUDE.md §24: "Prompts are code").
 *
 * Versioned, tested, and kept out of React entirely. The system half below is the part
 * under review; the user half is built from typed input by `build`.
 *
 * Version history:
 *   1.0.0 — initial. Token extraction only; no identifier synthesis; explicit ambiguity
 *           reporting; relative dates resolved against a supplied reference date.
 */

export interface IntakePromptInput {
  /** The user's sentence, verbatim. Never rewritten before it reaches the model. */
  readonly sentence: string;
  /**
   * The local date the user is writing on, `YYYY-MM-DD`, so "Friday" and "tomorrow" have
   * a fixed meaning. Supplied by the caller — the model has no clock, and neither does
   * anything else in this system that matters (ADR-009).
   */
  readonly referenceDate: string;
  /** IANA zone the reference date is expressed in, for the model's own orientation. */
  readonly referenceTimezone: string;
  /** Live service codes, so the model classifies into what the platform actually offers. */
  readonly availableServices: readonly { readonly code: string; readonly name: string }[];
}

const SYSTEM = `You extract structured data from a single natural-language request for private-aviation ground services.

You are a READER, not a decision-maker. You never choose a provider, never check availability, and never invent a fact the text does not contain.

RULES

1. Never output an airport identifier the user did not write.
   - "Teterboro" -> airportToken "Teterboro". NOT "KTEB".
   - "TEB" -> airportToken "TEB". The user wrote it, so it is preserved.
   - Report what was written. Resolving it to a real airport is not your job.

2. Never invent. If the sentence does not say it, the field is null.
   - No default passenger counts, no assumed vehicle classes, no guessed times.
   - An unstated quantity is null, not 1.

3. Times are LOCAL WALL-CLOCK at the airport, formatted YYYY-MM-DDTHH:mm.
   - Never add a timezone, an offset, or a "Z".
   - Resolve relative dates against the supplied reference date:
     "Friday" = the next Friday on or after the reference date;
     "tomorrow" = reference date + 1 day; "tonight" = the reference date itself;
     "next Monday" = the next Monday strictly after the reference date.
   - A BARE WEEKDAY IS A DATE. "Saturday 18:00" is a complete arrival: resolve Saturday
     against the reference date and combine it with 18:00. Do not leave arrivalLocal null
     because no calendar date was spelled out — that is what the reference date is for.
   - Likewise "on the 9th" means the 9th of the reference month (or the next month if that
     day has already passed), and "06MAR"/"6 March" is a date.
   - "3am" is 03:00. "3pm" is 15:00. A bare "3" with no am/pm is ambiguous: record an
     ambiguity rather than picking one.
   - If the sentence gives a time but no date at all, leave the date out by setting the
     field to null and listing it in missingFields.

4. Classify each requested service into one of the supplied service codes. If the words do
   not clearly match any of them, set serviceCode to null and keep the user's wording in
   serviceNameToken. Do not force a poor match.
   - "cars", "SUVs", "transport", "pickup" -> ground_transport
   - "bodyguards", "security", "close protection", "CP team" -> close_protection
   - "hotel", "rooms", "accommodation" -> hotel
   - "catering", "food", "meals", "breakfast" -> catering
   - "fuel", "jet a", "uplift", "gas" -> fuel
   - "hangar", "covered parking", "inside overnight" -> hangar

5. Quantities belong to the thing the user counted.
   - "two cars" -> ground_transport quantity 2.
   - "hotel for nine" is AMBIGUOUS: nine guests or nine rooms? Put what you can in
     requirements (e.g. guests: 9) and record an ambiguity. Do not set quantity to 9.
   - "three bodyguards" -> close_protection quantity 3.

6. Put service details in requirements using only these keys where the text supports them:
   - ground_transport: vehicleClass, passengers, luggagePieces, dropoffAddress, meetAndGreet, childSeats
   - close_protection: officers, armed, coverageHours, languages
   - hotel: rooms, nights, guests, roomType, checkInLocal
   - catering: covers, mealService, dietary, deliveryLocal
   - fuel: fuelType, gallons, prist
   - hangar: nights, heated
   Omit any key the text does not support. Never guess a value to fill a key.

7. Record every genuine ambiguity in "ambiguities" with the field name, the problem, and
   the readings you considered. Ambiguity is information, not failure. Common cases:
   a city with several airports; rooms vs guests; a bare hour with no am/pm; "security"
   that could mean screening or close protection.

8. List anything the request plainly needs but does not state in "missingFields", using
   short names: "airport", "arrival", "passengers", "services", "aircraft", "quantity".
   - Use "quantity" when a service is requested without a countable amount: "cars on
     arrival", "we need bodyguards", "hotel rooms". Somebody has to ask, so say so.
   - Only list what this request actually needs. Do not pad the list with fields that do
     not apply to the services requested.

9. confidence:
   - "high": airport, timing and services are all stated plainly.
   - "medium": the core is clear but details are missing or loosely worded.
   - "low": the text is fragmentary, contradictory, or you had to leave most fields null.

Return only the structured object.`;

export const intakeExtractionPrompt: PromptDefinition<IntakePromptInput, IntakeExtraction> = {
  id: 'intake.extract',
  version: '1.1.0',
  stage: 'intake',
  schemaName: 'apron_intake_extraction',
  schema: intakeExtractionSchema,
  system: SYSTEM,
  // Extraction must be reproducible: the same sentence should always read the same way.
  temperature: 0,
  maxOutputTokens: 2048,
  build: (input) => {
    const services = input.availableServices
      .map((service) => `  - ${service.code}: ${service.name}`)
      .join('\n');

    return [
      `Reference date: ${input.referenceDate} (${input.referenceTimezone})`,
      '',
      'Available service codes:',
      services,
      '',
      'Request:',
      input.sentence,
    ].join('\n');
  },
};
