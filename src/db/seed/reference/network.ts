import type { FuelType, VehicleClass } from '@/db/schema';

/**
 * The fictional provider network.
 *
 * SOURCING NOTE (CLAUDE.md §16): every company, vehicle, driver, officer, hotel, kitchen,
 * fuel truck and hangar below is INVENTED. Attributing coverage, capacity or staffing to
 * a real named business would be fabricating facts about that business. The names read
 * like real operators because the UI must never show "Provider 1" — but none of them
 * exist, and all of it is replaced by the licensed-data adapter in a later phase.
 *
 * The network is deliberately shaped to exercise the matching engine rather than to look
 * tidy: overlapping coverage at KTEB so ranking actually decides, one suspended company,
 * one pending approval, a desk that closes overnight so a 03:00 arrival filters it out, a
 * hangar too small for a G650, and a provider with a blackout window.
 */

export interface SeedProvider {
  readonly slug: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly status: 'pending' | 'approved' | 'suspended' | 'rejected';
  readonly rank: number;
  readonly dispatchEmail: string;
  readonly dispatchPhone: string;
  readonly countryCode: string;
  readonly notes: string;
  readonly suspensionReason?: string;
}

export const seedProviders: readonly SeedProvider[] = [
  // --- ground transport, north-east ---
  {
    slug: 'hudson-executive-transport',
    legalName: 'Hudson Executive Transport LLC',
    displayName: 'Hudson Executive Transport',
    status: 'approved',
    rank: 120,
    dispatchEmail: 'dispatch@hudsonexec.example',
    dispatchPhone: '+1 201 555 0142',
    countryCode: 'US',
    notes: 'Largest fleet at Teterboro. 24/7 desk.',
  },
  {
    slug: 'palisade-chauffeur-group',
    legalName: 'Palisade Chauffeur Group Inc.',
    displayName: 'Palisade Chauffeur Group',
    status: 'approved',
    rank: 240,
    dispatchEmail: 'ops@palisadechauffeur.example',
    dispatchPhone: '+1 201 555 0188',
    countryCode: 'US',
    notes: 'Strong overnight coverage, smaller fleet. Competes with Hudson at KTEB and KEWR.',
  },
  {
    slug: 'gotham-livery-partners',
    legalName: 'Gotham Livery Partners LLC',
    displayName: 'Gotham Livery Partners',
    status: 'approved',
    rank: 360,
    dispatchEmail: 'dispatch@gothamlivery.example',
    dispatchPhone: '+1 212 555 0119',
    countryCode: 'US',
    notes: 'Daytime desk only — filtered out of overnight arrivals by desk hours.',
  },
  // --- ground transport, west and south ---
  {
    slug: 'pacific-coast-chauffeur',
    legalName: 'Pacific Coast Chauffeur Services Inc.',
    displayName: 'Pacific Coast Chauffeur',
    status: 'approved',
    rank: 150,
    dispatchEmail: 'dispatch@pacificcoastchauffeur.example',
    dispatchPhone: '+1 818 555 0164',
    countryCode: 'US',
    notes: 'Van Nuys base.',
  },
  {
    slug: 'biscayne-executive-motors',
    legalName: 'Biscayne Executive Motors LLC',
    displayName: 'Biscayne Executive Motors',
    status: 'approved',
    rank: 180,
    dispatchEmail: 'dispatch@biscayneexec.example',
    dispatchPhone: '+1 305 555 0173',
    countryCode: 'US',
    notes: 'Covers both KOPF and KPBI.',
  },
  // --- close protection ---
  {
    slug: 'sentinel-risk-group',
    legalName: 'Sentinel Risk Group LLC',
    displayName: 'Sentinel Risk Group',
    status: 'approved',
    rank: 110,
    dispatchEmail: 'operations@sentinelrisk.example',
    dispatchPhone: '+1 646 555 0107',
    countryCode: 'US',
    notes: 'Armed and unarmed details, north-east and Florida.',
  },
  {
    slug: 'praetorian-protective',
    legalName: 'Praetorian Protective Services Inc.',
    displayName: 'Praetorian Protective Services',
    status: 'approved',
    rank: 260,
    dispatchEmail: 'ops@praetorianprotective.example',
    dispatchPhone: '+1 310 555 0155',
    countryCode: 'US',
    notes: 'Unarmed details only on the west coast.',
  },
  // --- hotel ---
  {
    slug: 'harborview-hospitality',
    legalName: 'Harborview Hospitality Group LLC',
    displayName: 'Harborview Hospitality Group',
    status: 'approved',
    rank: 200,
    dispatchEmail: 'reservations@harborviewhospitality.example',
    dispatchPhone: '+1 201 555 0196',
    countryCode: 'US',
    notes: 'Partner properties near KTEB and KEWR.',
  },
  {
    slug: 'coastal-suites-partners',
    legalName: 'Coastal Suites Partners LLC',
    displayName: 'Coastal Suites Partners',
    status: 'approved',
    rank: 280,
    dispatchEmail: 'bookings@coastalsuites.example',
    dispatchPhone: '+1 561 555 0134',
    countryCode: 'US',
    notes: 'Florida properties.',
  },
  // --- catering ---
  {
    slug: 'altitude-culinary',
    legalName: 'Altitude Culinary LLC',
    displayName: 'Altitude Culinary',
    status: 'approved',
    rank: 140,
    dispatchEmail: 'orders@altitudeculinary.example',
    dispatchPhone: '+1 201 555 0121',
    countryCode: 'US',
    notes: 'Four-hour lead time. Kosher and halal certified.',
  },
  {
    slug: 'blue-sky-provisions',
    legalName: 'Blue Sky Provisions Inc.',
    displayName: 'Blue Sky Provisions',
    status: 'approved',
    rank: 300,
    dispatchEmail: 'kitchen@blueskyprovisions.example',
    dispatchPhone: '+1 818 555 0148',
    countryCode: 'US',
    notes: 'Twelve-hour lead time — filtered out of short-notice requests.',
  },
  // --- fuel ---
  {
    slug: 'northeast-into-plane',
    legalName: 'Northeast Into-Plane Services LLC',
    displayName: 'Northeast Into-Plane',
    status: 'approved',
    rank: 130,
    dispatchEmail: 'fuel@northeastintoplane.example',
    dispatchPhone: '+1 201 555 0152',
    countryCode: 'US',
    notes: 'Jet A and SAF blend at KTEB, KEWR, KJFK.',
  },
  {
    slug: 'skyline-fuel-partners',
    legalName: 'Skyline Fuel Partners LLC',
    displayName: 'Skyline Fuel Partners',
    status: 'approved',
    rank: 250,
    dispatchEmail: 'dispatch@skylinefuel.example',
    dispatchPhone: '+1 305 555 0166',
    countryCode: 'US',
    notes: 'Florida and west coast.',
  },
  // --- hangar ---
  {
    slug: 'gateway-hangar-partners',
    legalName: 'Gateway Hangar Partners LLC',
    displayName: 'Gateway Hangar Partners',
    status: 'approved',
    rank: 160,
    dispatchEmail: 'ops@gatewayhangar.example',
    dispatchPhone: '+1 201 555 0177',
    countryCode: 'US',
    notes: 'One wide-body-capable bay at KTEB, one narrow bay that cannot take a G650.',
  },
  {
    slug: 'palm-coast-hangar',
    legalName: 'Palm Coast Hangar Services Inc.',
    displayName: 'Palm Coast Hangar Services',
    status: 'approved',
    rank: 220,
    dispatchEmail: 'ops@palmcoasthangar.example',
    dispatchPhone: '+1 561 555 0181',
    countryCode: 'US',
    notes: 'Heated bays in Florida.',
  },
  // --- governance states that must exist for Admin to be exercised ---
  {
    slug: 'meridian-ground-services',
    legalName: 'Meridian Ground Services LLC',
    displayName: 'Meridian Ground Services',
    status: 'pending',
    rank: 500,
    dispatchEmail: 'hello@meridiangroundservices.example',
    dispatchPhone: '+1 201 555 0190',
    countryCode: 'US',
    notes: 'Registered but not yet approved. Must never appear as an eligible candidate.',
  },
  {
    slug: 'atlas-executive-cars',
    legalName: 'Atlas Executive Cars LLC',
    displayName: 'Atlas Executive Cars',
    status: 'suspended',
    rank: 400,
    dispatchEmail: 'dispatch@atlasexecutivecars.example',
    dispatchPhone: '+1 718 555 0128',
    countryCode: 'US',
    notes: 'Previously covered KJFK. Suspended pending insurance renewal.',
    suspensionReason: 'Certificate of insurance lapsed on renewal and has not been re-submitted.',
  },
];

export interface SeedCoverage {
  readonly providerSlug: string;
  readonly serviceCode: string;
  readonly airportIcao: string;
  /** Named FBO for FBO-scoped coverage; omitted means airport-wide. */
  readonly fboName?: string;
  readonly totalCapacity: number;
  readonly leadTimeMinutes: number;
  readonly maxNoticeDays?: number;
  readonly is247: boolean;
  /** `[weekday, openMinute, closeMinute]`; ignored when `is247`. */
  readonly hours?: readonly (readonly [number, number, number])[];
}

const DESK_0600_2200: readonly (readonly [number, number, number])[] = [
  [1, 360, 1320],
  [2, 360, 1320],
  [3, 360, 1320],
  [4, 360, 1320],
  [5, 360, 1320],
  [6, 420, 1200],
  [7, 420, 1200],
];

/** 16:00 through 06:00 the next morning — the overnight desk, crossing midnight. */
const DESK_OVERNIGHT: readonly (readonly [number, number, number])[] = [
  [1, 960, 1800],
  [2, 960, 1800],
  [3, 960, 1800],
  [4, 960, 1800],
  [5, 960, 1800],
  [6, 960, 1800],
  [7, 960, 1800],
];

const DESK_0800_1800: readonly (readonly [number, number, number])[] = [
  [1, 480, 1080],
  [2, 480, 1080],
  [3, 480, 1080],
  [4, 480, 1080],
  [5, 480, 1080],
];

export const seedCoverage: readonly SeedCoverage[] = [
  // Ground transport at KTEB — three companies, so ranking genuinely decides.
  { providerSlug: 'hudson-executive-transport', serviceCode: 'ground_transport', airportIcao: 'KTEB', totalCapacity: 8, leadTimeMinutes: 90, is247: true },
  { providerSlug: 'palisade-chauffeur-group', serviceCode: 'ground_transport', airportIcao: 'KTEB', totalCapacity: 4, leadTimeMinutes: 120, is247: false, hours: DESK_OVERNIGHT },
  { providerSlug: 'gotham-livery-partners', serviceCode: 'ground_transport', airportIcao: 'KTEB', totalCapacity: 6, leadTimeMinutes: 120, is247: false, hours: DESK_0800_1800 },

  { providerSlug: 'hudson-executive-transport', serviceCode: 'ground_transport', airportIcao: 'KEWR', totalCapacity: 5, leadTimeMinutes: 90, is247: true },
  { providerSlug: 'palisade-chauffeur-group', serviceCode: 'ground_transport', airportIcao: 'KEWR', totalCapacity: 3, leadTimeMinutes: 120, is247: false, hours: DESK_OVERNIGHT },
  { providerSlug: 'gotham-livery-partners', serviceCode: 'ground_transport', airportIcao: 'KJFK', totalCapacity: 6, leadTimeMinutes: 120, is247: false, hours: DESK_0600_2200 },
  // FBO-scoped coverage: this row only satisfies requests naming Signature at JFK.
  { providerSlug: 'hudson-executive-transport', serviceCode: 'ground_transport', airportIcao: 'KJFK', fboName: 'Signature Flight Support JFK', totalCapacity: 3, leadTimeMinutes: 120, is247: true },

  { providerSlug: 'pacific-coast-chauffeur', serviceCode: 'ground_transport', airportIcao: 'KVNY', totalCapacity: 6, leadTimeMinutes: 90, is247: true },
  { providerSlug: 'biscayne-executive-motors', serviceCode: 'ground_transport', airportIcao: 'KOPF', totalCapacity: 5, leadTimeMinutes: 90, is247: true },
  { providerSlug: 'biscayne-executive-motors', serviceCode: 'ground_transport', airportIcao: 'KPBI', totalCapacity: 4, leadTimeMinutes: 120, is247: false, hours: DESK_0600_2200 },
  // Suspended company retains coverage rows; eligibility must reject on status alone.
  { providerSlug: 'atlas-executive-cars', serviceCode: 'ground_transport', airportIcao: 'KJFK', totalCapacity: 4, leadTimeMinutes: 120, is247: true },
  // Pending company, likewise.
  { providerSlug: 'meridian-ground-services', serviceCode: 'ground_transport', airportIcao: 'KTEB', totalCapacity: 3, leadTimeMinutes: 120, is247: true },

  // Close protection
  { providerSlug: 'sentinel-risk-group', serviceCode: 'close_protection', airportIcao: 'KTEB', totalCapacity: 6, leadTimeMinutes: 240, is247: true },
  { providerSlug: 'sentinel-risk-group', serviceCode: 'close_protection', airportIcao: 'KEWR', totalCapacity: 4, leadTimeMinutes: 240, is247: true },
  { providerSlug: 'sentinel-risk-group', serviceCode: 'close_protection', airportIcao: 'KOPF', totalCapacity: 4, leadTimeMinutes: 240, is247: true },
  { providerSlug: 'praetorian-protective', serviceCode: 'close_protection', airportIcao: 'KVNY', totalCapacity: 5, leadTimeMinutes: 300, is247: false, hours: DESK_0600_2200 },
  { providerSlug: 'praetorian-protective', serviceCode: 'close_protection', airportIcao: 'KTEB', totalCapacity: 3, leadTimeMinutes: 300, is247: false, hours: DESK_0600_2200 },

  // Hotel
  { providerSlug: 'harborview-hospitality', serviceCode: 'hotel', airportIcao: 'KTEB', totalCapacity: 40, leadTimeMinutes: 120, is247: true },
  { providerSlug: 'harborview-hospitality', serviceCode: 'hotel', airportIcao: 'KEWR', totalCapacity: 30, leadTimeMinutes: 120, is247: true },
  { providerSlug: 'coastal-suites-partners', serviceCode: 'hotel', airportIcao: 'KOPF', totalCapacity: 25, leadTimeMinutes: 180, is247: true },
  { providerSlug: 'coastal-suites-partners', serviceCode: 'hotel', airportIcao: 'KPBI', totalCapacity: 20, leadTimeMinutes: 180, is247: true },

  // Catering — Altitude at 4h, Blue Sky at 12h, so short notice filters one out.
  { providerSlug: 'altitude-culinary', serviceCode: 'catering', airportIcao: 'KTEB', totalCapacity: 8, leadTimeMinutes: 240, is247: false, hours: DESK_0600_2200 },
  { providerSlug: 'altitude-culinary', serviceCode: 'catering', airportIcao: 'KEWR', totalCapacity: 6, leadTimeMinutes: 240, is247: false, hours: DESK_0600_2200 },
  { providerSlug: 'altitude-culinary', serviceCode: 'catering', airportIcao: 'KJFK', totalCapacity: 6, leadTimeMinutes: 300, is247: false, hours: DESK_0600_2200 },
  { providerSlug: 'blue-sky-provisions', serviceCode: 'catering', airportIcao: 'KTEB', totalCapacity: 4, leadTimeMinutes: 720, is247: false, hours: DESK_0600_2200 },
  { providerSlug: 'blue-sky-provisions', serviceCode: 'catering', airportIcao: 'KVNY', totalCapacity: 5, leadTimeMinutes: 720, is247: false, hours: DESK_0600_2200 },

  // Fuel
  { providerSlug: 'northeast-into-plane', serviceCode: 'fuel', airportIcao: 'KTEB', totalCapacity: 3, leadTimeMinutes: 60, is247: true },
  { providerSlug: 'northeast-into-plane', serviceCode: 'fuel', airportIcao: 'KEWR', totalCapacity: 2, leadTimeMinutes: 60, is247: true },
  { providerSlug: 'northeast-into-plane', serviceCode: 'fuel', airportIcao: 'KJFK', totalCapacity: 2, leadTimeMinutes: 90, is247: true },
  { providerSlug: 'skyline-fuel-partners', serviceCode: 'fuel', airportIcao: 'KOPF', totalCapacity: 2, leadTimeMinutes: 90, is247: true },
  { providerSlug: 'skyline-fuel-partners', serviceCode: 'fuel', airportIcao: 'KPBI', totalCapacity: 2, leadTimeMinutes: 90, is247: true },
  { providerSlug: 'skyline-fuel-partners', serviceCode: 'fuel', airportIcao: 'KVNY', totalCapacity: 2, leadTimeMinutes: 90, is247: true },

  // Hangar
  { providerSlug: 'gateway-hangar-partners', serviceCode: 'hangar', airportIcao: 'KTEB', totalCapacity: 2, leadTimeMinutes: 180, is247: true },
  { providerSlug: 'gateway-hangar-partners', serviceCode: 'hangar', airportIcao: 'KEWR', totalCapacity: 1, leadTimeMinutes: 240, is247: false, hours: DESK_0600_2200 },
  { providerSlug: 'palm-coast-hangar', serviceCode: 'hangar', airportIcao: 'KPBI', totalCapacity: 2, leadTimeMinutes: 240, is247: true },
  { providerSlug: 'palm-coast-hangar', serviceCode: 'hangar', airportIcao: 'KOPF', totalCapacity: 1, leadTimeMinutes: 240, is247: true },
];

export interface SeedVehicle {
  readonly providerSlug: string;
  readonly homeAirportIcao: string;
  readonly vehicleClass: VehicleClass;
  readonly make: string;
  readonly model: string;
  readonly modelYear: number;
  readonly plateReference: string;
  readonly passengerCapacity: number;
  readonly luggageCapacity: number;
  readonly features: readonly string[];
}

export const seedVehicles: readonly SeedVehicle[] = [
  // Hudson — KTEB
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', vehicleClass: 'suv', make: 'Cadillac', model: 'Escalade ESV', modelYear: 2024, plateReference: 'HET-101', passengerCapacity: 6, luggageCapacity: 6, features: ['wifi', 'partition', 'water'] },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', vehicleClass: 'suv', make: 'Cadillac', model: 'Escalade ESV', modelYear: 2024, plateReference: 'HET-102', passengerCapacity: 6, luggageCapacity: 6, features: ['wifi', 'partition', 'water'] },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', vehicleClass: 'suv', make: 'Lincoln', model: 'Navigator L', modelYear: 2023, plateReference: 'HET-103', passengerCapacity: 6, luggageCapacity: 5, features: ['wifi'] },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', vehicleClass: 'sedan', make: 'Mercedes-Benz', model: 'S 580', modelYear: 2024, plateReference: 'HET-104', passengerCapacity: 3, luggageCapacity: 3, features: ['wifi', 'rear_climate'] },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', vehicleClass: 'sprinter', make: 'Mercedes-Benz', model: 'Sprinter Executive', modelYear: 2023, plateReference: 'HET-105', passengerCapacity: 11, luggageCapacity: 14, features: ['wifi', 'conference_seating'] },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', vehicleClass: 'armored_suv', make: 'Chevrolet', model: 'Suburban B6', modelYear: 2023, plateReference: 'HET-106', passengerCapacity: 5, luggageCapacity: 4, features: ['armored_b6', 'run_flat'] },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KEWR', vehicleClass: 'suv', make: 'Cadillac', model: 'Escalade ESV', modelYear: 2023, plateReference: 'HET-201', passengerCapacity: 6, luggageCapacity: 6, features: ['wifi'] },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KEWR', vehicleClass: 'sedan', make: 'BMW', model: '7 Series', modelYear: 2024, plateReference: 'HET-202', passengerCapacity: 3, luggageCapacity: 3, features: ['wifi'] },

  // Palisade — KTEB, overnight specialists
  { providerSlug: 'palisade-chauffeur-group', homeAirportIcao: 'KTEB', vehicleClass: 'suv', make: 'GMC', model: 'Yukon XL Denali', modelYear: 2024, plateReference: 'PCG-11', passengerCapacity: 6, luggageCapacity: 6, features: ['wifi', 'child_seat'] },
  { providerSlug: 'palisade-chauffeur-group', homeAirportIcao: 'KTEB', vehicleClass: 'suv', make: 'GMC', model: 'Yukon XL Denali', modelYear: 2023, plateReference: 'PCG-12', passengerCapacity: 6, luggageCapacity: 6, features: ['wifi'] },
  { providerSlug: 'palisade-chauffeur-group', homeAirportIcao: 'KTEB', vehicleClass: 'sedan', make: 'Mercedes-Benz', model: 'E 450', modelYear: 2023, plateReference: 'PCG-13', passengerCapacity: 3, luggageCapacity: 2, features: [] },
  { providerSlug: 'palisade-chauffeur-group', homeAirportIcao: 'KEWR', vehicleClass: 'van', make: 'Mercedes-Benz', model: 'Metris', modelYear: 2023, plateReference: 'PCG-21', passengerCapacity: 7, luggageCapacity: 8, features: [] },

  // Gotham — daytime only
  { providerSlug: 'gotham-livery-partners', homeAirportIcao: 'KTEB', vehicleClass: 'sedan', make: 'Mercedes-Benz', model: 'S 500', modelYear: 2022, plateReference: 'GLP-31', passengerCapacity: 3, luggageCapacity: 3, features: ['wifi'] },
  { providerSlug: 'gotham-livery-partners', homeAirportIcao: 'KJFK', vehicleClass: 'suv', make: 'Cadillac', model: 'Escalade', modelYear: 2023, plateReference: 'GLP-41', passengerCapacity: 6, luggageCapacity: 5, features: [] },
  { providerSlug: 'gotham-livery-partners', homeAirportIcao: 'KJFK', vehicleClass: 'sprinter', make: 'Mercedes-Benz', model: 'Sprinter', modelYear: 2022, plateReference: 'GLP-42', passengerCapacity: 12, luggageCapacity: 16, features: [] },

  // Pacific Coast — KVNY
  { providerSlug: 'pacific-coast-chauffeur', homeAirportIcao: 'KVNY', vehicleClass: 'suv', make: 'Cadillac', model: 'Escalade ESV', modelYear: 2024, plateReference: 'PCC-01', passengerCapacity: 6, luggageCapacity: 6, features: ['wifi'] },
  { providerSlug: 'pacific-coast-chauffeur', homeAirportIcao: 'KVNY', vehicleClass: 'suv', make: 'Lincoln', model: 'Navigator', modelYear: 2023, plateReference: 'PCC-02', passengerCapacity: 6, luggageCapacity: 5, features: [] },
  { providerSlug: 'pacific-coast-chauffeur', homeAirportIcao: 'KVNY', vehicleClass: 'sedan', make: 'Mercedes-Benz', model: 'S 580', modelYear: 2024, plateReference: 'PCC-03', passengerCapacity: 3, luggageCapacity: 3, features: ['wifi'] },
  { providerSlug: 'pacific-coast-chauffeur', homeAirportIcao: 'KVNY', vehicleClass: 'sprinter', make: 'Mercedes-Benz', model: 'Sprinter Executive', modelYear: 2024, plateReference: 'PCC-04', passengerCapacity: 11, luggageCapacity: 14, features: ['wifi'] },

  // Biscayne — KOPF/KPBI
  { providerSlug: 'biscayne-executive-motors', homeAirportIcao: 'KOPF', vehicleClass: 'suv', make: 'Cadillac', model: 'Escalade ESV', modelYear: 2024, plateReference: 'BEM-01', passengerCapacity: 6, luggageCapacity: 6, features: ['wifi'] },
  { providerSlug: 'biscayne-executive-motors', homeAirportIcao: 'KOPF', vehicleClass: 'sedan', make: 'Mercedes-Benz', model: 'S 580', modelYear: 2023, plateReference: 'BEM-02', passengerCapacity: 3, luggageCapacity: 3, features: [] },
  { providerSlug: 'biscayne-executive-motors', homeAirportIcao: 'KPBI', vehicleClass: 'suv', make: 'GMC', model: 'Yukon XL', modelYear: 2023, plateReference: 'BEM-11', passengerCapacity: 6, luggageCapacity: 6, features: [] },
  { providerSlug: 'biscayne-executive-motors', homeAirportIcao: 'KPBI', vehicleClass: 'van', make: 'Mercedes-Benz', model: 'Metris', modelYear: 2022, plateReference: 'BEM-12', passengerCapacity: 7, luggageCapacity: 8, features: [] },

  // Atlas (suspended) — vehicles exist but the company must never be eligible.
  { providerSlug: 'atlas-executive-cars', homeAirportIcao: 'KJFK', vehicleClass: 'suv', make: 'Cadillac', model: 'Escalade', modelYear: 2021, plateReference: 'AEC-01', passengerCapacity: 6, luggageCapacity: 5, features: [] },
];

export interface SeedStaff {
  readonly providerSlug: string;
  readonly homeAirportIcao: string;
  readonly fullName: string;
  readonly phone: string;
  readonly languages: readonly string[];
  readonly timezoneIana: string;
  /** `[weekday, openMinute, closeMinute]`. Windows past 1440 cross midnight. */
  readonly shifts: readonly (readonly [number, number, number])[];
  readonly armedCertified?: boolean;
}

/** 06:00–18:00, Monday to Friday. */
const SHIFT_DAY: readonly (readonly [number, number, number])[] = [
  [1, 360, 1080],
  [2, 360, 1080],
  [3, 360, 1080],
  [4, 360, 1080],
  [5, 360, 1080],
];

/** 18:00 through 06:00 — the night shift, expressed as a window crossing midnight. */
const SHIFT_NIGHT: readonly (readonly [number, number, number])[] = [
  [1, 1080, 1800],
  [2, 1080, 1800],
  [3, 1080, 1800],
  [4, 1080, 1800],
  [5, 1080, 1800],
  [6, 1080, 1800],
  [7, 1080, 1800],
];

/** 06:00–18:00 every day including weekends. */
const SHIFT_DAY_ALL_WEEK: readonly (readonly [number, number, number])[] = [
  [1, 360, 1080],
  [2, 360, 1080],
  [3, 360, 1080],
  [4, 360, 1080],
  [5, 360, 1080],
  [6, 360, 1080],
  [7, 360, 1080],
];

export const seedDrivers: readonly SeedStaff[] = [
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', fullName: 'Marcus Delgado', phone: '+1 201 555 0211', languages: ['en', 'es'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', fullName: 'Priya Raghunathan', phone: '+1 201 555 0212', languages: ['en', 'hi'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', fullName: 'Thomas Brennan', phone: '+1 201 555 0213', languages: ['en'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', fullName: 'Aisha Warsame', phone: '+1 201 555 0214', languages: ['en', 'ar'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY_ALL_WEEK },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KTEB', fullName: 'Kenji Watanabe', phone: '+1 201 555 0215', languages: ['en', 'ja'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KEWR', fullName: 'Daniel Okonkwo', phone: '+1 201 555 0221', languages: ['en'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY_ALL_WEEK },
  { providerSlug: 'hudson-executive-transport', homeAirportIcao: 'KEWR', fullName: 'Elena Vasquez', phone: '+1 201 555 0222', languages: ['en', 'es'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT },

  { providerSlug: 'palisade-chauffeur-group', homeAirportIcao: 'KTEB', fullName: 'Robert Kowalski', phone: '+1 201 555 0231', languages: ['en', 'pl'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT },
  { providerSlug: 'palisade-chauffeur-group', homeAirportIcao: 'KTEB', fullName: 'Nadia Haddad', phone: '+1 201 555 0232', languages: ['en', 'fr', 'ar'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT },
  { providerSlug: 'palisade-chauffeur-group', homeAirportIcao: 'KEWR', fullName: 'Victor Almeida', phone: '+1 201 555 0233', languages: ['en', 'pt'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT },

  { providerSlug: 'gotham-livery-partners', homeAirportIcao: 'KTEB', fullName: 'Sean Murphy', phone: '+1 212 555 0241', languages: ['en'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY },
  { providerSlug: 'gotham-livery-partners', homeAirportIcao: 'KJFK', fullName: 'Lucia Moreno', phone: '+1 212 555 0242', languages: ['en', 'es'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY },

  { providerSlug: 'pacific-coast-chauffeur', homeAirportIcao: 'KVNY', fullName: 'Grace Nakamura', phone: '+1 818 555 0251', languages: ['en', 'ja'], timezoneIana: 'America/Los_Angeles', shifts: SHIFT_DAY_ALL_WEEK },
  { providerSlug: 'pacific-coast-chauffeur', homeAirportIcao: 'KVNY', fullName: 'Andre Dubois', phone: '+1 818 555 0252', languages: ['en', 'fr'], timezoneIana: 'America/Los_Angeles', shifts: SHIFT_NIGHT },
  { providerSlug: 'pacific-coast-chauffeur', homeAirportIcao: 'KVNY', fullName: 'Miguel Santos', phone: '+1 818 555 0253', languages: ['en', 'es'], timezoneIana: 'America/Los_Angeles', shifts: SHIFT_DAY_ALL_WEEK },

  { providerSlug: 'biscayne-executive-motors', homeAirportIcao: 'KOPF', fullName: 'Carlos Ferreira', phone: '+1 305 555 0261', languages: ['en', 'es', 'pt'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY_ALL_WEEK },
  { providerSlug: 'biscayne-executive-motors', homeAirportIcao: 'KOPF', fullName: 'Yolanda Reyes', phone: '+1 305 555 0262', languages: ['en', 'es'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT },
  { providerSlug: 'biscayne-executive-motors', homeAirportIcao: 'KPBI', fullName: 'Gregory Hollis', phone: '+1 561 555 0263', languages: ['en'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY_ALL_WEEK },
];

export const seedOfficers: readonly SeedStaff[] = [
  { providerSlug: 'sentinel-risk-group', homeAirportIcao: 'KTEB', fullName: 'David Okafor', phone: '+1 646 555 0301', languages: ['en'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT, armedCertified: true },
  { providerSlug: 'sentinel-risk-group', homeAirportIcao: 'KTEB', fullName: 'Rachel Stein', phone: '+1 646 555 0302', languages: ['en', 'he'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT, armedCertified: true },
  { providerSlug: 'sentinel-risk-group', homeAirportIcao: 'KTEB', fullName: 'Ibrahim Osei', phone: '+1 646 555 0303', languages: ['en', 'fr'], timezoneIana: 'America/New_York', shifts: SHIFT_NIGHT, armedCertified: true },
  { providerSlug: 'sentinel-risk-group', homeAirportIcao: 'KTEB', fullName: 'Maria Petrova', phone: '+1 646 555 0304', languages: ['en', 'ru'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY_ALL_WEEK, armedCertified: false },
  { providerSlug: 'sentinel-risk-group', homeAirportIcao: 'KEWR', fullName: 'Jonah Whitfield', phone: '+1 646 555 0311', languages: ['en'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY_ALL_WEEK, armedCertified: true },
  { providerSlug: 'sentinel-risk-group', homeAirportIcao: 'KOPF', fullName: 'Ana Lucia Cruz', phone: '+1 305 555 0321', languages: ['en', 'es'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY_ALL_WEEK, armedCertified: true },

  { providerSlug: 'praetorian-protective', homeAirportIcao: 'KVNY', fullName: 'Tyler Brooks', phone: '+1 310 555 0331', languages: ['en'], timezoneIana: 'America/Los_Angeles', shifts: SHIFT_DAY_ALL_WEEK, armedCertified: false },
  { providerSlug: 'praetorian-protective', homeAirportIcao: 'KVNY', fullName: 'Simone Laurent', phone: '+1 310 555 0332', languages: ['en', 'fr'], timezoneIana: 'America/Los_Angeles', shifts: SHIFT_DAY_ALL_WEEK, armedCertified: false },
  { providerSlug: 'praetorian-protective', homeAirportIcao: 'KTEB', fullName: 'Owen Bradley', phone: '+1 646 555 0341', languages: ['en'], timezoneIana: 'America/New_York', shifts: SHIFT_DAY, armedCertified: false },
];

export interface SeedHotel {
  readonly providerSlug: string;
  readonly airportIcao: string;
  readonly name: string;
  readonly starRating: number;
  readonly driveMinutesToFbo: number;
  readonly timezoneIana: string;
  readonly roomTypes: readonly {
    readonly code: string;
    readonly name: string;
    readonly maxOccupancy: number;
    readonly totalRooms: number;
  }[];
}

export const seedHotels: readonly SeedHotel[] = [
  {
    providerSlug: 'harborview-hospitality',
    airportIcao: 'KTEB',
    name: 'Harborview Riverbend, Hackensack',
    starRating: 5,
    driveMinutesToFbo: 12,
    timezoneIana: 'America/New_York',
    roomTypes: [
      { code: 'std', name: 'Deluxe king', maxOccupancy: 2, totalRooms: 18 },
      { code: 'jrs', name: 'Junior suite', maxOccupancy: 3, totalRooms: 8 },
      { code: 'ste', name: 'Executive suite', maxOccupancy: 4, totalRooms: 4 },
    ],
  },
  {
    providerSlug: 'harborview-hospitality',
    airportIcao: 'KEWR',
    name: 'Harborview Ironbound, Newark',
    starRating: 4,
    driveMinutesToFbo: 15,
    timezoneIana: 'America/New_York',
    roomTypes: [
      { code: 'std', name: 'Superior king', maxOccupancy: 2, totalRooms: 22 },
      { code: 'jrs', name: 'Junior suite', maxOccupancy: 3, totalRooms: 6 },
    ],
  },
  {
    providerSlug: 'coastal-suites-partners',
    airportIcao: 'KOPF',
    name: 'Coastal Suites Aventura',
    starRating: 5,
    driveMinutesToFbo: 18,
    timezoneIana: 'America/New_York',
    roomTypes: [
      { code: 'std', name: 'Ocean king', maxOccupancy: 2, totalRooms: 16 },
      { code: 'ste', name: 'Penthouse suite', maxOccupancy: 5, totalRooms: 3 },
    ],
  },
  {
    providerSlug: 'coastal-suites-partners',
    airportIcao: 'KPBI',
    name: 'Coastal Suites Palm Harbour',
    starRating: 4,
    driveMinutesToFbo: 10,
    timezoneIana: 'America/New_York',
    roomTypes: [
      { code: 'std', name: 'Harbour king', maxOccupancy: 2, totalRooms: 14 },
      { code: 'jrs', name: 'Junior suite', maxOccupancy: 3, totalRooms: 6 },
    ],
  },
];

export interface SeedCatering {
  readonly providerSlug: string;
  readonly airportIcao: string;
  readonly kitchenName: string;
  readonly leadTimeMinutes: number;
  readonly maxOrdersPerDay: number;
  readonly menuTags: readonly string[];
  readonly dietaryTags: readonly string[];
  readonly timezoneIana: string;
}

export const seedCatering: readonly SeedCatering[] = [
  { providerSlug: 'altitude-culinary', airportIcao: 'KTEB', kitchenName: 'Altitude Teterboro Kitchen', leadTimeMinutes: 240, maxOrdersPerDay: 8, menuTags: ['contemporary', 'seafood', 'steak'], dietaryTags: ['kosher', 'halal', 'vegan', 'gluten_free'], timezoneIana: 'America/New_York' },
  { providerSlug: 'altitude-culinary', airportIcao: 'KEWR', kitchenName: 'Altitude Newark Kitchen', leadTimeMinutes: 240, maxOrdersPerDay: 6, menuTags: ['contemporary', 'deli'], dietaryTags: ['kosher', 'vegan'], timezoneIana: 'America/New_York' },
  { providerSlug: 'altitude-culinary', airportIcao: 'KJFK', kitchenName: 'Altitude JFK Kitchen', leadTimeMinutes: 300, maxOrdersPerDay: 6, menuTags: ['contemporary'], dietaryTags: ['kosher', 'halal'], timezoneIana: 'America/New_York' },
  { providerSlug: 'blue-sky-provisions', airportIcao: 'KTEB', kitchenName: 'Blue Sky Bergen Kitchen', leadTimeMinutes: 720, maxOrdersPerDay: 4, menuTags: ['comfort', 'breakfast'], dietaryTags: ['vegan', 'gluten_free'], timezoneIana: 'America/New_York' },
  { providerSlug: 'blue-sky-provisions', airportIcao: 'KVNY', kitchenName: 'Blue Sky Valley Kitchen', leadTimeMinutes: 720, maxOrdersPerDay: 5, menuTags: ['californian', 'raw'], dietaryTags: ['vegan', 'gluten_free', 'halal'], timezoneIana: 'America/Los_Angeles' },
];

export interface SeedFuel {
  readonly providerSlug: string;
  readonly airportIcao: string;
  readonly truckReference: string;
  readonly fuelType: FuelType;
  readonly maxUpliftGallons: number;
  readonly concurrentUplifts: number;
  readonly supportsPrist: boolean;
  readonly timezoneIana: string;
}

export const seedFuel: readonly SeedFuel[] = [
  { providerSlug: 'northeast-into-plane', airportIcao: 'KTEB', truckReference: 'NE-JT-01', fuelType: 'jet_a', maxUpliftGallons: 5000, concurrentUplifts: 1, supportsPrist: true, timezoneIana: 'America/New_York' },
  { providerSlug: 'northeast-into-plane', airportIcao: 'KTEB', truckReference: 'NE-JT-02', fuelType: 'jet_a', maxUpliftGallons: 5000, concurrentUplifts: 1, supportsPrist: true, timezoneIana: 'America/New_York' },
  { providerSlug: 'northeast-into-plane', airportIcao: 'KTEB', truckReference: 'NE-SAF-01', fuelType: 'saf_blend', maxUpliftGallons: 3000, concurrentUplifts: 1, supportsPrist: false, timezoneIana: 'America/New_York' },
  { providerSlug: 'northeast-into-plane', airportIcao: 'KEWR', truckReference: 'NE-JT-11', fuelType: 'jet_a', maxUpliftGallons: 6000, concurrentUplifts: 1, supportsPrist: true, timezoneIana: 'America/New_York' },
  { providerSlug: 'northeast-into-plane', airportIcao: 'KJFK', truckReference: 'NE-JT-21', fuelType: 'jet_a', maxUpliftGallons: 6000, concurrentUplifts: 1, supportsPrist: true, timezoneIana: 'America/New_York' },
  { providerSlug: 'skyline-fuel-partners', airportIcao: 'KOPF', truckReference: 'SK-JT-01', fuelType: 'jet_a', maxUpliftGallons: 4500, concurrentUplifts: 1, supportsPrist: true, timezoneIana: 'America/New_York' },
  { providerSlug: 'skyline-fuel-partners', airportIcao: 'KPBI', truckReference: 'SK-JT-11', fuelType: 'jet_a', maxUpliftGallons: 4500, concurrentUplifts: 1, supportsPrist: false, timezoneIana: 'America/New_York' },
  { providerSlug: 'skyline-fuel-partners', airportIcao: 'KVNY', truckReference: 'SK-JT-21', fuelType: 'jet_a', maxUpliftGallons: 4000, concurrentUplifts: 1, supportsPrist: true, timezoneIana: 'America/Los_Angeles' },
];

export interface SeedHangar {
  readonly providerSlug: string;
  readonly airportIcao: string;
  readonly name: string;
  readonly doorWidthFt: string;
  readonly doorHeightFt: string;
  readonly floorLengthFt: string;
  readonly floorWidthFt: string;
  readonly maxAircraftWeightLbs: number;
  readonly heated: boolean;
  readonly timezoneIana: string;
}

export const seedHangars: readonly SeedHangar[] = [
  // Wide bay: takes a G650ER (99.58 ft span, 25.67 ft tail).
  { providerSlug: 'gateway-hangar-partners', airportIcao: 'KTEB', name: 'Gateway Bay A', doorWidthFt: '135.00', doorHeightFt: '30.00', floorLengthFt: '140.00', floorWidthFt: '150.00', maxAircraftWeightLbs: 120000, heated: true, timezoneIana: 'America/New_York' },
  // Narrow bay: 72 ft door cannot take a G650ER or a Global 7500 — the hangar-fit
  // rule must reject it, which is exactly what makes this row worth seeding.
  { providerSlug: 'gateway-hangar-partners', airportIcao: 'KTEB', name: 'Gateway Bay B', doorWidthFt: '72.00', doorHeightFt: '22.00', floorLengthFt: '80.00', floorWidthFt: '85.00', maxAircraftWeightLbs: 45000, heated: true, timezoneIana: 'America/New_York' },
  { providerSlug: 'gateway-hangar-partners', airportIcao: 'KEWR', name: 'Gateway Newark Bay 1', doorWidthFt: '110.00', doorHeightFt: '28.00', floorLengthFt: '120.00', floorWidthFt: '120.00', maxAircraftWeightLbs: 90000, heated: true, timezoneIana: 'America/New_York' },
  { providerSlug: 'palm-coast-hangar', airportIcao: 'KPBI', name: 'Palm Coast Bay 1', doorWidthFt: '125.00', doorHeightFt: '29.00', floorLengthFt: '130.00', floorWidthFt: '135.00', maxAircraftWeightLbs: 110000, heated: false, timezoneIana: 'America/New_York' },
  { providerSlug: 'palm-coast-hangar', airportIcao: 'KPBI', name: 'Palm Coast Bay 2', doorWidthFt: '90.00', doorHeightFt: '26.00', floorLengthFt: '95.00', floorWidthFt: '100.00', maxAircraftWeightLbs: 75000, heated: false, timezoneIana: 'America/New_York' },
  { providerSlug: 'palm-coast-hangar', airportIcao: 'KOPF', name: 'Palm Coast Opa-locka Bay', doorWidthFt: '105.00', doorHeightFt: '27.00', floorLengthFt: '115.00', floorWidthFt: '115.00', maxAircraftWeightLbs: 85000, heated: false, timezoneIana: 'America/New_York' },
];

/**
 * Provider blackout windows.
 *
 * The docstring at the top of this file has always claimed the network contains "a
 * provider with a blackout window". It did not: `provider_blackouts` seeded empty while
 * `eligibility.ts` carried a fully implemented `blackout_window` rejection, so the only
 * thing exercising that branch was its unit test.
 *
 * Unlike desk hours, which are weekday-based and therefore timeless, a blackout is an
 * absolute interval. These are anchored to the seed run rather than to a fixed calendar
 * date, so they stay meaningful however long after the build the seed is loaded.
 *
 * They open three weeks out on purpose. The scenario requests (`npm run db:scenarios`)
 * and the integration suites work within the next few days, and a blackout that silently
 * changed which provider won those would be a seed quietly rewriting test expectations.
 * Far enough out to be inert, real enough to render in the provider and admin portals and
 * to reject a genuine request aimed at that window.
 */
export interface SeedBlackout {
  readonly providerSlug: string;
  /**
   * Narrows the blackout to one coverage row. Both must be given together; omitting them
   * makes it company-wide, which is the `coverage_id is null` case in the schema.
   */
  readonly serviceCode?: string;
  readonly airportIcao?: string;
  /** Whole days after the seed date on which the window opens, at 00:00 UTC. */
  readonly startsInDays: number;
  readonly durationHours: number;
  readonly reason: string;
}

export const seedBlackouts: readonly SeedBlackout[] = [
  // Coverage-scoped: Gotham keeps its other coverage, loses Teterboro ground transport
  // for two days. KTEB ground transport is the one place three approved companies
  // overlap, so this is where losing one candidate actually changes the ranking.
  {
    providerSlug: 'gotham-livery-partners',
    serviceCode: 'ground_transport',
    airportIcao: 'KTEB',
    startsInDays: 21,
    durationHours: 48,
    reason: 'Fleet recertification — Teterboro ground transport unavailable.',
  },
  // Company-wide: no coverage row, so every service and every airport this company
  // covers is blacked out. Exercises the `coverage_id is null` branch.
  {
    providerSlug: 'praetorian-protective',
    startsInDays: 24,
    durationHours: 24,
    reason: 'Annual firearms requalification — all details stood down.',
  },
];
