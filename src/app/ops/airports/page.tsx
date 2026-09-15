import { asc, eq, sql } from 'drizzle-orm';
import { qualified } from '@/db/sql';
import { requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { AviationIcon } from '@/components/ui/domain-icon';
import { getDb } from '@/db/client';
import { airports } from '@/db/schema';

export const dynamic = 'force-dynamic';

/**
 * The operations view of the airport network (CLAUDE.md §12).
 *
 * Per airport: its handlers, its real timezone, and which services actually have an
 * approved provider there. The last column is the useful one — it is where a request will
 * fail to find anyone, before a client asks.
 */
export default async function OperationsAirportsPage() {
  await requirePermission('request.view.any');

  const db = getDb();

  const rows = await db
    .select({
      id: airports.id,
      icao: airports.icao,
      iata: airports.iata,
      name: airports.name,
      city: airports.city,
      stateRegion: airports.stateRegion,
      timezoneIana: airports.timezoneIana,
      latitude: airports.latitude,
      longitude: airports.longitude,
      fboNames: sql<string>`(
        select coalesce(string_agg(f.name, ', ' order by f.name), '')
        from fbos f where f.airport_id = ${qualified(airports.id)} and f.active
      )`,
      coveredServices: sql<string>`(
        select coalesce(string_agg(distinct sc.name, ', ' order by sc.name), '')
        from provider_coverage pc
        join service_categories sc on sc.id = pc.service_category_id
        join provider_companies p on p.id = pc.provider_company_id
        where pc.airport_id = ${qualified(airports.id)}
          and pc.active and sc.active
          and p.status = 'approved' and p.active
      )`,
      uncoveredServices: sql<string>`(
        select coalesce(string_agg(sc.name, ', ' order by sc.name), '')
        from service_categories sc
        where sc.active
          and not exists (
            select 1 from provider_coverage pc
            join provider_companies p on p.id = pc.provider_company_id
            where pc.airport_id = ${qualified(airports.id)}
              and pc.service_category_id = sc.id
              and pc.active and p.status = 'approved' and p.active
          )
      )`,
    })
    .from(airports)
    .where(eq(airports.active, true))
    .orderBy(asc(airports.icao), asc(airports.name), asc(airports.id));

  return (
    <>
      <PageHeader
        eyebrow="Network"
        title="Airports and FBOs"
        description="Where we operate, who handles there, and which services have no approved provider yet."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((row) => {
          const covered = row.coveredServices === '' ? [] : row.coveredServices.split(', ');
          const uncovered = row.uncoveredServices === '' ? [] : row.uncoveredServices.split(', ');
          const handlers = row.fboNames === '' ? [] : row.fboNames.split(', ');

          return (
            <Card key={row.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2.5">
                    <AviationIcon name="airport" label="" className="size-5 text-accent" />
                    {row.name}
                  </span>
                }
                description={`${row.city}${row.stateRegion === null ? '' : `, ${row.stateRegion}`} · ${row.timezoneIana}`}
                action={
                  <span className="tabular text-[13px] font-medium text-text-primary">
                    {row.icao ?? '—'}
                    {row.iata !== null && (
                      <span className="ml-2 text-text-secondary">{row.iata}</span>
                    )}
                  </span>
                }
              />

              <div className="space-y-4 p-5">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                    Handlers ({handlers.length})
                  </p>
                  {handlers.length === 0 ? (
                    <p className="mt-1 text-[13px] text-text-secondary">None recorded.</p>
                  ) : (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {handlers.map((handler) => (
                        <li
                          key={handler}
                          className="rounded-full bg-canvas-cool px-2.5 py-0.5 text-[12px] text-text-primary ring-1 ring-inset ring-border"
                        >
                          {handler}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                    Services with an approved provider
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {covered.map((service) => (
                      <li key={service}>
                        <Badge tone="success">{service}</Badge>
                      </li>
                    ))}
                    {covered.length === 0 && (
                      <li className="text-[13px] text-danger">No services are covered here.</li>
                    )}
                  </ul>
                </div>

                {uncovered.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                      No approved provider yet
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {uncovered.map((service) => (
                        <li key={service}>
                          <Badge tone="warning">{service}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="tabular text-[11px] text-text-secondary">
                  {Number(row.latitude).toFixed(4)}, {Number(row.longitude).toFixed(4)}
                </p>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
