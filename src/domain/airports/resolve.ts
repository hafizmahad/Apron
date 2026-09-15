import '@/lib/server-guard';
import { and, eq, or, sql } from 'drizzle-orm';
import { getDb, type Executor } from '@/db/client';
import { airports, fbos, type Airport, type Fbo } from '@/db/schema';

/**
 * Deterministic airport and FBO resolution (CLAUDE.md §8 step 2, §2).
 *
 * The model produces a token; this module turns it into a real row, or reports honestly
 * that it cannot. It NEVER guesses:
 *
 *  - an exact ICAO or IATA match wins outright;
 *  - an exact name or city match wins next;
 *  - a fuzzy match produces CANDIDATES for the user to choose between, never a selection.
 *
 * "Newark" resolving to two airports is the canonical case (Journey D). The correct
 * behaviour is to return both and let a person decide — not to rank them and pick one.
 */

export type AirportResolution =
  | { readonly kind: 'resolved'; readonly airport: Airport; readonly matchedOn: MatchKind }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly AirportCandidate[] }
  | { readonly kind: 'unresolved'; readonly token: string };

export type MatchKind = 'icao' | 'iata' | 'exact_name' | 'exact_city' | 'fuzzy';

export interface AirportCandidate {
  readonly airport: Airport;
  readonly matchedOn: MatchKind;
  /** 0–100. Presentation ordering only — it never decides anything. */
  readonly score: number;
}

/** How close a fuzzy match must be before it is worth showing at all. */
const FUZZY_THRESHOLD = 0.3;
const MAX_CANDIDATES = 8;

export async function resolveAirportToken(
  rawToken: string,
  executor: Executor = getDb(),
): Promise<AirportResolution> {
  const token = rawToken.trim();
  if (token.length === 0) return { kind: 'unresolved', token: rawToken };

  const upper = token.toUpperCase();

  // --- exact identifier match -------------------------------------------
  // An ICAO or IATA code is unambiguous by construction, so a hit here is final.
  if (/^[A-Z0-9]{4}$/.test(upper) || /^[A-Z]{3}$/.test(upper)) {
    const rows = await executor
      .select()
      .from(airports)
      .where(and(eq(airports.active, true), or(eq(airports.icao, upper), eq(airports.iata, upper))))
      .limit(2);

    const exact = rows[0];
    if (exact !== undefined && rows.length === 1) {
      return {
        kind: 'resolved',
        airport: exact,
        matchedOn: exact.icao === upper ? 'icao' : 'iata',
      };
    }
    if (rows.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: rows.map((airport) => ({ airport, matchedOn: 'icao' as const, score: 100 })),
      };
    }
  }

  // --- exact name or city match -----------------------------------------
  const exactRows = await executor
    .select()
    .from(airports)
    .where(
      and(
        eq(airports.active, true),
        or(
          sql`lower(${airports.name}) = lower(${token})`,
          sql`lower(${airports.city}) = lower(${token})`,
        ),
      ),
    )
    .limit(MAX_CANDIDATES);

  if (exactRows.length === 1) {
    const airport = exactRows[0]!;
    return {
      kind: 'resolved',
      airport,
      matchedOn: airport.name.toLowerCase() === token.toLowerCase() ? 'exact_name' : 'exact_city',
    };
  }

  if (exactRows.length > 1) {
    // "Newark" matching both Newark Liberty and another Newark field: the user chooses.
    return {
      kind: 'ambiguous',
      candidates: exactRows.map((airport) => ({
        airport,
        matchedOn: airport.name.toLowerCase() === token.toLowerCase() ? 'exact_name' : 'exact_city',
        score: 95,
      })),
    };
  }

  // --- trigram similarity -----------------------------------------------
  // Catches "Teterboro Airport" against "Teterboro", and ordinary typos. Postgres
  // `similarity()` from pg_trgm, which the schema indexes for exactly this.
  const fuzzyRows = await executor.execute<{
    id: string;
    similarity: number;
  }>(sql`
    select id,
           greatest(
             similarity(name, ${token}),
             similarity(city, ${token})
           ) as similarity
    from airports
    where active = true
      and (name % ${token} or city % ${token})
    order by similarity desc, name asc, id asc
    limit ${MAX_CANDIDATES}
  `);

  const scored = fuzzyRows.rows.filter((row) => Number(row.similarity) >= FUZZY_THRESHOLD);
  if (scored.length === 0) {
    return { kind: 'unresolved', token };
  }

  const ids = scored.map((row) => row.id);
  const matched = await executor
    .select()
    .from(airports)
    .where(sql`${airports.id} = any(${sql.raw(`array[${ids.map((id) => `'${id}'::uuid`).join(',')}]`)})`);

  const byId = new Map(matched.map((airport) => [airport.id, airport]));
  const candidates: AirportCandidate[] = [];
  for (const row of scored) {
    const airport = byId.get(row.id);
    if (airport === undefined) continue;
    candidates.push({
      airport,
      matchedOn: 'fuzzy',
      score: Math.round(Number(row.similarity) * 100),
    });
  }

  if (candidates.length === 0) return { kind: 'unresolved', token };

  // A single strong fuzzy match is still only a suggestion unless it is decisive.
  const best = candidates[0]!;
  const runnerUp = candidates[1];
  const decisive = best.score >= 85 && (runnerUp === undefined || best.score - runnerUp.score >= 25);

  if (decisive) {
    return { kind: 'resolved', airport: best.airport, matchedOn: 'fuzzy' };
  }

  return { kind: 'ambiguous', candidates };
}

export type FboResolution =
  | { readonly kind: 'resolved'; readonly fbo: Fbo }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly Fbo[] }
  | { readonly kind: 'unresolved'; readonly token: string };

/**
 * Resolves an FBO token WITHIN a known airport.
 *
 * Scoping to the airport is not an optimisation — it is the correctness rule. "Signature"
 * exists at most large fields; resolving it globally would be meaningless.
 */
export async function resolveFboToken(
  airportId: string,
  rawToken: string,
  executor: Executor = getDb(),
): Promise<FboResolution> {
  const token = rawToken.trim();
  if (token.length === 0) return { kind: 'unresolved', token: rawToken };

  const atAirport = await executor
    .select()
    .from(fbos)
    .where(and(eq(fbos.airportId, airportId), eq(fbos.active, true)))
    .orderBy(fbos.name);

  if (atAirport.length === 0) return { kind: 'unresolved', token };

  const lower = token.toLowerCase();

  const exact = atAirport.filter((fbo) => fbo.name.toLowerCase() === lower);
  if (exact.length === 1) return { kind: 'resolved', fbo: exact[0]! };

  // Substring either way, so "Signature" finds "Signature Flight Support TEB" and
  // "Signature Flight Support TEB" finds "Signature".
  const partial = atAirport.filter(
    (fbo) => fbo.name.toLowerCase().includes(lower) || lower.includes(fbo.name.toLowerCase()),
  );

  if (partial.length === 1) return { kind: 'resolved', fbo: partial[0]! };
  if (partial.length > 1) return { kind: 'ambiguous', candidates: partial };

  return { kind: 'unresolved', token };
}

/** Every active FBO at an airport, for the read-back picker. */
export async function listFbosForAirport(
  airportId: string,
  executor: Executor = getDb(),
): Promise<Fbo[]> {
  return executor
    .select()
    .from(fbos)
    .where(and(eq(fbos.airportId, airportId), eq(fbos.active, true)))
    .orderBy(fbos.name, fbos.id);
}

export async function getAirportById(
  airportId: string,
  executor: Executor = getDb(),
): Promise<Airport | null> {
  const rows = await executor.select().from(airports).where(eq(airports.id, airportId)).limit(1);
  return rows[0] ?? null;
}

/** A human label for a resolved airport: `Teterboro Airport (KTEB)`. */
export function describeAirport(airport: Airport): string {
  const identifier = airport.icao ?? airport.iata;
  return identifier === null ? airport.name : `${airport.name} (${identifier})`;
}
