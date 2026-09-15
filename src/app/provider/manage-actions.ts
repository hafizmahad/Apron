'use server';

import '@/lib/server-guard';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSession } from '@/auth/context';
import { can } from '@/domain/permissions';
import {
  addDriver,
  addOfficer,
  addVehicle,
  setResourceActive,
  updateCoverage,
  type ProviderActor,
} from '@/services/provider-self';
import { vehicleClasses } from '@/db/schema/enums';
import { ApronError } from '@/lib/errors';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';

/**
 * Provider self-management actions (CLAUDE.md §13, §5).
 *
 * The company is taken from the SESSION, never from the form. There is deliberately no
 * `providerCompanyId` field anywhere below: a dispatcher can only ever act on their own
 * company because that is the only company id in scope.
 */

export interface ProviderActionResult {
  readonly status: 'ok' | 'error';
  readonly message?: string;
}

async function manageActor(
  permission: Parameters<typeof can>[1],
): Promise<ProviderActor> {
  const user = (await requireSession()).user;

  if (!can(user, permission)) {
    throw new ApronError('forbidden', 'Your role cannot change this');
  }
  if (user.providerCompanyId === null) {
    throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
  }

  return {
    userId: user.userId,
    role: user.role,
    label: user.fullName,
    providerCompanyId: user.providerCompanyId,
  };
}

function fail(error: unknown, fallback: string): ProviderActionResult {
  logError(fallback, error);
  return {
    status: 'error',
    message: error instanceof ApronError ? error.publicMessage : fallback,
  };
}

function refreshResources(): void {
  revalidatePath('/provider/resources');
  revalidatePath('/provider/schedule');
  revalidatePath('/provider');
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value));

// ---------------------------------------------------------------------------
// vehicles
// ---------------------------------------------------------------------------

export async function addVehicleAction(formData: FormData): Promise<ProviderActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'provider/add-vehicle' }, async () => {
    try {
      const actor = await manageActor('provider.manage.own_resources');

      const parsed = z
        .object({
          vehicleClass: z.enum(vehicleClasses as unknown as [string, ...string[]]),
          make: z.string().trim().min(1).max(60),
          model: z.string().trim().min(1).max(60),
          plateReference: z.string().trim().min(1).max(40),
          passengerCapacity: z.coerce.number().int().min(1).max(60),
          luggageCapacity: z.coerce.number().int().min(0).max(60).default(0),
          homeAirportId: z.string().uuid().optional(),
        })
        .safeParse({
          vehicleClass: formData.get('vehicleClass'),
          make: formData.get('make'),
          model: formData.get('model'),
          plateReference: formData.get('plateReference'),
          passengerCapacity: formData.get('passengerCapacity'),
          luggageCapacity: formData.get('luggageCapacity') ?? 0,
          homeAirportId: emptyToUndefined(formData.get('homeAirportId')),
        });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the vehicle details.',
        };
      }

      await addVehicle(
        {
          vehicleClass: parsed.data.vehicleClass as never,
          make: parsed.data.make,
          model: parsed.data.model,
          plateReference: parsed.data.plateReference,
          passengerCapacity: parsed.data.passengerCapacity,
          luggageCapacity: parsed.data.luggageCapacity,
          homeAirportId: parsed.data.homeAirportId ?? null,
        },
        actor,
      );

      refreshResources();
      return { status: 'ok', message: 'Vehicle added. It can be matched from now on.' };
    } catch (error) {
      return fail(error, 'Could not add that vehicle.');
    }
  });
}

// ---------------------------------------------------------------------------
// staff
// ---------------------------------------------------------------------------

const staffSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: optionalText(40),
  email: z.union([z.string().trim().email(), z.literal('')]).optional(),
  timezoneIana: z.string().trim().min(3).max(64),
  homeAirportId: z.string().uuid().optional(),
  armedCertified: z.enum(['true', 'false']).optional(),
});

function staffPayload(formData: FormData) {
  return {
    fullName: formData.get('fullName'),
    phone: formData.get('phone') ?? undefined,
    email: emptyToUndefined(formData.get('email')),
    timezoneIana: formData.get('timezoneIana'),
    homeAirportId: emptyToUndefined(formData.get('homeAirportId')),
    armedCertified: emptyToUndefined(formData.get('armedCertified')),
  };
}

export async function addDriverAction(formData: FormData): Promise<ProviderActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'provider/add-driver' }, async () => {
    try {
      const actor = await manageActor('provider.manage.own_resources');
      const parsed = staffSchema.safeParse(staffPayload(formData));

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the driver details.',
        };
      }

      await addDriver(
        {
          fullName: parsed.data.fullName,
          phone: parsed.data.phone,
          email: parsed.data.email === undefined || parsed.data.email === '' ? null : parsed.data.email,
          timezoneIana: parsed.data.timezoneIana,
          homeAirportId: parsed.data.homeAirportId ?? null,
        },
        actor,
      );

      refreshResources();
      return {
        status: 'ok',
        message: 'Driver added. Add their shifts so they can be matched to work.',
      };
    } catch (error) {
      return fail(error, 'Could not add that driver.');
    }
  });
}

export async function addOfficerAction(formData: FormData): Promise<ProviderActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'provider/add-officer' }, async () => {
    try {
      const actor = await manageActor('provider.manage.own_resources');
      const parsed = staffSchema.safeParse(staffPayload(formData));

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the officer details.',
        };
      }

      await addOfficer(
        {
          fullName: parsed.data.fullName,
          phone: parsed.data.phone,
          email: parsed.data.email === undefined || parsed.data.email === '' ? null : parsed.data.email,
          timezoneIana: parsed.data.timezoneIana,
          homeAirportId: parsed.data.homeAirportId ?? null,
          armedCertified: parsed.data.armedCertified === 'true',
        },
        actor,
      );

      refreshResources();
      return {
        status: 'ok',
        message: 'Officer added. Add their shifts so they can be matched to work.',
      };
    } catch (error) {
      return fail(error, 'Could not add that officer.');
    }
  });
}

// ---------------------------------------------------------------------------
// retiring and restoring
// ---------------------------------------------------------------------------

export async function setResourceActiveAction(formData: FormData): Promise<ProviderActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'provider/resource-active' }, async () => {
    try {
      const actor = await manageActor('provider.manage.own_resources');

      const parsed = z
        .object({
          kind: z.enum(['vehicle', 'driver', 'officer']),
          resourceId: z.string().uuid(),
          active: z.enum(['true', 'false']),
        })
        .safeParse({
          kind: formData.get('kind'),
          resourceId: formData.get('resourceId'),
          active: formData.get('active'),
        });

      if (!parsed.success) return { status: 'error', message: 'That resource was not identified.' };

      await setResourceActive(
        {
          kind: parsed.data.kind,
          resourceId: parsed.data.resourceId,
          active: parsed.data.active === 'true',
        },
        actor,
      );

      refreshResources();
      return {
        status: 'ok',
        message: parsed.data.active === 'true' ? 'Back in service.' : 'Taken out of service.',
      };
    } catch (error) {
      return fail(error, 'Could not change that resource.');
    }
  });
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

export async function updateCoverageAction(formData: FormData): Promise<ProviderActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'provider/coverage' }, async () => {
    try {
      const actor = await manageActor('provider.manage.own_coverage');

      const parsed = z
        .object({
          coverageId: z.string().uuid(),
          totalCapacity: z.coerce.number().int().min(0).max(999).optional(),
          leadTimeMinutes: z.coerce.number().int().min(0).max(10_080).optional(),
          active: z.enum(['true', 'false']).optional(),
        })
        .safeParse({
          coverageId: formData.get('coverageId'),
          totalCapacity: emptyToUndefined(formData.get('totalCapacity')),
          leadTimeMinutes: emptyToUndefined(formData.get('leadTimeMinutes')),
          active: emptyToUndefined(formData.get('active')),
        });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the coverage details.',
        };
      }

      await updateCoverage(
        {
          coverageId: parsed.data.coverageId,
          ...(parsed.data.totalCapacity === undefined
            ? {}
            : { totalCapacity: parsed.data.totalCapacity }),
          ...(parsed.data.leadTimeMinutes === undefined
            ? {}
            : { leadTimeMinutes: parsed.data.leadTimeMinutes }),
          ...(parsed.data.active === undefined ? {} : { active: parsed.data.active === 'true' }),
        },
        actor,
      );

      revalidatePath('/provider/coverage');
      revalidatePath('/provider');
      return { status: 'ok', message: 'Saved. The next match uses this.' };
    } catch (error) {
      return fail(error, 'Could not update that coverage entry.');
    }
  });
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
