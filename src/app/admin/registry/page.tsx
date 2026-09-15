import { asc, eq, sql } from 'drizzle-orm';
import { qualified } from '@/db/sql';
import { hasPermission, requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/data-table';
import { RecordForm, type RecordFieldSpec } from '@/components/ui/action-controls';
import { createAirportAction, createFboAction } from '@/app/admin/actions';
import { getDb } from '@/db/client';
import { airports, fbos } from '@/db/schema';
import { formatMinuteOfDay } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * Airport and FBO registry (CLAUDE.md §14).
 *
 * Real reference data: identifiers, published coordinates, IANA timezone, handlers and
 * how many providers actually cover each field. This register is what the intake resolver
 * reads, so an airport added here is resolvable from a sentence immediately.
 *
 * Coordinates and the IANA timezone are required and are never guessed: the timezone
 * drives every local-to-UTC conversion for that field, and the coordinates are what the
 * map plots. A wrong value here is a wrong arrival time on every future request.
 */

interface AirportRow {
  readonly id: string;
  readonly icao: string | null;
  readonly iata: string | null;
  readonly name: string;
  readonly city: string;
  readonly stateRegion: string | null;
  readonly countryCode: string;
  readonly latitude: string;
  readonly longitude: string;
  readonly timezoneIana: string;
  readonly active: boolean;
  readonly fboCount: number;
  readonly providerCount: number;
}

interface FboRow {
  readonly id: string;
  readonly name: string;
  readonly airportLabel: string;
  readonly hoursSummary: string;
  readonly active: boolean;
}

export default async function AdminRegistryPage() {
  await requirePermission('provider.view.any');
  const editor = await hasPermission('registry.manage');

  const db = getDb();

  const airportRows = await db
    .select({
      id: airports.id,
      icao: airports.icao,
      iata: airports.iata,
      name: airports.name,
      city: airports.city,
      stateRegion: airports.stateRegion,
      countryCode: airports.countryCode,
      latitude: airports.latitude,
      longitude: airports.longitude,
      timezoneIana: airports.timezoneIana,
      active: airports.active,
      fboCount: sql<number>`(select count(*)::int from fbos f where f.airport_id = ${qualified(airports.id)} and f.active)`,
      providerCount: sql<number>`(select count(distinct pc.provider_company_id)::int from provider_coverage pc where pc.airport_id = ${qualified(airports.id)} and pc.active)`,
    })
    .from(airports)
    .orderBy(asc(airports.icao), asc(airports.name), asc(airports.id));

  // Desk hours are aggregated in SQL so the page issues two queries, not one per FBO.
  const fboRows = await db
    .select({
      id: fbos.id,
      name: fbos.name,
      active: fbos.active,
      airportIcao: airports.icao,
      airportName: airports.name,
      hours: sql<string>`(
        select coalesce(
          string_agg(
            h.weekday::text || ':' || h.open_minute::text || '-' || h.close_minute::text,
            ',' order by h.weekday
          ), ''
        )
        from fbo_operating_hours h where h.fbo_id = ${qualified(fbos.id)}
      )`,
    })
    .from(fbos)
    .innerJoin(airports, eq(airports.id, fbos.airportId))
    .orderBy(asc(airports.icao), asc(fbos.name), asc(fbos.id));

  const airportColumns: readonly Column<AirportRow>[] = [
    {
      key: 'identifier',
      header: 'Identifier',
      numeric: true,
      render: (row) => (
        <span className="font-medium">
          {row.icao ?? '—'}
          {row.iata !== null && <span className="ml-2 text-text-secondary">{row.iata}</span>}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Airport',
      render: (row) => (
        <div>
          <p className="font-medium text-text-primary">{row.name}</p>
          <p className="mt-0.5 text-[12px] text-text-secondary">
            {row.city}
            {row.stateRegion === null ? '' : `, ${row.stateRegion}`} · {row.countryCode}
          </p>
        </div>
      ),
    },
    {
      key: 'timezone',
      header: 'Timezone',
      secondary: true,
      render: (row) => <span className="text-text-secondary">{row.timezoneIana}</span>,
    },
    {
      key: 'position',
      header: 'Position',
      numeric: true,
      secondary: true,
      render: (row) => (
        <span className="text-text-secondary">
          {Number(row.latitude).toFixed(4)}, {Number(row.longitude).toFixed(4)}
        </span>
      ),
    },
    { key: 'fbos', header: 'FBOs', numeric: true, align: 'right', render: (row) => row.fboCount },
    {
      key: 'providers',
      header: 'Providers',
      numeric: true,
      align: 'right',
      render: (row) => row.providerCount,
    },
    {
      key: 'active',
      header: 'State',
      render: (row) =>
        row.active ? <Badge tone="success">active</Badge> : <Badge tone="neutral">inactive</Badge>,
    },
  ];

  const fboColumns: readonly Column<FboRow>[] = [
    { key: 'name', header: 'Handler', render: (row) => <span className="font-medium">{row.name}</span> },
    { key: 'airport', header: 'Airport', render: (row) => row.airportLabel },
    {
      key: 'hours',
      header: 'Desk hours',
      secondary: true,
      numeric: true,
      render: (row) => <span className="text-text-secondary">{row.hoursSummary}</span>,
    },
    {
      key: 'active',
      header: 'State',
      render: (row) =>
        row.active ? <Badge tone="success">active</Badge> : <Badge tone="neutral">inactive</Badge>,
    },
  ];

  const fboData: FboRow[] = fboRows.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    airportLabel: row.airportIcao === null ? row.airportName : `${row.airportIcao} · ${row.airportName}`,
    hoursSummary: summariseHours(row.hours),
  }));

  const airportFields: readonly RecordFieldSpec[] = [
    { name: 'icao', label: 'ICAO', type: 'text', placeholder: 'KTEB', hint: 'Four letters. Give an ICAO or an IATA code — at least one is required.' },
    { name: 'iata', label: 'IATA', type: 'text', placeholder: 'TEB', hint: 'Three letters, where the field has one.' },
    { name: 'name', label: 'Airport name', type: 'text', required: true, placeholder: 'Teterboro Airport', wide: true },
    { name: 'city', label: 'City', type: 'text', required: true, placeholder: 'Teterboro' },
    { name: 'stateRegion', label: 'State or region', type: 'text', placeholder: 'New Jersey' },
    { name: 'countryCode', label: 'Country', type: 'text', required: true, placeholder: 'US', hint: 'Two-letter ISO code.' },
    {
      name: 'timezoneIana',
      label: 'Timezone',
      type: 'text',
      required: true,
      placeholder: 'America/New_York',
      hint: 'IANA zone name. Rejected if the runtime does not recognise it — a wrong zone silently shifts every arrival time at this field.',
    },
    { name: 'latitude', label: 'Latitude', type: 'text', required: true, placeholder: '40.849876', hint: 'Decimal degrees, north positive.' },
    { name: 'longitude', label: 'Longitude', type: 'text', required: true, placeholder: '-74.060837', hint: 'Decimal degrees, east positive.' },
  ];

  const fboFields: readonly RecordFieldSpec[] = [
    {
      name: 'airportId',
      label: 'Airport',
      type: 'select',
      required: true,
      wide: true,
      options: airportRows.map((row) => ({
        value: row.id,
        label: row.icao === null ? row.name : `${row.icao} · ${row.name}`,
      })),
    },
    { name: 'name', label: 'Handler name', type: 'text', required: true, placeholder: 'Signature Flight Support' },
    { name: 'phone', label: 'Phone', type: 'text', placeholder: '+1 201 288 1880' },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Airport and FBO registry"
        description="The reference data intake resolves against. A licensed dataset replaces the seed through the same adapter."
      />

      {editor && (
        <div className="mb-6 grid gap-3 lg:grid-cols-2">
          <RecordForm
            action={createAirportAction}
            fields={airportFields}
            trigger="Add an airport"
            title="New airport"
            description="Intake resolves against this register the moment the row exists, and providers can declare coverage for it."
            submitLabel="Create airport"
          />
          <RecordForm
            action={createFboAction}
            fields={fboFields}
            trigger="Add a handler"
            title="New fixed-base operator"
            description="Desk hours are declared afterwards against the handler. Until they are, coverage that names this FBO is matched on the provider's own hours."
            submitLabel="Create handler"
          />
        </div>
      )}

      <Card className="mb-6">
        <CardHeader
          title={`${airportRows.length} airports`}
          description="Coordinates are published airport reference points. Timezones drive every local-time conversion in the platform."
        />
        <DataTable
          columns={airportColumns}
          rows={airportRows}
          rowKey={(row) => row.id}
          emptyTitle="No airports"
          emptyDescription="Load the reference network with npm run db:seed."
          caption="Airports"
        />
      </Card>

      <Card>
        <CardHeader
          title={`${fboData.length} handlers`}
          description="FBO coordinates are deliberately not recorded: the exact position of a facility on a field is not something to invent. The map uses the airport reference point."
        />
        <DataTable
          columns={fboColumns}
          rows={fboData}
          rowKey={(row) => row.id}
          emptyTitle="No handlers"
          emptyDescription="FBOs appear here once the registry is populated."
          caption="Fixed-base operators"
        />
      </Card>
    </>
  );
}

/** `1:300-1380,2:300-1380,…` into `Mon–Sun 05:00–23:00` where the pattern is uniform. */
function summariseHours(encoded: string): string {
  if (encoded === '') return 'not recorded';

  const entries = encoded.split(',').map((part) => {
    const [weekday, range] = part.split(':');
    const [open, close] = (range ?? '').split('-');
    return { weekday: Number(weekday), open: Number(open), close: Number(close) };
  });

  if (entries.length === 0) return 'not recorded';

  const first = entries[0]!;
  const uniform = entries.every((entry) => entry.open === first.open && entry.close === first.close);

  if (uniform && entries.length === 7) {
    if (first.open === 0 && first.close >= 1440) return '24/7';
    return `every day ${formatMinuteOfDay(first.open)}–${formatMinuteOfDay(first.close)}`;
  }

  const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return entries
    .slice(0, 3)
    .map((entry) => `${DAYS[entry.weekday] ?? '?'} ${formatMinuteOfDay(entry.open)}–${formatMinuteOfDay(entry.close)}`)
    .join(', ')
    .concat(entries.length > 3 ? ` +${entries.length - 3} more` : '');
}
