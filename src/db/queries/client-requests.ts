import '@/lib/server-guard';
import { sql } from 'drizzle-orm';
import { getDb, type Executor } from '@/db/client';
import type { RequestStatus } from '@/db/schema/enums';

/**
 * What a client may see about their own requests (CLAUDE.md §1).
 *
 * The client surface is deliberately narrow. A client sees **what they asked for and
 * whether it is arranged** — not provider ranking, not rejection reason codes, not the
 * decision trace, not which other companies were considered and refused. Those are
 * operational matters and exposing them would turn a status page into a commercial
 * disclosure about the platform's suppliers.
 *
 * Every function here takes `clientOrganizationId` FIRST and filters on it, the same
 * convention the provider queries use. Tenancy is a parameter, not an afterthought.
 */

export interface ClientRequestSummary {
  readonly id: string;
  readonly reference: string;
  readonly status: RequestStatus;
  readonly airportLabel: string;
  readonly airportTimezone: string;
  readonly fboName: string | null;
  readonly arrivalUtc: Date | null;
  readonly departureUtc: Date | null;
  readonly passengerCount: number;
  readonly crewCount: number;
  readonly createdAt: Date;
  readonly lineCount: number;
  readonly arrangedCount: number;
  readonly pendingCount: number;
  readonly problemCount: number;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function loadClientRequests(
  clientOrganizationId: string,
  options: { readonly limit?: number } = {},
  executor: Executor = getDb(),
): Promise<readonly ClientRequestSummary[]> {
  const result = await executor.execute<Record<string, unknown>>(sql`
    select
      r.id,
      r.reference,
      r.status,
      coalesce(a.icao, a.iata, a.name)  as airport_label,
      a.timezone_iana                   as airport_timezone,
      f.name                            as fbo_name,
      r.arrival_utc,
      r.departure_utc,
      r.passenger_count,
      r.crew_count,
      r.created_at,
      (select count(*)::int from request_service_lines l where l.request_id = r.id)
                                        as line_count,
      (select count(*)::int from request_service_lines l
        where l.request_id = r.id and l.status in ('assigned', 'in_progress', 'completed'))
                                        as arranged_count,
      (select count(*)::int from request_service_lines l
        where l.request_id = r.id
          and l.status in ('draft', 'matching', 'offered', 'waiting', 'acknowledged', 'rematching'))
                                        as pending_count,
      (select count(*)::int from request_service_lines l
        where l.request_id = r.id and l.status = 'failed')
                                        as problem_count
    from requests r
    join airports a on a.id = r.airport_id
    left join fbos f on f.id = r.fbo_id
    where r.client_organization_id = ${clientOrganizationId}::uuid
    order by coalesce(r.arrival_utc, r.created_at) desc, r.id desc
    limit ${options.limit ?? 100}
  `);

  return result.rows.map((row) => ({
    id: String(row['id']),
    reference: String(row['reference']),
    status: row['status'] as RequestStatus,
    airportLabel: String(row['airport_label']),
    airportTimezone: String(row['airport_timezone']),
    fboName: row['fbo_name'] === null ? null : String(row['fbo_name']),
    arrivalUtc: toDate(row['arrival_utc']),
    departureUtc: toDate(row['departure_utc']),
    passengerCount: Number(row['passenger_count']),
    crewCount: Number(row['crew_count']),
    createdAt: toDate(row['created_at']) ?? new Date(0),
    lineCount: Number(row['line_count']),
    arrangedCount: Number(row['arranged_count']),
    pendingCount: Number(row['pending_count']),
    problemCount: Number(row['problem_count']),
  }));
}

export interface ClientRequestLine {
  readonly id: string;
  readonly serviceName: string;
  readonly serviceCode: string;
  readonly unitLabel: string;
  readonly quantity: number;
  readonly status: string;
  readonly serviceStartUtc: Date | null;
  readonly serviceEndUtc: Date | null;
  /**
   * The supplier's name, and ONLY once they have accepted.
   *
   * Before acceptance the client is told a supplier is being found, not who is being
   * asked. Naming a company that then declines invites the client to chase a supplier who
   * has no job, and it exposes the platform's sourcing order for no benefit to them.
   */
  readonly providerName: string | null;
}

export interface ClientRequestDetail extends ClientRequestSummary {
  readonly sourceSentence: string;
  readonly operationalNotes: string;
  readonly cancellationReason: string | null;
  readonly lines: readonly ClientRequestLine[];
}

/** One request, or null when it is not this organisation's. */
export async function loadClientRequestDetail(
  clientOrganizationId: string,
  requestId: string,
  executor: Executor = getDb(),
): Promise<ClientRequestDetail | null> {
  const summaries = await executor.execute<Record<string, unknown>>(sql`
    select
      r.id, r.reference, r.status, r.source_sentence, r.operational_notes,
      r.cancellation_reason, r.arrival_utc, r.departure_utc,
      r.passenger_count, r.crew_count, r.created_at,
      coalesce(a.icao, a.iata, a.name) as airport_label,
      a.timezone_iana                  as airport_timezone,
      f.name                           as fbo_name
    from requests r
    join airports a on a.id = r.airport_id
    left join fbos f on f.id = r.fbo_id
    where r.id = ${requestId}::uuid
      and r.client_organization_id = ${clientOrganizationId}::uuid
  `);

  const row = summaries.rows[0];
  if (row === undefined) return null;

  const lineRows = await executor.execute<Record<string, unknown>>(sql`
    select
      l.id, l.quantity, l.status, l.service_start_utc, l.service_end_utc,
      s.name as service_name, s.code as service_code, s.unit_label,
      -- Named only after acceptance.
      case when o.status in ('acknowledged') then p.display_name else null end as provider_name
    from request_service_lines l
    join service_categories s on s.id = l.service_category_id
    left join provider_offers o on o.id = l.current_offer_id
    left join provider_companies p on p.id = o.provider_company_id
    where l.request_id = ${requestId}::uuid
    order by l.sequence, l.id
  `);

  const lines: ClientRequestLine[] = lineRows.rows.map((line) => ({
    id: String(line['id']),
    serviceName: String(line['service_name']),
    serviceCode: String(line['service_code']),
    unitLabel: String(line['unit_label']),
    quantity: Number(line['quantity']),
    status: String(line['status']),
    serviceStartUtc: toDate(line['service_start_utc']),
    serviceEndUtc: toDate(line['service_end_utc']),
    providerName: line['provider_name'] === null ? null : String(line['provider_name']),
  }));

  const arranged = lines.filter((line) =>
    ['assigned', 'in_progress', 'completed'].includes(line.status),
  ).length;
  const problems = lines.filter((line) => line.status === 'failed').length;

  return {
    id: String(row['id']),
    reference: String(row['reference']),
    status: row['status'] as RequestStatus,
    sourceSentence: String(row['source_sentence'] ?? ''),
    operationalNotes: String(row['operational_notes'] ?? ''),
    cancellationReason:
      row['cancellation_reason'] === null ? null : String(row['cancellation_reason']),
    airportLabel: String(row['airport_label']),
    airportTimezone: String(row['airport_timezone']),
    fboName: row['fbo_name'] === null ? null : String(row['fbo_name']),
    arrivalUtc: toDate(row['arrival_utc']),
    departureUtc: toDate(row['departure_utc']),
    passengerCount: Number(row['passenger_count']),
    crewCount: Number(row['crew_count']),
    createdAt: toDate(row['created_at']) ?? new Date(0),
    lineCount: lines.length,
    arrangedCount: arranged,
    pendingCount: lines.length - arranged - problems,
    problemCount: problems,
    lines,
  };
}
