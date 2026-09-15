import type { UserRole } from '@/db/schema';

/**
 * Client organisations and the seeded user accounts.
 *
 * All fictional (CLAUDE.md §16). Every role in the RBAC matrix gets at least one account
 * so the permission tests and manual verification have real subjects to act as, and so
 * cross-tenant isolation can actually be attempted: two provider companies each have
 * their own dispatcher, which is what Journey G exercises.
 *
 * The shared development password is defined once in `src/db/seed/index.ts` and is only
 * ever used when `APP_ENV` is `local` or `ci`; seeding a non-local environment with these
 * accounts is refused outright.
 */

export interface SeedClientOrganization {
  readonly slug: string;
  readonly name: string;
  readonly primaryContactName: string;
  readonly primaryContactEmail: string;
  readonly primaryContactPhone: string;
  readonly notes: string;
}

export const seedClientOrganizations: readonly SeedClientOrganization[] = [
  {
    slug: 'meridian-capital-partners',
    name: 'Meridian Capital Partners',
    primaryContactName: 'Eleanor Whitmore',
    primaryContactEmail: 'aviation@meridiancapital.example',
    primaryContactPhone: '+1 212 555 0401',
    notes: 'Two aircraft on the registry. Frequent Teterboro arrivals.',
  },
  {
    slug: 'coastline-ventures',
    name: 'Coastline Ventures',
    primaryContactName: 'Rafael Ibarra',
    primaryContactEmail: 'flightops@coastlineventures.example',
    primaryContactPhone: '+1 305 555 0412',
    notes: 'Miami and Palm Beach based. Global 7500 and PC-24.',
  },
  {
    slug: 'aurora-health-group',
    name: 'Aurora Health Group',
    primaryContactName: 'Dr. Naomi Adeyemi',
    primaryContactEmail: 'travel@aurorahealthgroup.example',
    primaryContactPhone: '+1 646 555 0423',
    notes: 'Medical leadership travel. Citation Latitude.',
  },
  {
    slug: 'pinegrove-family-office',
    name: 'Pinegrove Family Office',
    primaryContactName: 'Charles Petersen',
    primaryContactEmail: 'concierge@pinegroveoffice.example',
    primaryContactPhone: '+1 561 555 0434',
    notes: 'Falcon 7X. Requests close protection on most trips.',
  },
];

export interface SeedUser {
  readonly email: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly phone: string;
  /** Slug of the owning provider company, for provider roles. */
  readonly providerSlug?: string;
  /** Slug of the owning client organisation, for the client role. */
  readonly clientSlug?: string;
}

export const seedUsers: readonly SeedUser[] = [
  // --- platform ---
  {
    email: 'admin@apron.local',
    fullName: 'Sofia Lindqvist',
    role: 'platform_admin',
    phone: '+1 646 555 0501',
  },

  // --- operations ---
  {
    email: 'ops.manager@apron.local',
    fullName: 'James Adeyemi',
    role: 'operations_manager',
    phone: '+1 646 555 0511',
  },
  {
    email: 'ops.agent@apron.local',
    fullName: 'Chloe Fontaine',
    role: 'operations_agent',
    phone: '+1 646 555 0512',
  },
  {
    email: 'ops.night@apron.local',
    fullName: 'Hassan Qureshi',
    role: 'operations_agent',
    phone: '+1 646 555 0513',
  },

  // --- providers: two ground-transport companies, so tenant isolation is testable ---
  {
    email: 'admin@hudsonexec.example',
    fullName: 'Gregory Mullen',
    role: 'provider_admin',
    phone: '+1 201 555 0521',
    providerSlug: 'hudson-executive-transport',
  },
  {
    email: 'dispatch@hudsonexec.example',
    fullName: 'Tanya Brooks',
    role: 'provider_dispatcher',
    phone: '+1 201 555 0522',
    providerSlug: 'hudson-executive-transport',
  },
  {
    email: 'staff@hudsonexec.example',
    fullName: 'Leo Fitzgerald',
    role: 'provider_staff',
    phone: '+1 201 555 0523',
    providerSlug: 'hudson-executive-transport',
  },
  {
    email: 'dispatch@palisadechauffeur.example',
    fullName: 'Marta Sienkiewicz',
    role: 'provider_dispatcher',
    phone: '+1 201 555 0531',
    providerSlug: 'palisade-chauffeur-group',
  },
  {
    email: 'dispatch@gothamlivery.example',
    fullName: 'Errol Bassett',
    role: 'provider_dispatcher',
    phone: '+1 212 555 0541',
    providerSlug: 'gotham-livery-partners',
  },
  {
    email: 'ops@sentinelrisk.example',
    fullName: 'Nadine Clarke',
    role: 'provider_dispatcher',
    phone: '+1 646 555 0551',
    providerSlug: 'sentinel-risk-group',
  },
  {
    email: 'reservations@harborviewhospitality.example',
    fullName: 'Peter Nowak',
    role: 'provider_dispatcher',
    phone: '+1 201 555 0561',
    providerSlug: 'harborview-hospitality',
  },
  {
    email: 'orders@altitudeculinary.example',
    fullName: 'Amelie Rousseau',
    role: 'provider_dispatcher',
    phone: '+1 201 555 0571',
    providerSlug: 'altitude-culinary',
  },
  {
    email: 'fuel@northeastintoplane.example',
    fullName: 'Dennis Kowal',
    role: 'provider_dispatcher',
    phone: '+1 201 555 0581',
    providerSlug: 'northeast-into-plane',
  },
  {
    email: 'ops@gatewayhangar.example',
    fullName: 'Rosa Marchetti',
    role: 'provider_dispatcher',
    phone: '+1 201 555 0591',
    providerSlug: 'gateway-hangar-partners',
  },
  {
    email: 'dispatch@pacificcoastchauffeur.example',
    fullName: 'Bryan Teague',
    role: 'provider_dispatcher',
    phone: '+1 818 555 0601',
    providerSlug: 'pacific-coast-chauffeur',
  },
  {
    email: 'dispatch@biscayneexec.example',
    fullName: 'Isabel Duarte',
    role: 'provider_dispatcher',
    phone: '+1 305 555 0611',
    providerSlug: 'biscayne-executive-motors',
  },
  // --- the second company for each service, so every service type can be tested from
  // --- two different accounts and cross-company isolation is exercisable everywhere ---
  {
    email: 'ops@praetorianprotective.example',
    fullName: 'Yvonne Castellanos',
    role: 'provider_dispatcher',
    phone: '+1 310 555 0631',
    providerSlug: 'praetorian-protective',
  },
  {
    email: 'bookings@coastalsuites.example',
    fullName: 'Martin Ojukwu',
    role: 'provider_dispatcher',
    phone: '+1 561 555 0641',
    providerSlug: 'coastal-suites-partners',
  },
  {
    email: 'kitchen@blueskyprovisions.example',
    fullName: 'Hana Sultana',
    role: 'provider_dispatcher',
    phone: '+1 818 555 0651',
    providerSlug: 'blue-sky-provisions',
  },
  {
    email: 'dispatch@skylinefuel.example',
    fullName: 'Paulo Ferreira',
    role: 'provider_dispatcher',
    phone: '+1 305 555 0661',
    providerSlug: 'skyline-fuel-partners',
  },
  {
    email: 'ops@palmcoasthangar.example',
    fullName: 'Denise Aubert',
    role: 'provider_dispatcher',
    phone: '+1 561 555 0671',
    providerSlug: 'palm-coast-hangar',
  },
  // A dispatcher at the SUSPENDED company. They can still sign in and see why they are
  // suspended — being cut off with no explanation would be the wrong behaviour — but the
  // matching engine rejects the company on status, so no offer can reach them.
  {
    email: 'dispatch@atlasexecutivecars.example',
    fullName: 'Vincent Moreau',
    role: 'provider_admin',
    phone: '+1 718 555 0681',
    providerSlug: 'atlas-executive-cars',
  },

  // A dispatcher at the company still awaiting approval: they can sign in and manage
  // their own profile, but must never receive an offer.
  {
    email: 'hello@meridiangroundservices.example',
    fullName: 'Oscar Benitez',
    role: 'provider_admin',
    phone: '+1 201 555 0621',
    providerSlug: 'meridian-ground-services',
  },

  // --- clients ---
  {
    email: 'aviation@meridiancapital.example',
    fullName: 'Eleanor Whitmore',
    role: 'client',
    phone: '+1 212 555 0401',
    clientSlug: 'meridian-capital-partners',
  },
  {
    email: 'flightops@coastlineventures.example',
    fullName: 'Rafael Ibarra',
    role: 'client',
    phone: '+1 305 555 0412',
    clientSlug: 'coastline-ventures',
  },
  {
    email: 'travel@aurorahealthgroup.example',
    fullName: 'Naomi Adeyemi',
    role: 'client',
    phone: '+1 646 555 0423',
    clientSlug: 'aurora-health-group',
  },
  {
    email: 'concierge@pinegroveoffice.example',
    fullName: 'Charles Petersen',
    role: 'client',
    phone: '+1 561 555 0434',
    clientSlug: 'pinegrove-family-office',
  },
];
