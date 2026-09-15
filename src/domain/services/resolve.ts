import '@/lib/server-guard';
import { asc, eq } from 'drizzle-orm';
import { getDb, type Executor } from '@/db/client';
import { serviceCategories, type ServiceCategory } from '@/db/schema';

/**
 * Deterministic service resolution (CLAUDE.md §8 step 2, ADR-008).
 *
 * The model may suggest a `serviceCode`; this module checks it against the LIVE catalogue
 * and ignores it if it does not name an active category. A code the model invented, or one
 * an admin has since disabled, resolves to nothing rather than to a guess.
 *
 * The synonym table is deliberately code, not configuration: it is the vocabulary the
 * deterministic fallback needs when AI is switched off entirely (Journey E), so it must
 * work with no model and no network.
 */

export type ServiceResolution =
  | { readonly kind: 'resolved'; readonly category: ServiceCategory; readonly matchedOn: 'code' | 'name' | 'synonym' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly ServiceCategory[] }
  | { readonly kind: 'unresolved'; readonly token: string };

/**
 * Words operators and clients actually use, mapped to the seeded codes.
 *
 * A category an admin adds later has no entry here and is matched by its code or name,
 * which is the correct behaviour — the platform must not pretend to know informal names
 * for a service it has only just learned about.
 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ground_transport: [
    'car', 'cars', 'vehicle', 'vehicles', 'suv', 'suvs', 'sedan', 'sedans', 'van', 'vans',
    'sprinter', 'limo', 'limousine', 'transport', 'transfer', 'transfers', 'chauffeur',
    'driver', 'drivers', 'pickup', 'pick up', 'ground', 'ground transportation', 'ride',
  ],
  close_protection: [
    'bodyguard', 'bodyguards', 'security', 'security detail', 'close protection', 'cp',
    'cp team', 'protection', 'protective', 'guard', 'guards', 'officer', 'officers',
    'executive protection',
  ],
  hotel: ['hotel', 'hotels', 'room', 'rooms', 'accommodation', 'lodging', 'overnight stay', 'suite', 'suites'],
  catering: [
    'catering', 'cater', 'food', 'meal', 'meals', 'breakfast', 'lunch', 'dinner', 'snacks',
    'canapes', 'refreshments', 'galley',
  ],
  fuel: ['fuel', 'fuelling', 'fueling', 'refuel', 'jet a', 'jeta', 'jet-a', 'uplift', 'gas', 'saf', 'top off', 'top-off'],
  hangar: ['hangar', 'hanger', 'covered parking', 'inside parking', 'overnight hangar', 'undercover'],
});

export async function listActiveServiceCategories(
  executor: Executor = getDb(),
): Promise<ServiceCategory[]> {
  return executor
    .select()
    .from(serviceCategories)
    .where(eq(serviceCategories.active, true))
    .orderBy(asc(serviceCategories.sortOrder), asc(serviceCategories.name), asc(serviceCategories.id));
}

/**
 * Resolves a service token against the live catalogue.
 *
 * `suggestedCode` is the model's hint. It is honoured only if it names an active
 * category — otherwise the token itself is matched, exactly as it would be with AI off.
 */
export async function resolveServiceToken(
  token: string,
  suggestedCode: string | null,
  executor: Executor = getDb(),
): Promise<ServiceResolution> {
  const categories = await listActiveServiceCategories(executor);
  return resolveServiceTokenAgainst(categories, token, suggestedCode);
}

/**
 * The pure form, so intake can resolve many tokens against one catalogue read and so the
 * eval suite can drive it with a fixed catalogue.
 */
export function resolveServiceTokenAgainst(
  categories: readonly ServiceCategory[],
  rawToken: string,
  suggestedCode: string | null,
): ServiceResolution {
  const token = rawToken.trim().toLowerCase();

  // 1. The model's suggestion, but only if it is real and active.
  if (suggestedCode !== null) {
    const suggested = categories.find((category) => category.code === suggestedCode);
    if (suggested !== undefined) {
      return { kind: 'resolved', category: suggested, matchedOn: 'code' };
    }
  }

  if (token.length === 0) return { kind: 'unresolved', token: rawToken };

  // 2. The token is itself a code.
  const byCode = categories.find((category) => category.code === token);
  if (byCode !== undefined) return { kind: 'resolved', category: byCode, matchedOn: 'code' };

  // 3. The token is the display name.
  const byName = categories.filter((category) => category.name.toLowerCase() === token);
  if (byName.length === 1) return { kind: 'resolved', category: byName[0]!, matchedOn: 'name' };

  // 4. A known synonym.
  const synonymMatches = categories.filter((category) => {
    const synonyms = SYNONYMS[category.code];
    return synonyms !== undefined && synonyms.includes(token);
  });
  if (synonymMatches.length === 1) {
    return { kind: 'resolved', category: synonymMatches[0]!, matchedOn: 'synonym' };
  }
  if (synonymMatches.length > 1) {
    return { kind: 'ambiguous', candidates: synonymMatches };
  }

  // 5. Word-level containment, so "two black cars" and "armed security detail" resolve.
  const words = token.split(/[^a-z]+/).filter((word) => word.length > 1);
  const contained = categories.filter((category) => {
    const synonyms = SYNONYMS[category.code] ?? [];
    return (
      synonyms.some((synonym) => token.includes(synonym)) ||
      words.some((word) => synonyms.includes(word)) ||
      category.name.toLowerCase().split(/\s+/).some((part) => words.includes(part))
    );
  });

  if (contained.length === 1) return { kind: 'resolved', category: contained[0]!, matchedOn: 'synonym' };
  if (contained.length > 1) return { kind: 'ambiguous', candidates: contained };

  return { kind: 'unresolved', token: rawToken };
}

export async function getServiceCategoryById(
  id: string,
  executor: Executor = getDb(),
): Promise<ServiceCategory | null> {
  const rows = await executor
    .select()
    .from(serviceCategories)
    .where(eq(serviceCategories.id, id))
    .limit(1);
  return rows[0] ?? null;
}
