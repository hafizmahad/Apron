import type { AircraftCategory } from '@/db/schema';

/**
 * Reference aviation data for the local development network.
 *
 * SOURCING NOTE (CLAUDE.md §16): airports, their identifiers, coordinates, timezones and
 * the FBO names below are real, publicly documented facts about real places — the kind of
 * reference data a licensed aviation dataset would later replace through the adapter in
 * `src/domain/airports/`. Nothing here is a live fact: no opening hours are claimed as
 * current, no FBO coordinates are invented, and no operational capability is attributed
 * to a real business.
 *
 * Provider companies, their coverage, staff and capacity are fictional by design and live
 * in `network.ts` — inventing availability for a named real company would be fabricating
 * facts about a real business.
 */

export interface SeedAirport {
  readonly icao: string;
  readonly iata: string;
  readonly name: string;
  readonly city: string;
  readonly stateRegion: string;
  readonly countryCode: string;
  /** Published airport reference point. */
  readonly latitude: string;
  readonly longitude: string;
  readonly timezoneIana: string;
}

export const seedAirports: readonly SeedAirport[] = [
  {
    icao: 'KTEB',
    iata: 'TEB',
    name: 'Teterboro Airport',
    city: 'Teterboro',
    stateRegion: 'New Jersey',
    countryCode: 'US',
    latitude: '40.850101',
    longitude: '-74.060799',
    timezoneIana: 'America/New_York',
  },
  {
    icao: 'KEWR',
    iata: 'EWR',
    name: 'Newark Liberty International Airport',
    city: 'Newark',
    stateRegion: 'New Jersey',
    countryCode: 'US',
    latitude: '40.692501',
    longitude: '-74.168700',
    timezoneIana: 'America/New_York',
  },
  {
    icao: 'KJFK',
    iata: 'JFK',
    name: 'John F. Kennedy International Airport',
    city: 'New York',
    stateRegion: 'New York',
    countryCode: 'US',
    latitude: '40.639801',
    longitude: '-73.778900',
    timezoneIana: 'America/New_York',
  },
  {
    icao: 'KVNY',
    iata: 'VNY',
    name: 'Van Nuys Airport',
    city: 'Los Angeles',
    stateRegion: 'California',
    countryCode: 'US',
    latitude: '34.209801',
    longitude: '-118.489998',
    timezoneIana: 'America/Los_Angeles',
  },
  {
    icao: 'KOPF',
    iata: 'OPF',
    name: 'Miami-Opa Locka Executive Airport',
    city: 'Opa-locka',
    stateRegion: 'Florida',
    countryCode: 'US',
    latitude: '25.907000',
    longitude: '-80.278397',
    timezoneIana: 'America/New_York',
  },
  {
    icao: 'KPBI',
    iata: 'PBI',
    name: 'Palm Beach International Airport',
    city: 'West Palm Beach',
    stateRegion: 'Florida',
    countryCode: 'US',
    latitude: '26.683201',
    longitude: '-80.095596',
    timezoneIana: 'America/New_York',
  },
];

export interface SeedFbo {
  readonly airportIcao: string;
  readonly name: string;
  /**
   * Desk hours as `[weekday, openMinute, closeMinute]`. These are plausible operating
   * patterns for the local network, NOT a claim about any real FBO's current hours —
   * real hours arrive with a licensed dataset.
   */
  readonly hours: readonly (readonly [number, number, number])[];
}

/** 24/7, every day. */
const ALWAYS_OPEN: readonly (readonly [number, number, number])[] = [
  [1, 0, 1440],
  [2, 0, 1440],
  [3, 0, 1440],
  [4, 0, 1440],
  [5, 0, 1440],
  [6, 0, 1440],
  [7, 0, 1440],
];

/** 05:00–23:00 weekdays, 06:00–22:00 weekends. */
const EXTENDED_DAY: readonly (readonly [number, number, number])[] = [
  [1, 300, 1380],
  [2, 300, 1380],
  [3, 300, 1380],
  [4, 300, 1380],
  [5, 300, 1380],
  [6, 360, 1320],
  [7, 360, 1320],
];

/** 06:00–22:00 weekdays, 07:00–20:00 weekends. */
const STANDARD_DAY: readonly (readonly [number, number, number])[] = [
  [1, 360, 1320],
  [2, 360, 1320],
  [3, 360, 1320],
  [4, 360, 1320],
  [5, 360, 1320],
  [6, 420, 1200],
  [7, 420, 1200],
];

/**
 * FBO coordinates are deliberately omitted. The exact position of a handling facility on
 * a field is not something to invent: the map renders the real airport reference point
 * and the generic apron illustration instead (CLAUDE.md §17, §21).
 */
export const seedFbos: readonly SeedFbo[] = [
  { airportIcao: 'KTEB', name: 'Signature Flight Support TEB', hours: ALWAYS_OPEN },
  { airportIcao: 'KTEB', name: 'Atlantic Aviation TEB', hours: ALWAYS_OPEN },
  { airportIcao: 'KTEB', name: 'Meridian Teterboro', hours: EXTENDED_DAY },
  { airportIcao: 'KTEB', name: 'Jet Aviation Teterboro', hours: EXTENDED_DAY },

  { airportIcao: 'KEWR', name: 'Signature Flight Support EWR', hours: ALWAYS_OPEN },

  { airportIcao: 'KJFK', name: 'Sheltair JFK', hours: EXTENDED_DAY },
  { airportIcao: 'KJFK', name: 'Signature Flight Support JFK', hours: ALWAYS_OPEN },

  { airportIcao: 'KVNY', name: 'Clay Lacy Aviation', hours: ALWAYS_OPEN },
  { airportIcao: 'KVNY', name: 'Signature Flight Support VNY', hours: EXTENDED_DAY },
  { airportIcao: 'KVNY', name: 'Castle & Cooke Aviation VNY', hours: STANDARD_DAY },

  { airportIcao: 'KOPF', name: 'Signature Flight Support OPF', hours: EXTENDED_DAY },
  { airportIcao: 'KOPF', name: 'Fontainebleau Aviation', hours: EXTENDED_DAY },

  { airportIcao: 'KPBI', name: 'Signature Flight Support PBI', hours: ALWAYS_OPEN },
  { airportIcao: 'KPBI', name: 'Atlantic Aviation PBI', hours: EXTENDED_DAY },
];

export interface SeedAircraft {
  readonly tailNumber: string;
  readonly typeCode: string;
  readonly model: string;
  readonly manufacturer: string;
  readonly operatorName: string;
  readonly category: AircraftCategory;
  readonly passengerCapacity: number;
  /** Published type dimensions — these drive the hangar-fit rule, so they must be real. */
  readonly wingspanFt: string;
  readonly lengthFt: string;
  readonly tailHeightFt: string;
  readonly mtowLbs: number;
}

/**
 * Tail numbers are fictional registrations in valid US format; the airframe types and
 * their published dimensions are real, because the hangar-fit rule compares against them.
 */
export const seedAircraft: readonly SeedAircraft[] = [
  {
    tailNumber: 'N418MC',
    typeCode: 'GLF6',
    model: 'G650ER',
    manufacturer: 'Gulfstream',
    operatorName: 'Meridian Capital Partners',
    category: 'ultra_long_range',
    passengerCapacity: 14,
    wingspanFt: '99.58',
    lengthFt: '99.75',
    tailHeightFt: '25.67',
    mtowLbs: 103600,
  },
  {
    tailNumber: 'N720CV',
    typeCode: 'GLEX',
    model: 'Global 7500',
    manufacturer: 'Bombardier',
    operatorName: 'Coastline Ventures',
    category: 'ultra_long_range',
    passengerCapacity: 14,
    wingspanFt: '104.00',
    lengthFt: '111.00',
    tailHeightFt: '27.00',
    mtowLbs: 114850,
  },
  {
    tailNumber: 'N355AH',
    typeCode: 'C68A',
    model: 'Citation Latitude',
    manufacturer: 'Cessna',
    operatorName: 'Aurora Health Group',
    category: 'midsize',
    passengerCapacity: 9,
    wingspanFt: '72.33',
    lengthFt: '62.25',
    tailHeightFt: '20.83',
    mtowLbs: 30800,
  },
  {
    tailNumber: 'N262TB',
    typeCode: 'CL35',
    model: 'Challenger 350',
    manufacturer: 'Bombardier',
    operatorName: 'Meridian Capital Partners',
    category: 'super_midsize',
    passengerCapacity: 10,
    wingspanFt: '69.00',
    lengthFt: '68.75',
    tailHeightFt: '20.00',
    mtowLbs: 40600,
  },
  {
    tailNumber: 'N899PG',
    typeCode: 'FA7X',
    model: 'Falcon 7X',
    manufacturer: 'Dassault',
    operatorName: 'Pinegrove Family Office',
    category: 'heavy',
    passengerCapacity: 12,
    wingspanFt: '86.00',
    lengthFt: '76.08',
    tailHeightFt: '25.17',
    mtowLbs: 70000,
  },
  {
    tailNumber: 'N147RS',
    typeCode: 'PC24',
    model: 'PC-24',
    manufacturer: 'Pilatus',
    operatorName: 'Coastline Ventures',
    category: 'light',
    passengerCapacity: 8,
    wingspanFt: '55.75',
    lengthFt: '55.17',
    tailHeightFt: '17.42',
    mtowLbs: 18300,
  },
];
