import { Card, CardHeader } from '@/components/ui/primitives';
import { vehicleClassLabel } from '@/lib/domain-labels';
import { ActionButton, RecordForm, type RecordFieldSpec } from '@/components/ui/action-controls';
import {
  addDriverAction,
  addOfficerAction,
  addVehicleAction,
  setResourceActiveAction,
} from '@/app/provider/manage-actions';
import { vehicleClasses } from '@/db/schema/enums';

/**
 * Provider self-management controls (CLAUDE.md §13).
 *
 * A provider that cannot add a vehicle cannot take on new work, so these forms are the
 * difference between a register and a working portal.
 *
 * None of them carries a company id. The server reads that from the session, so there is
 * no field here a dispatcher could edit to act on another company.
 */

export interface AirportOption {
  readonly id: string;
  readonly label: string;
}

/** The zones a person's shifts are read in. Kept to where this platform operates. */
const TIMEZONES: readonly string[] = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Asia/Dubai',
];

function airportField(airports: readonly AirportOption[]): RecordFieldSpec {
  return {
    name: 'homeAirportId',
    label: 'Home airport',
    type: 'select',
    defaultValue: '',
    options: [
      { value: '', label: 'not tied to one airport' },
      ...airports.map((airport) => ({ value: airport.id, label: airport.label })),
    ],
    hint: 'Where this is normally based. Optional.',
  };
}

function staffFields(airports: readonly AirportOption[], officer: boolean): readonly RecordFieldSpec[] {
  return [
    { name: 'fullName', label: 'Full name', type: 'text', required: true, placeholder: 'Anthony Reyes' },
    { name: 'phone', label: 'Phone', type: 'text', placeholder: '+1 201 555 0142' },
    { name: 'email', label: 'Email', type: 'email', placeholder: 'anthony@example.com' },
    {
      name: 'timezoneIana',
      label: 'Shift timezone',
      type: 'select',
      required: true,
      defaultValue: 'America/New_York',
      options: TIMEZONES.map((zone) => ({ value: zone, label: zone })),
      hint: 'Their shifts are wall-clock times in this zone. Getting it wrong makes them look unavailable.',
    },
    airportField(airports),
    ...(officer
      ? ([
          {
            name: 'armedCertified',
            label: 'Armed certified',
            type: 'select',
            defaultValue: 'false',
            wide: true,
            options: [
              { value: 'false', label: 'No — unarmed cover only' },
              { value: 'true', label: 'Yes — certified to carry' },
            ],
            hint: 'A request asking for armed cover matches only on this. It is never inferred from anything else.',
          },
        ] satisfies readonly RecordFieldSpec[])
      : []),
  ];
}

export function AddResourcePanel({
  airports,
  kinds,
}: {
  readonly airports: readonly AirportOption[];
  /** Only the kinds this company actually operates. */
  readonly kinds: readonly ('vehicle' | 'driver' | 'officer')[];
}) {
  if (kinds.length === 0) return null;

  const vehicleFields: readonly RecordFieldSpec[] = [
    {
      name: 'vehicleClass',
      label: 'Class',
      type: 'select',
      required: true,
      defaultValue: vehicleClasses[0],
      // The VALUE stays the enum member; only the label is readable.
      options: vehicleClasses.map((value) => ({ value, label: vehicleClassLabel(value) })),
      hint: 'A request asking for an SUV matches on this.',
    },
    { name: 'plateReference', label: 'Plate or reference', type: 'text', required: true, placeholder: 'WX-8812' },
    { name: 'make', label: 'Make', type: 'text', required: true, placeholder: 'Cadillac' },
    { name: 'model', label: 'Model', type: 'text', required: true, placeholder: 'Escalade' },
    {
      name: 'passengerCapacity',
      label: 'Passenger seats',
      type: 'number',
      required: true,
      defaultValue: '4',
      hint: 'A request for more passengers than this will not match the vehicle.',
    },
    { name: 'luggageCapacity', label: 'Luggage pieces', type: 'number', defaultValue: '4' },
    airportField(airports),
  ];

  return (
    <Card className="mb-4">
      <CardHeader
        title="Add to your fleet"
        description="Anything you add here can be matched to work immediately. Nothing is deleted later — retiring keeps the history."
      />
      <div className="flex flex-wrap gap-2 p-5">
        {kinds.includes('vehicle') && (
          <RecordForm
            action={addVehicleAction}
            fields={vehicleFields}
            trigger="Add a vehicle"
            title="New vehicle"
            description="Class and passenger seats are what matching reads, so make them accurate rather than generous."
            submitLabel="Add vehicle"
          />
        )}

        {kinds.includes('driver') && (
          <RecordForm
            action={addDriverAction}
            fields={staffFields(airports, false)}
            trigger="Add a driver"
            title="New driver"
            description="Add their working shifts afterwards — until a driver has a shift covering a service window, they cannot be matched to it."
            submitLabel="Add driver"
          />
        )}

        {kinds.includes('officer') && (
          <RecordForm
            action={addOfficerAction}
            fields={staffFields(airports, true)}
            trigger="Add an officer"
            title="New close protection officer"
            description="Add their working shifts afterwards — until an officer has a shift covering a service window, they cannot be matched to it."
            submitLabel="Add officer"
          />
        )}
      </div>
    </Card>
  );
}

/** Retire or restore one resource, rendered inside its row. */
export function ResourceActiveControl({
  kind,
  resourceId,
  active,
  label,
}: {
  readonly kind: 'vehicle' | 'driver' | 'officer';
  readonly resourceId: string;
  readonly active: boolean;
  readonly label: string;
}) {
  return (
    <ActionButton
      action={setResourceActiveAction}
      fields={{ kind, resourceId, active: active ? 'false' : 'true' }}
      label={active ? 'Retire' : 'Restore'}
      pendingLabel="Saving…"
      variant="ghost"
      confirm={
        active
          ? {
              title: `Take ${label} out of service?`,
              body: 'It stops being matched to new work. Everything it is already committed to is unaffected, and its history is kept. You can restore it at any time.',
              confirmLabel: 'Retire',
            }
          : {
              title: `Put ${label} back in service?`,
              body: 'It becomes available for matching again straight away.',
              confirmLabel: 'Restore',
            }
      }
    />
  );
}
