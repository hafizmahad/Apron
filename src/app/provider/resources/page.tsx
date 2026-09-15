import { and, asc, eq } from 'drizzle-orm';
import { featureLabel, fuelTypeLabel, resourceStatusLabel, vehicleClassLabel } from '@/lib/domain-labels';
import { qualified } from '@/db/sql';
import { requirePermission } from '@/auth/context';
import { Badge, Card, CardHeader, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/data-table';
import {
  AddResourcePanel,
  ResourceActiveControl,
} from '@/components/providers/resource-management';
import { hasPermission } from '@/auth/context';
import { getDb } from '@/db/client';
import {
  airports,
  drivers,
  hangarResources,
  hotelProperties,
  cateringCapabilities,
  fuelCapabilities,
  providerCoverage,
  securityOfficers,
  vehicles,
} from '@/db/schema';
import { ApronError } from '@/lib/errors';
import { formatMinuteOfDay } from '@/lib/time';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

/**
 * The provider's own resources (CLAUDE.md §13).
 *
 * Every query is filtered by the session's `providerCompanyId`. There is no route
 * parameter to tamper with and no way to widen the scope from the client — a provider
 * physically cannot read another company's fleet from this page (Journey G).
 *
 * Only the resource kinds this company actually operates are shown; a ground transport
 * company sees vehicles and drivers, not empty hangar and catering tables.
 */

interface VehicleRow {
  readonly id: string;
  readonly active: boolean;
  readonly plateReference: string;
  readonly label: string;
  readonly vehicleClass: string;
  readonly passengerCapacity: number;
  readonly luggageCapacity: number;
  readonly features: readonly string[];
  readonly status: string;
  readonly base: string | null;
}

interface StaffRow {
  readonly id: string;
  readonly active: boolean;
  /** Which table this row came from, so the retire control targets the right one. */
  readonly kind: 'driver' | 'officer';
  readonly fullName: string;
  readonly status: string;
  readonly base: string | null;
  readonly timezone: string;
  readonly shifts: string;
  readonly detail: string | null;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  available: 'success',
  maintenance: 'warning',
  retired: 'neutral',
  off_duty: 'warning',
  inactive: 'neutral',
};

export default async function ProviderResourcesPage() {
  const actor = await requirePermission('provider.view.own');
  const companyId = actor.providerCompanyId;

  if (companyId === null) {
    throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
  }

  const db = getDb();

  const [vehicleRows, driverRows, officerRows, hotelRows, cateringRows, fuelRows, hangarRows] =
    await Promise.all([
      db
        .select({
          id: vehicles.id,
          plateReference: vehicles.plateReference,
          make: vehicles.make,
          model: vehicles.model,
          modelYear: vehicles.modelYear,
          vehicleClass: vehicles.vehicleClass,
          passengerCapacity: vehicles.passengerCapacity,
          luggageCapacity: vehicles.luggageCapacity,
          features: vehicles.features,
          status: vehicles.status,
          active: vehicles.active,
          baseIcao: airports.icao,
        })
        .from(vehicles)
        .leftJoin(airports, eq(airports.id, vehicles.homeAirportId))
        // Retired resources are listed too, greyed, so a provider can put one back. Filtering
        // them out made retiring a one-way door with no way back through the product.
        .where(eq(vehicles.providerCompanyId, companyId))
        .orderBy(asc(vehicles.vehicleClass), asc(vehicles.plateReference), asc(vehicles.id)),

      db
        .select({
          id: drivers.id,
          fullName: drivers.fullName,
          status: drivers.status,
          active: drivers.active,
          timezoneIana: drivers.timezoneIana,
          languages: drivers.languages,
          baseIcao: airports.icao,
          shifts: sql<string>`(
            select coalesce(string_agg(s.weekday::text || ':' || s.open_minute || '-' || s.close_minute, ',' order by s.weekday), '')
            from driver_shifts s where s.driver_id = ${qualified(drivers.id)}
          )`,
        })
        .from(drivers)
        .leftJoin(airports, eq(airports.id, drivers.homeAirportId))
        .where(eq(drivers.providerCompanyId, companyId))
        .orderBy(asc(drivers.fullName), asc(drivers.id)),

      db
        .select({
          id: securityOfficers.id,
          fullName: securityOfficers.fullName,
          status: securityOfficers.status,
          active: securityOfficers.active,
          timezoneIana: securityOfficers.timezoneIana,
          armedCertified: securityOfficers.armedCertified,
          languages: securityOfficers.languages,
          baseIcao: airports.icao,
          shifts: sql<string>`(
            select coalesce(string_agg(s.weekday::text || ':' || s.open_minute || '-' || s.close_minute, ',' order by s.weekday), '')
            from officer_shifts s where s.officer_id = ${qualified(securityOfficers.id)}
          )`,
        })
        .from(securityOfficers)
        .leftJoin(airports, eq(airports.id, securityOfficers.homeAirportId))
        .where(
          eq(securityOfficers.providerCompanyId, companyId),
        )
        .orderBy(asc(securityOfficers.fullName), asc(securityOfficers.id)),

      db
        .select({
          id: hotelProperties.id,
          name: hotelProperties.name,
          starRating: hotelProperties.starRating,
          driveMinutesToFbo: hotelProperties.driveMinutesToFbo,
          airportIcao: airports.icao,
          rooms: sql<string>`(
            select coalesce(string_agg(rt.name || ' ×' || rt.total_rooms, ', ' order by rt.name), '')
            from hotel_room_types rt where rt.hotel_property_id = ${qualified(hotelProperties.id)} and rt.active
          )`,
        })
        .from(hotelProperties)
        .innerJoin(airports, eq(airports.id, hotelProperties.airportId))
        .where(and(eq(hotelProperties.providerCompanyId, companyId), eq(hotelProperties.active, true)))
        .orderBy(asc(hotelProperties.name), asc(hotelProperties.id)),

      db
        .select({
          id: cateringCapabilities.id,
          kitchenName: cateringCapabilities.kitchenName,
          leadTimeMinutes: cateringCapabilities.leadTimeMinutes,
          maxOrdersPerDay: cateringCapabilities.maxOrdersPerDay,
          dietaryTags: cateringCapabilities.dietaryTags,
          airportIcao: airports.icao,
        })
        .from(cateringCapabilities)
        .innerJoin(airports, eq(airports.id, cateringCapabilities.airportId))
        .where(
          and(
            eq(cateringCapabilities.providerCompanyId, companyId),
            eq(cateringCapabilities.active, true),
          ),
        )
        .orderBy(asc(cateringCapabilities.kitchenName), asc(cateringCapabilities.id)),

      db
        .select({
          id: fuelCapabilities.id,
          truckReference: fuelCapabilities.truckReference,
          fuelType: fuelCapabilities.fuelType,
          maxUpliftGallons: fuelCapabilities.maxUpliftGallons,
          supportsPrist: fuelCapabilities.supportsPrist,
          airportIcao: airports.icao,
        })
        .from(fuelCapabilities)
        .innerJoin(airports, eq(airports.id, fuelCapabilities.airportId))
        .where(
          and(eq(fuelCapabilities.providerCompanyId, companyId), eq(fuelCapabilities.active, true)),
        )
        .orderBy(asc(fuelCapabilities.truckReference), asc(fuelCapabilities.id)),

      db
        .select({
          id: hangarResources.id,
          name: hangarResources.name,
          doorWidthFt: hangarResources.doorWidthFt,
          doorHeightFt: hangarResources.doorHeightFt,
          floorLengthFt: hangarResources.floorLengthFt,
          maxAircraftWeightLbs: hangarResources.maxAircraftWeightLbs,
          heated: hangarResources.heated,
          airportIcao: airports.icao,
        })
        .from(hangarResources)
        .innerJoin(airports, eq(airports.id, hangarResources.airportId))
        .where(
          and(eq(hangarResources.providerCompanyId, companyId), eq(hangarResources.active, true)),
        )
        .orderBy(asc(hangarResources.name), asc(hangarResources.id)),
    ]);

  const vehicleData: VehicleRow[] = vehicleRows.map((row) => ({
    id: row.id,
    plateReference: row.plateReference,
    label: `${row.make} ${row.model}${row.modelYear === null ? '' : ` ${row.modelYear}`}`,
    vehicleClass: row.vehicleClass,
    passengerCapacity: row.passengerCapacity,
    luggageCapacity: row.luggageCapacity,
    features: row.features,
    status: row.status,
    active: row.active,
    base: row.baseIcao,
  }));

  const driverData: StaffRow[] = driverRows.map((row) => ({
    id: row.id,
    kind: 'driver' as const,
    active: row.active,
    fullName: row.fullName,
    status: row.status,
    base: row.baseIcao,
    timezone: row.timezoneIana,
    shifts: summariseShifts(row.shifts),
    detail: row.languages.length === 0 ? null : row.languages.join(', '),
  }));

  const officerData: StaffRow[] = officerRows.map((row) => ({
    id: row.id,
    kind: 'officer' as const,
    active: row.active,
    fullName: row.fullName,
    status: row.status,
    base: row.baseIcao,
    timezone: row.timezoneIana,
    shifts: summariseShifts(row.shifts),
    detail: [row.armedCertified ? 'armed certified' : 'unarmed', ...row.languages].join(' · '),
  }));

  const canManage = await hasPermission('provider.manage.own_resources');

  // Airports this company already covers — the realistic set to base a vehicle or a
  // person at. Offering every airport in the registry would be a longer list and a
  // worse one.
  const airportOptions = canManage
    ? (
        await db
          .selectDistinct({ id: airports.id, icao: airports.icao, name: airports.name })
          .from(providerCoverage)
          .innerJoin(airports, eq(airports.id, providerCoverage.airportId))
          .where(eq(providerCoverage.providerCompanyId, companyId))
          .orderBy(asc(airports.icao), asc(airports.name))
      ).map((row) => ({
        id: row.id,
        label: row.icao === null ? row.name : `${row.icao} · ${row.name}`,
      }))
    : [];

  const vehicleColumns: readonly Column<VehicleRow>[] = [
    {
      key: 'plate',
      header: 'Reference',
      numeric: true,
      render: (row) => <span className="font-medium">{row.plateReference}</span>,
    },
    {
      key: 'vehicle',
      header: 'Vehicle',
      render: (row) => (
        <div>
          <p className="text-text-primary">{row.label}</p>
          <p className="mt-0.5 text-[12px] text-text-secondary">{vehicleClassLabel(row.vehicleClass)}</p>
        </div>
      ),
    },
    {
      key: 'capacity',
      header: 'Seats / bags',
      numeric: true,
      align: 'right',
      render: (row) => `${row.passengerCapacity} / ${row.luggageCapacity}`,
    },
    {
      key: 'features',
      header: 'Features',
      secondary: true,
      render: (row) =>
        row.features.length === 0 ? (
          <span className="text-text-secondary/60">—</span>
        ) : (
          <span className="text-[12px] text-text-secondary">{row.features.map(featureLabel).join(', ')}</span>
        ),
    },
    { key: 'base', header: 'Base', numeric: true, secondary: true, render: (row) => row.base ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.active ? (
          <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{resourceStatusLabel(row.status)}</Badge>
        ) : (
          <Badge tone="neutral">retired</Badge>
        ),
    },
    ...(canManage
      ? ([
          {
            key: 'manage',
            header: 'Manage',
            widthClass: 'w-[220px]',
            render: (row: VehicleRow) => (
              <ResourceActiveControl
                kind="vehicle"
                resourceId={row.id}
                active={row.active}
                label={row.plateReference}
              />
            ),
          },
        ] satisfies readonly Column<VehicleRow>[])
      : []),
  ];

  const staffColumns: readonly Column<StaffRow>[] = [
    { key: 'name', header: 'Name', render: (row) => <span className="font-medium">{row.fullName}</span> },
    {
      key: 'shifts',
      header: 'Shifts (local)',
      numeric: true,
      render: (row) => <span className="text-text-secondary">{row.shifts}</span>,
    },
    {
      key: 'detail',
      header: 'Detail',
      secondary: true,
      render: (row) => (
        <span className="text-[12px] text-text-secondary">{row.detail ?? '—'}</span>
      ),
    },
    { key: 'base', header: 'Base', numeric: true, secondary: true, render: (row) => row.base ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.active ? (
          <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{resourceStatusLabel(row.status)}</Badge>
        ) : (
          <Badge tone="neutral">retired</Badge>
        ),
    },
    ...(canManage
      ? ([
          {
            key: 'manage',
            header: 'Manage',
            widthClass: 'w-[220px]',
            render: (row: StaffRow) => (
              <ResourceActiveControl
                kind={row.kind}
                resourceId={row.id}
                active={row.active}
                label={row.fullName}
              />
            ),
          },
        ] satisfies readonly Column<StaffRow>[])
      : []),
  ];

  const hasAny =
    vehicleData.length + driverData.length + officerData.length + hotelRows.length +
      cateringRows.length + fuelRows.length + hangarRows.length >
    0;

  return (
    <>
      <PageHeader
        eyebrow="Company"
        title="Resources"
        description="Everything this company can commit to a job. Shifts are wall-clock windows in each person's own timezone, and a window past midnight crosses into the next day."
      />

      {canManage && (
        <AddResourcePanel
          airports={airportOptions}
          kinds={['vehicle', 'driver', 'officer']}
        />
      )}

      {!hasAny && (
        <Card>
          <CardHeader
            title="No resources recorded"
            description={
              canManage
                ? 'Add a vehicle, driver or officer above. Until this company has resources, it cannot be matched to work.'
                : 'This company has no resources recorded yet, so it cannot be matched to work.'
            }
          />
        </Card>
      )}

      {vehicleData.length > 0 && (
        <Card className="mb-4">
          <CardHeader title={`Vehicles (${vehicleData.length})`} />
          <DataTable
            columns={vehicleColumns}
            rows={vehicleData}
            rowKey={(row) => row.id}
            emptyTitle="No vehicles"
            emptyDescription="Vehicles you add appear here."
            caption="Vehicles"
          />
        </Card>
      )}

      {driverData.length > 0 && (
        <Card className="mb-4">
          <CardHeader
            title={`Drivers (${driverData.length})`}
            description="A vehicle without an on-shift driver is not a service — matching requires both."
          />
          <DataTable
            columns={staffColumns}
            rows={driverData}
            rowKey={(row) => row.id}
            emptyTitle="No drivers"
            emptyDescription="Drivers you add appear here."
            caption="Drivers"
          />
        </Card>
      )}

      {officerData.length > 0 && (
        <Card className="mb-4">
          <CardHeader
            title={`Protective officers (${officerData.length})`}
            description="Armed certification is matched against what is recorded here; it is never inferred from the request."
          />
          <DataTable
            columns={staffColumns}
            rows={officerData}
            rowKey={(row) => row.id}
            emptyTitle="No officers"
            emptyDescription="Officers you add appear here."
            caption="Protective officers"
          />
        </Card>
      )}

      {hotelRows.length > 0 && (
        <Card className="mb-4">
          <CardHeader title={`Hotel properties (${hotelRows.length})`} />
          <ul className="divide-y divide-border">
            {hotelRows.map((row) => (
              <li key={row.id} className="px-5 py-3">
                <p className="text-[13px] font-medium text-text-primary">
                  {row.name}
                  <span className="ml-2 text-[12px] font-normal text-text-secondary">
                    {row.airportIcao}
                    {row.starRating === null ? '' : ` · ${row.starRating}★`}
                    {row.driveMinutesToFbo === null ? '' : ` · ${row.driveMinutesToFbo} min to FBO`}
                  </span>
                </p>
                <p className="mt-0.5 text-[12px] text-text-secondary">{row.rooms}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {cateringRows.length > 0 && (
        <Card className="mb-4">
          <CardHeader title={`Kitchens (${cateringRows.length})`} />
          <ul className="divide-y divide-border">
            {cateringRows.map((row) => (
              <li key={row.id} className="px-5 py-3">
                <p className="text-[13px] font-medium text-text-primary">
                  {row.kitchenName}
                  <span className="ml-2 text-[12px] font-normal text-text-secondary">
                    {row.airportIcao}
                  </span>
                </p>
                <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                  {formatMinutes(row.leadTimeMinutes)} lead · {row.maxOrdersPerDay} orders/day
                  {row.dietaryTags.length > 0 ? ` · ${row.dietaryTags.join(', ')}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {fuelRows.length > 0 && (
        <Card className="mb-4">
          <CardHeader title={`Fuel trucks (${fuelRows.length})`} />
          <ul className="divide-y divide-border">
            {fuelRows.map((row) => (
              <li key={row.id} className="px-5 py-3">
                <p className="text-[13px] font-medium text-text-primary">
                  {row.truckReference}
                  <span className="ml-2 text-[12px] font-normal text-text-secondary">
                    {row.airportIcao}
                  </span>
                </p>
                <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                  {fuelTypeLabel(row.fuelType)} · up to {row.maxUpliftGallons.toLocaleString('en-US')} gal
                  {row.supportsPrist ? ' · prist' : ''}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {hangarRows.length > 0 && (
        <Card>
          <CardHeader
            title={`Hangar bays (${hangarRows.length})`}
            description="Door and floor dimensions are compared against the aircraft's published wingspan, length and tail height. An unknown dimension makes the check fail, never pass."
          />
          <ul className="divide-y divide-border">
            {hangarRows.map((row) => (
              <li key={row.id} className="px-5 py-3">
                <p className="text-[13px] font-medium text-text-primary">
                  {row.name}
                  <span className="ml-2 text-[12px] font-normal text-text-secondary">
                    {row.airportIcao}
                    {row.heated ? ' · heated' : ''}
                  </span>
                </p>
                <p className="tabular mt-0.5 text-[12px] text-text-secondary">
                  door {row.doorWidthFt} × {row.doorHeightFt} ft · floor {row.floorLengthFt} ft
                  {row.maxAircraftWeightLbs === null
                    ? ''
                    : ` · max ${row.maxAircraftWeightLbs.toLocaleString('en-US')} lbs`}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** `1:1080-1800,2:1080-1800,…` into `Mon–Sun 18:00–06:00` where the pattern repeats. */
function summariseShifts(encoded: string): string {
  if (encoded === '') return 'no shifts recorded';

  const entries = encoded.split(',').map((part) => {
    const [weekday, range] = part.split(':');
    const [open, close] = (range ?? '').split('-');
    return { weekday: Number(weekday), open: Number(open), close: Number(close) };
  });

  const first = entries[0];
  if (first === undefined) return 'no shifts recorded';

  const uniform = entries.every((entry) => entry.open === first.open && entry.close === first.close);
  const window = `${formatMinuteOfDay(first.open)}–${formatMinuteOfDay(first.close)}`;

  if (uniform) {
    if (entries.length === 7) return `every day ${window}`;
    const days = entries.map((entry) => DAYS[entry.weekday] ?? '?').join(' ');
    return `${days} ${window}`;
  }

  return entries
    .map((entry) => `${DAYS[entry.weekday] ?? '?'} ${formatMinuteOfDay(entry.open)}–${formatMinuteOfDay(entry.close)}`)
    .join(', ');
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} m`;
}
