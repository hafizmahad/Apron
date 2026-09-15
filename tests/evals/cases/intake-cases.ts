/**
 * The intake eval corpus (CLAUDE.md §26).
 *
 * Seventy-two cases covering every category the brief names: ICAO supplied, IATA supplied,
 * airport by name, city ambiguity, missing airport, relative dates, overnight requests,
 * multiple services, absent quantities, casual and malformed language, corrections,
 * ambiguous "car", bodyguard synonyms, rooms versus nights, catering detail, fuel with no
 * amount, and hangar duration.
 *
 * What an expectation means here matters. `airportToken` records the words the user used,
 * never an identifier the model inferred — `"Teterboro"`, not `"KTEB"`, unless the user
 * typed the code. That is the single most important property in this corpus: a model that
 * helpfully translates a city into an ICAO code has invented an airport, and §8 forbids it.
 *
 * Every case is composed on **2026-03-06, a Friday**, in `America/New_York`. Relative dates
 * ("tomorrow", "Friday") are therefore checkable against a fixed reference rather than
 * against whenever the suite happens to run.
 */

export const REFERENCE_DATE = '2026-03-06';
export const REFERENCE_TIMEZONE = 'America/New_York';

export type ServiceCode =
  | 'ground_transport'
  | 'close_protection'
  | 'hotel'
  | 'catering'
  | 'fuel'
  | 'hangar';

export interface IntakeCase {
  readonly id: string;
  /** Which §26 category this case exercises, for the per-category report. */
  readonly group:
    | 'icao'
    | 'iata'
    | 'airport_name'
    | 'city_ambiguity'
    | 'missing_airport'
    | 'relative_date'
    | 'overnight'
    | 'multi_service'
    | 'no_quantity'
    | 'casual'
    | 'correction'
    | 'ambiguous_car'
    | 'security_synonym'
    | 'rooms_vs_nights'
    | 'catering_detail'
    | 'fuel_no_amount'
    | 'hangar_duration';
  readonly sentence: string;

  /**
   * The airport as the user wrote it, lower-cased for comparison. `null` asserts the
   * sentence named no airport at all — and that the model did not invent one.
   */
  readonly airportToken: string | null;
  /** Accepted alternatives, where more than one span is a fair reading. */
  readonly airportTokenAlternatives?: readonly string[];

  /** Service codes the sentence asks for, as a set. Order is not graded. */
  readonly services: readonly ServiceCode[];
  /** Expected quantity per service code. A code absent here is not graded on quantity. */
  readonly quantities?: Readonly<Partial<Record<ServiceCode, number>>>;

  /** `YYYY-MM-DDTHH:mm` local wall time, when the sentence fixes one. */
  readonly arrivalLocal?: string;
  readonly departureLocal?: string;

  readonly passengers?: number;
  readonly crew?: number;

  /** Fields the model should report as missing. Graded as recall, not exact match. */
  readonly missingFields?: readonly string[];

  /** The sentence is genuinely ambiguous and the model must say so rather than choose. */
  readonly expectsAmbiguity?: boolean;

  /** Substrings that must NOT appear anywhere in the extraction — the hallucination check. */
  readonly forbidden?: readonly string[];
}

/**
 * Every case forbids the four seeded ICAO codes unless the user typed one. Listing them
 * per-case would be noise, so the runner adds this to any case whose sentence does not
 * contain a four-letter K-code.
 */
export const INVENTABLE_IDENTIFIERS: readonly string[] = [
  'KTEB',
  'KEWR',
  'KJFK',
  'KVNY',
  'KOPF',
  'KPBI',
  'TEB',
  'EWR',
  'JFK',
  'VNY',
  'OPF',
  'PBI',
];

export const INTAKE_CASES: readonly IntakeCase[] = [
  // --- ICAO supplied by the user -------------------------------------------
  {
    id: 'icao-01',
    group: 'icao',
    sentence: 'Landing at KTEB Friday at 3am, two cars.',
    airportToken: 'kteb',
    services: ['ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-06T03:00',
  },
  {
    id: 'icao-02',
    group: 'icao',
    sentence: 'Arrival KVNY 06 March 2026 14:30, need one car and fuel.',
    airportToken: 'kvny',
    services: ['ground_transport', 'fuel'],
    quantities: { ground_transport: 1 },
    arrivalLocal: '2026-03-06T14:30',
  },
  {
    id: 'icao-03',
    group: 'icao',
    sentence: 'KOPF arrival tomorrow 09:00, hangar for the night.',
    airportToken: 'kopf',
    services: ['hangar'],
    arrivalLocal: '2026-03-07T09:00',
  },
  {
    id: 'icao-04',
    group: 'icao',
    sentence: 'We land KPBI at 22:15 on 8 March. Three bodyguards please.',
    airportToken: 'kpbi',
    services: ['close_protection'],
    quantities: { close_protection: 3 },
    arrivalLocal: '2026-03-08T22:15',
  },

  // --- IATA supplied -------------------------------------------------------
  {
    id: 'iata-01',
    group: 'iata',
    sentence: 'Arriving TEB tomorrow morning at 8, two SUVs.',
    airportToken: 'teb',
    services: ['ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-07T08:00',
  },
  {
    id: 'iata-02',
    group: 'iata',
    sentence: 'JFK 06MAR 19:45 arrival, catering for 6.',
    airportToken: 'jfk',
    services: ['catering'],
    arrivalLocal: '2026-03-06T19:45',
    // "catering for 6" is six covers, which rule 6 puts in requirements. It says nothing
    // about how many people are on the aircraft, so passengers is not graded here.
  },
  {
    id: 'iata-03',
    group: 'iata',
    sentence: 'VNY pickup Sunday 11:00, one vehicle for four passengers.',
    airportToken: 'vny',
    services: ['ground_transport'],
    quantities: { ground_transport: 1 },
    arrivalLocal: '2026-03-08T11:00',
    passengers: 4,
  },

  // --- airport by name -----------------------------------------------------
  {
    id: 'name-01',
    group: 'airport_name',
    sentence: 'Landing at Teterboro Friday at 3am, two cars, three bodyguards, hotel for nine, catering, and fuel.',
    airportToken: 'teterboro',
    services: ['ground_transport', 'close_protection', 'hotel', 'catering', 'fuel'],
    quantities: { ground_transport: 2, close_protection: 3 },
    arrivalLocal: '2026-03-06T03:00',
    forbidden: ['KTEB'],
  },
  {
    id: 'name-02',
    group: 'airport_name',
    sentence: 'Van Nuys arrival Saturday 16:00, two cars.',
    airportToken: 'van nuys',
    services: ['ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-07T16:00',
    forbidden: ['KVNY'],
  },
  {
    id: 'name-03',
    group: 'airport_name',
    sentence: 'Opa Locka on the 9th at 07:30, fuel uplift and a car.',
    airportToken: 'opa locka',
    services: ['fuel', 'ground_transport'],
    arrivalLocal: '2026-03-09T07:30',
    forbidden: ['KOPF'],
  },
  {
    id: 'name-04',
    group: 'airport_name',
    sentence: 'Palm Beach International, Monday 13:00, hangar and two cars.',
    airportToken: 'palm beach international',
    airportTokenAlternatives: ['palm beach'],
    services: ['hangar', 'ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-09T13:00',
    forbidden: ['KPBI'],
  },
  {
    id: 'name-05',
    group: 'airport_name',
    sentence: 'Teterboro Airport, tomorrow at noon. One car.',
    airportToken: 'teterboro airport',
    airportTokenAlternatives: ['teterboro'],
    services: ['ground_transport'],
    quantities: { ground_transport: 1 },
    arrivalLocal: '2026-03-07T12:00',
    forbidden: ['KTEB'],
  },

  // --- city ambiguity ------------------------------------------------------
  {
    id: 'ambig-01',
    group: 'city_ambiguity',
    sentence: 'Landing in Newark tomorrow at 10, two cars.',
    airportToken: 'newark',
    services: ['ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-07T10:00',
    // "Newark" is a city, not an airport. Choosing one silently is the failure mode.
    forbidden: ['KEWR', 'KTEB'],
  },
  {
    id: 'ambig-02',
    group: 'city_ambiguity',
    sentence: 'New York arrival Friday 18:00, one car and catering.',
    airportToken: 'new york',
    services: ['ground_transport', 'catering'],
    arrivalLocal: '2026-03-06T18:00',
    expectsAmbiguity: true,
    forbidden: ['KJFK', 'KEWR', 'KTEB'],
  },
  {
    id: 'ambig-03',
    group: 'city_ambiguity',
    sentence: 'Flying into Miami on the 10th at 15:00, hangar please.',
    airportToken: 'miami',
    services: ['hangar'],
    arrivalLocal: '2026-03-10T15:00',
    forbidden: ['KOPF', 'KMIA'],
  },
  {
    id: 'ambig-04',
    group: 'city_ambiguity',
    sentence: 'Los Angeles Sunday morning 09:00, three cars.',
    airportToken: 'los angeles',
    services: ['ground_transport'],
    quantities: { ground_transport: 3 },
    arrivalLocal: '2026-03-08T09:00',
    forbidden: ['KVNY', 'KLAX'],
  },

  // --- missing airport -----------------------------------------------------
  {
    id: 'missing-01',
    group: 'missing_airport',
    sentence: 'Two cars for tomorrow morning at 9.',
    airportToken: null,
    services: ['ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-07T09:00',
    missingFields: ['airport'],
  },
  {
    id: 'missing-02',
    group: 'missing_airport',
    sentence: 'Need three bodyguards and a hotel for six on Saturday.',
    airportToken: null,
    services: ['close_protection', 'hotel'],
    quantities: { close_protection: 3 },
    missingFields: ['airport'],
  },
  {
    id: 'missing-03',
    group: 'missing_airport',
    sentence: 'Catering and fuel please.',
    airportToken: null,
    services: ['catering', 'fuel'],
    missingFields: ['airport', 'arrival'],
  },
  {
    id: 'missing-04',
    group: 'missing_airport',
    sentence: 'Can you sort a car for the principal?',
    airportToken: null,
    services: ['ground_transport'],
    missingFields: ['airport', 'arrival'],
  },

  // --- relative dates ------------------------------------------------------
  {
    id: 'rel-01',
    group: 'relative_date',
    sentence: 'Teterboro tomorrow at 07:00, one car.',
    airportToken: 'teterboro',
    services: ['ground_transport'],
    quantities: { ground_transport: 1 },
    arrivalLocal: '2026-03-07T07:00',
  },
  {
    id: 'rel-02',
    group: 'relative_date',
    sentence: 'Van Nuys next Monday at 08:30, two cars.',
    airportToken: 'van nuys',
    services: ['ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-09T08:30',
  },
  {
    id: 'rel-03',
    group: 'relative_date',
    sentence: 'Landing today at 21:00 at Teterboro, one car.',
    airportToken: 'teterboro',
    services: ['ground_transport'],
    quantities: { ground_transport: 1 },
    arrivalLocal: '2026-03-06T21:00',
  },
  {
    id: 'rel-04',
    group: 'relative_date',
    sentence: 'This Sunday into Palm Beach at 12:00, fuel and a car.',
    airportToken: 'palm beach',
    services: ['fuel', 'ground_transport'],
    arrivalLocal: '2026-03-08T12:00',
  },
  {
    id: 'rel-05',
    group: 'relative_date',
    sentence: 'Teterboro in two days at 06:00, catering for four.',
    airportToken: 'teterboro',
    services: ['catering'],
    arrivalLocal: '2026-03-08T06:00',
  },

  // --- overnight / cross-midnight -----------------------------------------
  {
    id: 'night-01',
    group: 'overnight',
    sentence: 'Teterboro arrival tomorrow at 00:30, two cars and three bodyguards.',
    airportToken: 'teterboro',
    services: ['ground_transport', 'close_protection'],
    quantities: { ground_transport: 2, close_protection: 3 },
    arrivalLocal: '2026-03-07T00:30',
  },
  {
    id: 'night-02',
    group: 'overnight',
    sentence: 'Landing 02:45 Saturday at Van Nuys, one car, hangar overnight.',
    airportToken: 'van nuys',
    services: ['ground_transport', 'hangar'],
    quantities: { ground_transport: 1 },
    arrivalLocal: '2026-03-07T02:45',
  },
  {
    id: 'night-03',
    group: 'overnight',
    sentence: 'Arrive Teterboro 23:50 tonight, depart 05:10 tomorrow. One car each way.',
    airportToken: 'teterboro',
    services: ['ground_transport'],
    arrivalLocal: '2026-03-06T23:50',
    departureLocal: '2026-03-07T05:10',
  },
  {
    id: 'night-04',
    group: 'overnight',
    sentence: 'Red-eye into Opa Locka at 04:00 on the 8th, close protection for the transfer.',
    airportToken: 'opa locka',
    services: ['close_protection'],
    arrivalLocal: '2026-03-08T04:00',
  },

  // --- multiple services ---------------------------------------------------
  {
    id: 'multi-01',
    group: 'multi_service',
    sentence:
      'Teterboro Friday 15:00: two cars, four bodyguards, hotel for eight, catering, fuel, and a hangar.',
    airportToken: 'teterboro',
    services: ['ground_transport', 'close_protection', 'hotel', 'catering', 'fuel', 'hangar'],
    quantities: { ground_transport: 2, close_protection: 4 },
    arrivalLocal: '2026-03-06T15:00',
  },
  {
    id: 'multi-02',
    group: 'multi_service',
    sentence: 'Van Nuys tomorrow 10:00. One car, catering, and fuel on arrival.',
    airportToken: 'van nuys',
    services: ['ground_transport', 'catering', 'fuel'],
    quantities: { ground_transport: 1 },
    arrivalLocal: '2026-03-07T10:00',
  },
  {
    id: 'multi-03',
    group: 'multi_service',
    sentence: 'Palm Beach 09:00 Monday — hangar, fuel, two cars, hotel for five.',
    airportToken: 'palm beach',
    services: ['hangar', 'fuel', 'ground_transport', 'hotel'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-09T09:00',
  },
  {
    id: 'multi-04',
    group: 'multi_service',
    sentence: 'Teterboro, Saturday 14:00, security detail of two and one car.',
    airportToken: 'teterboro',
    services: ['close_protection', 'ground_transport'],
    quantities: { close_protection: 2, ground_transport: 1 },
    arrivalLocal: '2026-03-07T14:00',
  },
  {
    id: 'multi-05',
    group: 'multi_service',
    sentence: 'JFK 17:00 today. Catering, fuel, and ground transport for three passengers.',
    airportToken: 'jfk',
    services: ['catering', 'fuel', 'ground_transport'],
    arrivalLocal: '2026-03-06T17:00',
    passengers: 3,
  },

  // --- no quantities given -------------------------------------------------
  {
    id: 'noqty-01',
    group: 'no_quantity',
    sentence: 'Teterboro tomorrow 11:00, cars on arrival.',
    airportToken: 'teterboro',
    services: ['ground_transport'],
    arrivalLocal: '2026-03-07T11:00',
    missingFields: ['quantity'],
  },
  {
    id: 'noqty-02',
    group: 'no_quantity',
    sentence: 'Need bodyguards at Van Nuys on Sunday at 13:00.',
    airportToken: 'van nuys',
    services: ['close_protection'],
    arrivalLocal: '2026-03-08T13:00',
    missingFields: ['quantity'],
  },
  {
    id: 'noqty-03',
    group: 'no_quantity',
    sentence: 'Hotel rooms near Teterboro for Friday night.',
    airportToken: 'teterboro',
    services: ['hotel'],
    missingFields: ['quantity'],
  },
  {
    id: 'noqty-04',
    group: 'no_quantity',
    sentence: 'Fuel at Palm Beach tomorrow 08:00.',
    airportToken: 'palm beach',
    services: ['fuel'],
    arrivalLocal: '2026-03-07T08:00',
  },

  // --- casual / malformed language ----------------------------------------
  {
    id: 'casual-01',
    group: 'casual',
    sentence: 'hey can u do 2 cars teterboro fri 3am thx',
    airportToken: 'teterboro',
    services: ['ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-06T03:00',
  },
  {
    id: 'casual-02',
    group: 'casual',
    sentence: 'VNY tmrw ~9am. 1 car pls + fuel',
    airportToken: 'vny',
    services: ['ground_transport', 'fuel'],
    quantities: { ground_transport: 1 },
    arrivalLocal: '2026-03-07T09:00',
  },
  {
    id: 'casual-03',
    group: 'casual',
    sentence: 'need 3 bgs and 2 suvs @ teb sat 16:00',
    airportToken: 'teb',
    services: ['close_protection', 'ground_transport'],
    quantities: { close_protection: 3, ground_transport: 2 },
    arrivalLocal: '2026-03-07T16:00',
  },
  {
    id: 'casual-04',
    group: 'casual',
    sentence: 'PALM BEACH MONDAY 1300 TWO CARS HANGAR',
    airportToken: 'palm beach',
    services: ['ground_transport', 'hangar'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-09T13:00',
  },
  {
    id: 'casual-05',
    group: 'casual',
    sentence: 'car,,, teterboro   tomorrow    10:00 !!',
    airportToken: 'teterboro',
    services: ['ground_transport'],
    arrivalLocal: '2026-03-07T10:00',
  },

  // --- corrections mid-sentence -------------------------------------------
  {
    id: 'corr-01',
    group: 'correction',
    sentence: 'Two cars at Teterboro tomorrow — sorry, make that three cars.',
    airportToken: 'teterboro',
    services: ['ground_transport'],
    quantities: { ground_transport: 3 },
  },
  {
    id: 'corr-02',
    group: 'correction',
    sentence: 'Landing Van Nuys Friday. Actually Saturday, 14:00. One car.',
    airportToken: 'van nuys',
    services: ['ground_transport'],
    quantities: { ground_transport: 1 },
    arrivalLocal: '2026-03-07T14:00',
  },
  {
    id: 'corr-03',
    group: 'correction',
    sentence: 'Hotel for four — no, six — near Palm Beach Monday.',
    airportToken: 'palm beach',
    services: ['hotel'],
    // Graded on the correction being taken (six, not four) reaching the extraction at all,
    // not on quantity: "hotel for six" is the same guests-or-rooms ambiguity as hotel-01.
  },
  {
    id: 'corr-04',
    group: 'correction',
    sentence: 'Fuel at KTEB. Scratch that, we need fuel and a hangar at KTEB, tomorrow 07:00.',
    airportToken: 'kteb',
    services: ['fuel', 'hangar'],
    arrivalLocal: '2026-03-07T07:00',
  },

  // --- ambiguous "car" -----------------------------------------------------
  {
    id: 'car-01',
    group: 'ambiguous_car',
    sentence: 'Teterboro tomorrow 10:00, we need a car.',
    airportToken: 'teterboro',
    services: ['ground_transport'],
    quantities: { ground_transport: 1 },
    arrivalLocal: '2026-03-07T10:00',
  },
  {
    id: 'car-02',
    group: 'ambiguous_car',
    sentence: 'Van Nuys Sunday 15:00 — a car for the crew and a car for the principal.',
    airportToken: 'van nuys',
    services: ['ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-08T15:00',
  },
  {
    id: 'car-03',
    group: 'ambiguous_car',
    sentence: 'Teterboro Friday 09:00. Transport for nine people.',
    airportToken: 'teterboro',
    services: ['ground_transport'],
    arrivalLocal: '2026-03-06T09:00',
    passengers: 9,
  },
  {
    id: 'car-04',
    group: 'ambiguous_car',
    sentence: 'Two vehicles at Palm Beach Monday 11:00, SUVs if possible.',
    airportToken: 'palm beach',
    services: ['ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-09T11:00',
  },

  // --- bodyguard / security synonyms --------------------------------------
  {
    id: 'sec-01',
    group: 'security_synonym',
    sentence: 'Teterboro Friday 20:00, three close protection officers.',
    airportToken: 'teterboro',
    services: ['close_protection'],
    quantities: { close_protection: 3 },
    arrivalLocal: '2026-03-06T20:00',
  },
  {
    id: 'sec-02',
    group: 'security_synonym',
    sentence: 'Two bodyguards at Van Nuys Saturday 18:00.',
    airportToken: 'van nuys',
    services: ['close_protection'],
    quantities: { close_protection: 2 },
    arrivalLocal: '2026-03-07T18:00',
  },
  {
    id: 'sec-03',
    group: 'security_synonym',
    sentence: 'We need a security detail of four at Palm Beach on Monday 10:00.',
    airportToken: 'palm beach',
    services: ['close_protection'],
    quantities: { close_protection: 4 },
    arrivalLocal: '2026-03-09T10:00',
  },
  {
    id: 'sec-04',
    group: 'security_synonym',
    sentence: 'Personal protection for the principal, Teterboro, tomorrow 16:00.',
    airportToken: 'teterboro',
    services: ['close_protection'],
    arrivalLocal: '2026-03-07T16:00',
  },
  {
    id: 'sec-05',
    group: 'security_synonym',
    sentence: 'Armed escort, two officers, KTEB Sunday 08:00.',
    airportToken: 'kteb',
    services: ['close_protection'],
    quantities: { close_protection: 2 },
    arrivalLocal: '2026-03-08T08:00',
  },

  // --- hotel rooms versus nights ------------------------------------------
  {
    id: 'hotel-01',
    group: 'rooms_vs_nights',
    sentence: 'Teterboro Friday 19:00, hotel for nine.',
    airportToken: 'teterboro',
    services: ['hotel'],
    // No quantity expectation on purpose. "hotel for nine" is nine GUESTS or nine ROOMS
    // and the sentence does not say which; prompt rule 5 requires an ambiguity rather than
    // a guess, and booking nine rooms for nine people sharing would be an expensive wrong
    // answer. This case exists to hold that line.
    expectsAmbiguity: true,
    arrivalLocal: '2026-03-06T19:00',
  },
  {
    id: 'hotel-02',
    group: 'rooms_vs_nights',
    sentence: 'Four rooms for two nights near Van Nuys from Saturday.',
    airportToken: 'van nuys',
    services: ['hotel'],
    // Four ROOMS. "two nights" is a duration, not a quantity of rooms — the classic trap.
    quantities: { hotel: 4 },
  },
  {
    id: 'hotel-03',
    group: 'rooms_vs_nights',
    sentence: 'Three nights at a hotel by Palm Beach, two rooms, arriving Monday 14:00.',
    airportToken: 'palm beach',
    services: ['hotel'],
    quantities: { hotel: 2 },
    arrivalLocal: '2026-03-09T14:00',
  },
  {
    id: 'hotel-04',
    group: 'rooms_vs_nights',
    sentence: 'Hotel for the crew of two and six passengers, Teterboro tomorrow.',
    airportToken: 'teterboro',
    services: ['hotel'],
    passengers: 6,
    crew: 2,
  },

  // --- catering detail -----------------------------------------------------
  {
    id: 'cater-01',
    group: 'catering_detail',
    sentence: 'Teterboro tomorrow 12:00, catering for six, no shellfish.',
    airportToken: 'teterboro',
    services: ['catering'],
    arrivalLocal: '2026-03-07T12:00',
  },
  {
    id: 'cater-02',
    group: 'catering_detail',
    sentence: 'Cold breakfast platters for four at Van Nuys Sunday 07:00.',
    airportToken: 'van nuys',
    services: ['catering'],
    arrivalLocal: '2026-03-08T07:00',
  },
  {
    id: 'cater-03',
    group: 'catering_detail',
    sentence: 'Vegetarian catering, eight covers, Palm Beach Monday 13:30.',
    airportToken: 'palm beach',
    services: ['catering'],
    arrivalLocal: '2026-03-09T13:30',
  },
  {
    id: 'cater-04',
    group: 'catering_detail',
    sentence: 'Catering at KJFK today 18:00 — kosher, party of five.',
    airportToken: 'kjfk',
    services: ['catering'],
    arrivalLocal: '2026-03-06T18:00',
  },

  // --- fuel with no amount -------------------------------------------------
  {
    id: 'fuel-01',
    group: 'fuel_no_amount',
    sentence: 'Fuel on arrival at Teterboro tomorrow 09:00.',
    airportToken: 'teterboro',
    services: ['fuel'],
    arrivalLocal: '2026-03-07T09:00',
  },
  {
    id: 'fuel-02',
    group: 'fuel_no_amount',
    sentence: 'Top up Jet A at Van Nuys Saturday 11:00.',
    airportToken: 'van nuys',
    services: ['fuel'],
    arrivalLocal: '2026-03-07T11:00',
  },
  {
    id: 'fuel-03',
    group: 'fuel_no_amount',
    sentence: 'Uplift 800 gallons at Palm Beach Monday 10:00.',
    airportToken: 'palm beach',
    services: ['fuel'],
    arrivalLocal: '2026-03-09T10:00',
  },
  {
    id: 'fuel-04',
    group: 'fuel_no_amount',
    sentence: 'Need fuel and a car, KOPF, Sunday 12:00.',
    airportToken: 'kopf',
    services: ['fuel', 'ground_transport'],
    arrivalLocal: '2026-03-08T12:00',
  },

  // --- hangar duration -----------------------------------------------------
  {
    id: 'hangar-01',
    group: 'hangar_duration',
    sentence: 'Hangar at Teterboro from tomorrow 08:00 until Sunday 18:00.',
    airportToken: 'teterboro',
    services: ['hangar'],
    arrivalLocal: '2026-03-07T08:00',
    departureLocal: '2026-03-08T18:00',
  },
  {
    id: 'hangar-02',
    group: 'hangar_duration',
    sentence: 'Overnight hangar at Van Nuys, in Saturday 20:00 out Sunday 09:00.',
    airportToken: 'van nuys',
    services: ['hangar'],
    arrivalLocal: '2026-03-07T20:00',
    departureLocal: '2026-03-08T09:00',
  },
  {
    id: 'hangar-03',
    group: 'hangar_duration',
    sentence: 'Hangar space at Palm Beach for three nights from Monday.',
    airportToken: 'palm beach',
    services: ['hangar'],
  },
  {
    id: 'hangar-04',
    group: 'hangar_duration',
    sentence: 'KPBI hangar Monday 12:00, G650 — also two cars.',
    airportToken: 'kpbi',
    services: ['hangar', 'ground_transport'],
    quantities: { ground_transport: 2 },
    arrivalLocal: '2026-03-09T12:00',
  },
];
