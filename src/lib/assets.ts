/**
 * The single typed registry of every Apron asset path (ADR-012, CLAUDE.md §21).
 *
 * Rules enforced by `tests/unit/assets/registry.test.ts`:
 *  - every path below exists in `public/assets/apron/`;
 *  - no file outside this module contains the literal string `/assets/apron/`;
 *  - `10_misc/ui-reference.png` and `10_misc/asset-pack-preview.png` are absent —
 *    they are implementation references, never product content;
 *  - every service category seeded by the platform has an icon and an image entry.
 *
 * Generic interface icons (search, filter, bell, chevrons, …) come from `lucide-react`
 * and are deliberately not listed here.
 */

const ROOT = '/assets/apron';

export const brandAssets = {
  /**
   * Apron-authored variant of the pack mark: identical geometry, but the feather is
   * painted in `currentColor` so the glyph themes against whatever surface it sits on.
   * The supplied `apron-mark.svg` hard-codes navy feathers and all but disappears on the
   * navy sidebar and the navy app icon.
   */
  markAdaptive: `${ROOT}/01_brand/apron-mark-adaptive.svg`,
  /** Original pack mark, fixed navy feather. Correct on light surfaces. */
  mark: `${ROOT}/01_brand/apron-mark.svg`,
  /**
   * Wordmark lockups on an opaque plate. Favicons, social cards and email headers only —
   * never inline in the app shell, which composes the mark with live type instead so the
   * wordmark uses the product's display face rather than a Georgia fallback.
   */
  logoOnNavy: `${ROOT}/01_brand/apron-logo-dark.svg`,
  logoOnWhite: `${ROOT}/01_brand/apron-logo-light.svg`,
  appIcon: `${ROOT}/01_brand/app-icon.svg`,
} as const;

/**
 * Service-category icons, keyed by `service_categories.code`. Looked up dynamically
 * because the catalogue is data, not an enum (ADR-008) — an admin-created category with
 * no icon of its own falls back to `resource`.
 */
export const serviceIcons = {
  ground_transport: `${ROOT}/02_service_icons/ground-transport.svg`,
  close_protection: `${ROOT}/02_service_icons/close-protection.svg`,
  hotel: `${ROOT}/02_service_icons/hotel.svg`,
  catering: `${ROOT}/02_service_icons/catering.svg`,
  fuel: `${ROOT}/02_service_icons/fuel.svg`,
  hangar: `${ROOT}/02_service_icons/hangar.svg`,
} as const;

export const serviceImages = {
  ground_transport: `${ROOT}/06_service_images/ground-transport.webp`,
  close_protection: `${ROOT}/06_service_images/close-protection.webp`,
  hotel: `${ROOT}/06_service_images/hotel.webp`,
  catering: `${ROOT}/06_service_images/catering.webp`,
  fuel: `${ROOT}/06_service_images/fuel.webp`,
  hangar: `${ROOT}/06_service_images/hangar.webp`,
} as const;

export const aviationIcons = {
  aircraftTail: `${ROOT}/03_aviation_icons/aircraft-tail.svg`,
  airport: `${ROOT}/03_aviation_icons/airport.svg`,
  arrival: `${ROOT}/03_aviation_icons/arrival.svg`,
  crew: `${ROOT}/03_aviation_icons/crew.svg`,
  departure: `${ROOT}/03_aviation_icons/departure.svg`,
  fbo: `${ROOT}/03_aviation_icons/fbo.svg`,
  luggage: `${ROOT}/03_aviation_icons/luggage.svg`,
  passengers: `${ROOT}/03_aviation_icons/passengers.svg`,
  privateJet: `${ROOT}/03_aviation_icons/private-jet.svg`,
  runway: `${ROOT}/03_aviation_icons/runway.svg`,
} as const;

export const domainIcons = {
  aiResearch: `${ROOT}/04_ui_domain_icons/ai-research.svg`,
  assignment: `${ROOT}/04_ui_domain_icons/assignment.svg`,
  audit: `${ROOT}/04_ui_domain_icons/audit.svg`,
  coverage: `${ROOT}/04_ui_domain_icons/coverage.svg`,
  decisionTrace: `${ROOT}/04_ui_domain_icons/decision-trace.svg`,
  operations: `${ROOT}/04_ui_domain_icons/operations.svg`,
  override: `${ROOT}/04_ui_domain_icons/override.svg`,
  providerCompany: `${ROOT}/04_ui_domain_icons/provider-company.svg`,
  resource: `${ROOT}/04_ui_domain_icons/resource.svg`,
  slaClock: `${ROOT}/04_ui_domain_icons/sla-clock.svg`,
} as const;

export const backgroundAssets = {
  clientHero: `${ROOT}/05_backgrounds/client-hero.webp`,
  login: `${ROOT}/05_backgrounds/login-auth.webp`,
  opsSidebar: `${ROOT}/05_backgrounds/ops-sidebar.webp`,
  providerSidebar: `${ROOT}/05_backgrounds/provider-sidebar.webp`,
  adminSidebar: `${ROOT}/05_backgrounds/admin-sidebar.webp`,
  patternLight: `${ROOT}/05_backgrounds/pattern-light.svg`,
  patternDark: `${ROOT}/05_backgrounds/pattern-dark.svg`,
} as const;

/**
 * Deliberately generic. `CLAUDE.md` §21 and the pack README forbid presenting any of
 * these as a photograph of a named airport or FBO. `LocationImage` renders them only
 * with an explicit "generic illustration" caption.
 */
export const locationPlaceholders = {
  apronDay: `${ROOT}/07_location_placeholders/generic-apron-day.webp`,
  fboTerminal: `${ROOT}/07_location_placeholders/generic-fbo-terminal.webp`,
  hangarExterior: `${ROOT}/07_location_placeholders/generic-hangar-exterior.webp`,
  runwayEvening: `${ROOT}/07_location_placeholders/generic-runway-evening.webp`,
} as const;

/** Fallbacks only, until a real logo arrives through the provider media workflow. */
export const providerPlaceholders = {
  building: `${ROOT}/08_provider_placeholders/provider-placeholder-building.svg`,
  shield: `${ROOT}/08_provider_placeholders/provider-placeholder-shield.svg`,
  wing: `${ROOT}/08_provider_placeholders/provider-placeholder-wing.svg`,
} as const;

export const illustrations = {
  empty: `${ROOT}/09_illustrations/empty-state.svg`,
  noData: `${ROOT}/09_illustrations/no-data.svg`,
  success: `${ROOT}/09_illustrations/success.svg`,
  error: `${ROOT}/09_illustrations/error.svg`,
  secure: `${ROOT}/09_illustrations/secure.svg`,
  globalNetwork: `${ROOT}/09_illustrations/global-network.svg`,
} as const;

export const miscAssets = {
  worldMap: `${ROOT}/10_misc/world-map-abstract.svg`,
  aircraftSilhouette: `${ROOT}/10_misc/aircraft-silhouette.svg`,
  avatarNavy: `${ROOT}/10_misc/avatar-initials-navy.svg`,
  avatarBlue: `${ROOT}/10_misc/avatar-initials-blue.svg`,
  avatarGold: `${ROOT}/10_misc/avatar-initials-gold.svg`,
} as const;

export type ServiceIconKey = keyof typeof serviceIcons;
export type AviationIconKey = keyof typeof aviationIcons;
export type DomainIconKey = keyof typeof domainIcons;
export type IllustrationKey = keyof typeof illustrations;
export type LocationPlaceholderKey = keyof typeof locationPlaceholders;
export type ProviderPlaceholderKey = keyof typeof providerPlaceholders;

/** Every registered path, used by the registry integrity test. */
export const allRegisteredAssetPaths: readonly string[] = Object.freeze([
  ...Object.values(brandAssets),
  ...Object.values(serviceIcons),
  ...Object.values(serviceImages),
  ...Object.values(aviationIcons),
  ...Object.values(domainIcons),
  ...Object.values(backgroundAssets),
  ...Object.values(locationPlaceholders),
  ...Object.values(providerPlaceholders),
  ...Object.values(illustrations),
  ...Object.values(miscAssets),
]);

/** Paths that must never be rendered as product content (pack README). */
export const forbiddenAssetPaths: readonly string[] = Object.freeze([
  `${ROOT}/10_misc/ui-reference.png`,
  `${ROOT}/10_misc/asset-pack-preview.png`,
  `${ROOT}/10_misc/actual-pack-preview.png`,
]);

function hasKey<T extends object>(record: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Icon for a service category code. Unknown codes — an admin adding "de-icing" without
 * uploading artwork — resolve to the neutral resource glyph rather than breaking.
 */
export function serviceIconFor(code: string): string {
  return hasKey(serviceIcons, code) ? serviceIcons[code] : domainIcons.resource;
}

/** Card image for a service category code, or `null` when the category has none. */
export function serviceImageFor(code: string): string | null {
  return hasKey(serviceImages, code) ? serviceImages[code] : null;
}

/** Stable placeholder choice for a provider, derived from its id — never random. */
export function providerPlaceholderFor(providerId: string): string {
  const keys = Object.keys(providerPlaceholders) as ProviderPlaceholderKey[];
  let hash = 0;
  for (let index = 0; index < providerId.length; index += 1) {
    hash = (hash * 31 + providerId.charCodeAt(index)) >>> 0;
  }
  const key = keys[hash % keys.length];
  return key === undefined ? providerPlaceholders.building : providerPlaceholders[key];
}

/** Stable avatar choice for a person, derived from their id — never random. */
export function avatarFor(subjectId: string): string {
  const options = [miscAssets.avatarNavy, miscAssets.avatarBlue, miscAssets.avatarGold] as const;
  let hash = 0;
  for (let index = 0; index < subjectId.length; index += 1) {
    hash = (hash * 33 + subjectId.charCodeAt(index)) >>> 0;
  }
  return options[hash % options.length] ?? miscAssets.avatarNavy;
}
