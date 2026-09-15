'use server';

import '@/lib/server-guard';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor } from '@/auth/context';
import { can, canApproveProvider } from '@/domain/permissions';
import {
  approveProvider,
  createAirport,
  createFbo,
  createServiceCategory,
  createUser,
  rejectProvider,
  setFeatureFlag,
  setPlatformSetting,
  setProviderRank,
  setServiceCategoryActive,
  setUserStatus,
  suspendProvider,
  type Actor,
} from '@/services/governance';
import { assignmentStrategies } from '@/db/schema/enums';
import { ApronError } from '@/lib/errors';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';

/**
 * Admin Console actions (CLAUDE.md §14).
 *
 * Each action checks its own permission server-side, regardless of whether the button that
 * triggered it was rendered. Administrators do not bypass audit logging — the governance
 * service writes an event for every one of these in the same transaction as the change.
 */

export interface ActionResult {
  readonly status: 'ok' | 'error';
  readonly message?: string;
}

async function adminActor(permission: Parameters<typeof can>[1]): Promise<Actor> {
  const actor = await requireActor();
  if (!can(actor, permission)) {
    throw new ApronError('forbidden', 'Your role cannot do that');
  }
  return { userId: actor.userId, role: actor.role, label: actor.userId };
}

function ok(paths: readonly string[]): ActionResult {
  for (const path of paths) revalidatePath(path);
  return { status: 'ok' };
}

function fail(error: unknown, fallback: string): ActionResult {
  logError(fallback, error);
  return {
    status: 'error',
    message: error instanceof ApronError ? error.publicMessage : fallback,
  };
}

// ---------------------------------------------------------------------------
// provider governance
// ---------------------------------------------------------------------------

const providerSchema = z.object({ providerCompanyId: z.string().uuid() });
const reasonedProviderSchema = providerSchema.extend({
  reason: z.string().trim().min(3, 'Give a short reason').max(500),
});

export async function approveProviderAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/approve' }, async () => {
    try {
      const actor = await requireActor();
      const parsed = providerSchema.safeParse({
        providerCompanyId: formData.get('providerCompanyId'),
      });
      if (!parsed.success) return { status: 'error', message: 'That provider was not identified.' };

      // Belt and braces: the matrix denies every provider role, and this refuses a
      // self-approval even for an admin who somehow has a company attached.
      if (!canApproveProvider(actor, parsed.data.providerCompanyId)) {
        throw new ApronError('forbidden', 'You cannot approve that company');
      }

      await approveProvider(parsed.data.providerCompanyId, {
        userId: actor.userId,
        role: actor.role,
        label: actor.userId,
      });

      return ok(['/admin/providers', '/admin', '/ops/providers']);
    } catch (error) {
      return fail(error, 'Could not approve that provider.');
    }
  });
}

export async function suspendProviderAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/suspend' }, async () => {
    try {
      const actor = await adminActor('provider.suspend');
      const parsed = reasonedProviderSchema.safeParse({
        providerCompanyId: formData.get('providerCompanyId'),
        reason: formData.get('reason'),
      });
      if (!parsed.success) {
        return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Give a reason.' };
      }

      const result = await suspendProvider(
        parsed.data.providerCompanyId,
        parsed.data.reason,
        actor,
      );

      revalidatePath('/admin/providers');
      revalidatePath('/ops/providers');
      return {
        status: 'ok',
        message:
          result.withdrawnOffers > 0
            ? `Suspended. ${result.withdrawnOffers} live offer${result.withdrawnOffers === 1 ? '' : 's'} withdrawn and re-matching.`
            : 'Suspended.',
      };
    } catch (error) {
      return fail(error, 'Could not suspend that provider.');
    }
  });
}

export async function rejectProviderAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/reject' }, async () => {
    try {
      const actor = await adminActor('provider.approve');
      const parsed = reasonedProviderSchema.safeParse({
        providerCompanyId: formData.get('providerCompanyId'),
        reason: formData.get('reason'),
      });
      if (!parsed.success) {
        return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Give a reason.' };
      }

      await rejectProvider(parsed.data.providerCompanyId, parsed.data.reason, actor);
      return ok(['/admin/providers']);
    } catch (error) {
      return fail(error, 'Could not reject that registration.');
    }
  });
}

export async function setProviderRankAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/rank' }, async () => {
    try {
      const actor = await adminActor('provider.set_rank');
      const parsed = z
        .object({
          providerCompanyId: z.string().uuid(),
          rank: z.coerce.number().int().min(1).max(1000),
        })
        .safeParse({
          providerCompanyId: formData.get('providerCompanyId'),
          rank: formData.get('rank'),
        });

      if (!parsed.success) {
        return { status: 'error', message: 'Rank must be a whole number between 1 and 1000.' };
      }

      await setProviderRank(parsed.data.providerCompanyId, parsed.data.rank, actor);
      return ok(['/admin/providers', '/ops/providers']);
    } catch (error) {
      return fail(error, 'Could not change that rank.');
    }
  });
}

// ---------------------------------------------------------------------------
// catalogue — ADR-008: a new service is a row, not a migration
// ---------------------------------------------------------------------------

const createServiceSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,48}$/, 'Use lowercase letters, digits and underscores'),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  unitLabel: z.string().trim().min(1).max(40),
  assignmentStrategy: z.enum(assignmentStrategies as unknown as [string, ...string[]]),
  sortOrder: z.coerce.number().int().min(1).max(999).default(100),
});

export async function createServiceAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/catalogue' }, async () => {
    try {
      const actor = await adminActor('catalogue.manage');
      const parsed = createServiceSchema.safeParse({
        code: formData.get('code'),
        name: formData.get('name'),
        description: formData.get('description') ?? '',
        unitLabel: formData.get('unitLabel'),
        assignmentStrategy: formData.get('assignmentStrategy'),
        sortOrder: formData.get('sortOrder') ?? 100,
      });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the service details.',
        };
      }

      await createServiceCategory(
        {
          ...parsed.data,
          assignmentStrategy: parsed.data.assignmentStrategy as never,
          // Requirement fields are declared afterwards; a category with none is valid and
          // is matched on coverage, hours, lead time and capacity alone.
          configSchema: { fields: [] },
        },
        actor,
      );

      return ok(['/admin/catalogue', '/client']);
    } catch (error) {
      return fail(error, 'Could not create that service.');
    }
  });
}

export async function toggleServiceAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/catalogue' }, async () => {
    try {
      const actor = await adminActor('catalogue.manage');
      const parsed = z
        .object({ serviceCategoryId: z.string().uuid(), active: z.enum(['true', 'false']) })
        .safeParse({
          serviceCategoryId: formData.get('serviceCategoryId'),
          active: formData.get('active'),
        });

      if (!parsed.success) return { status: 'error', message: 'That service was not identified.' };

      await setServiceCategoryActive(
        parsed.data.serviceCategoryId,
        parsed.data.active === 'true',
        actor,
      );
      return ok(['/admin/catalogue', '/client']);
    } catch (error) {
      return fail(error, 'Could not change that service.');
    }
  });
}

// ---------------------------------------------------------------------------
// airport and FBO registry
// ---------------------------------------------------------------------------

/**
 * Coordinates arrive as strings and stay as strings all the way into `numeric` columns.
 *
 * Parsing them to a JS number would round a longitude like -74.060837 through binary
 * floating point before Postgres ever saw it. The map plots the stored value, so the
 * marker would sit a few metres from where the registry says the airport is.
 */
const coordinate = (min: number, max: number, what: string) =>
  z
    .string()
    .trim()
    .regex(/^-?\d{1,3}(\.\d{1,8})?$/, `${what} must be a decimal degree, such as 40.849876`)
    .refine((value) => {
      const parsed = Number(value);
      return parsed >= min && parsed <= max;
    }, `${what} must be between ${String(min)} and ${String(max)}`);

const createAirportSchema = z.object({
  icao: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}$/, 'An ICAO code is four letters, such as KTEB')
    .optional(),
  iata: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'An IATA code is three letters, such as TEB')
    .optional(),
  name: z.string().trim().min(2).max(160),
  city: z.string().trim().min(2).max(120),
  stateRegion: z.string().trim().max(120).optional(),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'A country code is two letters, such as US'),
  latitude: coordinate(-90, 90, 'Latitude'),
  longitude: coordinate(-180, 180, 'Longitude'),
  timezoneIana: z.string().trim().min(3).max(64),
});

export async function createAirportAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/registry' }, async () => {
    try {
      const actor = await adminActor('registry.manage');
      const parsed = createAirportSchema.safeParse({
        icao: emptyToUndefined(formData.get('icao')),
        iata: emptyToUndefined(formData.get('iata')),
        name: formData.get('name'),
        city: formData.get('city'),
        stateRegion: emptyToUndefined(formData.get('stateRegion')),
        countryCode: formData.get('countryCode'),
        latitude: formData.get('latitude'),
        longitude: formData.get('longitude'),
        timezoneIana: formData.get('timezoneIana'),
      });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the airport details.',
        };
      }

      await createAirport(
        {
          icao: parsed.data.icao ?? null,
          iata: parsed.data.iata ?? null,
          name: parsed.data.name,
          city: parsed.data.city,
          stateRegion: parsed.data.stateRegion ?? null,
          countryCode: parsed.data.countryCode,
          latitude: parsed.data.latitude,
          longitude: parsed.data.longitude,
          timezoneIana: parsed.data.timezoneIana,
        },
        actor,
      );

      return {
        ...ok(['/admin/registry', '/ops/airports']),
        message: 'Airport added. Intake can resolve it and providers can declare coverage for it now.',
      };
    } catch (error) {
      return fail(error, 'Could not create that airport.');
    }
  });
}

export async function createFboAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/registry' }, async () => {
    try {
      const actor = await adminActor('registry.manage');
      const parsed = z
        .object({
          airportId: z.string().uuid('Choose the airport this handler operates at'),
          name: z.string().trim().min(2).max(160),
          phone: z.string().trim().max(40).optional(),
        })
        .safeParse({
          airportId: formData.get('airportId'),
          name: formData.get('name'),
          phone: emptyToUndefined(formData.get('phone')),
        });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the handler details.',
        };
      }

      await createFbo(
        {
          airportId: parsed.data.airportId,
          name: parsed.data.name,
          phone: parsed.data.phone ?? null,
        },
        actor,
      );

      return { ...ok(['/admin/registry', '/ops/airports']), message: 'Handler added.' };
    } catch (error) {
      return fail(error, 'Could not create that handler.');
    }
  });
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export async function setUserStatusAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/users' }, async () => {
    try {
      const actor = await adminActor('user.manage');
      const parsed = z
        .object({
          userId: z.string().uuid(),
          status: z.enum(['active', 'suspended']),
          reason: z.string().trim().max(500).optional(),
        })
        .safeParse({
          userId: formData.get('userId'),
          status: formData.get('status'),
          reason: formData.get('reason') ?? undefined,
        });

      if (!parsed.success) return { status: 'error', message: 'That account was not identified.' };

      const result = await setUserStatus(
        parsed.data.userId,
        parsed.data.status,
        parsed.data.reason ?? null,
        actor,
      );

      revalidatePath('/admin/users');
      return {
        status: 'ok',
        message:
          result.revokedSessions > 0
            ? `Suspended. ${result.revokedSessions} live session${result.revokedSessions === 1 ? '' : 's'} ended immediately.`
            : 'Updated.',
      };
    } catch (error) {
      return fail(error, 'Could not change that account.');
    }
  });
}

export async function createUserAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/users' }, async () => {
    try {
      const actor = await adminActor('user.manage');
      const parsed = z
        .object({
          email: z.string().trim().email(),
          fullName: z.string().trim().min(2).max(120),
          role: z.string(),
          phone: z.string().trim().max(40).optional(),
          providerCompanyId: z.string().uuid().optional(),
          clientOrganizationId: z.string().uuid().optional(),
          temporaryPassword: z.string().min(12, 'At least 12 characters').max(200),
        })
        .safeParse({
          email: formData.get('email'),
          fullName: formData.get('fullName'),
          role: formData.get('role'),
          phone: emptyToUndefined(formData.get('phone')),
          providerCompanyId: emptyToUndefined(formData.get('providerCompanyId')),
          clientOrganizationId: emptyToUndefined(formData.get('clientOrganizationId')),
          temporaryPassword: formData.get('temporaryPassword'),
        });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the account details.',
        };
      }

      await createUser(
        {
          email: parsed.data.email,
          fullName: parsed.data.fullName,
          role: parsed.data.role as never,
          phone: parsed.data.phone ?? null,
          providerCompanyId: parsed.data.providerCompanyId ?? null,
          clientOrganizationId: parsed.data.clientOrganizationId ?? null,
          temporaryPassword: parsed.data.temporaryPassword,
        },
        actor,
      );

      revalidatePath('/admin/users');
      return { status: 'ok', message: 'Account created. They must set a new password on first sign-in.' };
    } catch (error) {
      return fail(error, 'Could not create that account.');
    }
  });
}

// ---------------------------------------------------------------------------
// settings and flags
// ---------------------------------------------------------------------------

export async function setSettingAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/settings' }, async () => {
    try {
      const actor = await adminActor('settings.manage');
      const parsed = z
        .object({ key: z.string().min(1).max(120), value: z.string().min(1).max(500) })
        .safeParse({ key: formData.get('key'), value: formData.get('value') });

      if (!parsed.success) return { status: 'error', message: 'That setting was not identified.' };

      // Settings are stored as JSON; a numeric setting must stay numeric or the code
      // reading it will silently fall back to its default.
      let value: unknown;
      try {
        value = JSON.parse(parsed.data.value);
      } catch {
        return {
          status: 'error',
          message: 'The value must be valid JSON — a number like 45, or a quoted string.',
        };
      }

      await setPlatformSetting(parsed.data.key, value, actor);
      return ok(['/admin/settings']);
    } catch (error) {
      return fail(error, 'Could not change that setting.');
    }
  });
}

export async function setFlagAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'admin/settings' }, async () => {
    try {
      const actor = await adminActor('feature_flag.manage');
      const parsed = z
        .object({ key: z.string().min(1).max(120), enabled: z.enum(['true', 'false']) })
        .safeParse({ key: formData.get('key'), enabled: formData.get('enabled') });

      if (!parsed.success) return { status: 'error', message: 'That flag was not identified.' };

      await setFeatureFlag(parsed.data.key, parsed.data.enabled === 'true', actor);
      return ok(['/admin/settings']);
    } catch (error) {
      return fail(error, 'Could not change that flag.');
    }
  });
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
