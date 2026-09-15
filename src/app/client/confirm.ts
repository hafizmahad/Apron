'use server';

import '@/lib/server-guard';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireActor } from '@/auth/context';
import { getDb } from '@/db/client';
import { airports, fbos, platformSettings } from '@/db/schema';
import { can } from '@/domain/permissions';
import { createRequest } from '@/domain/requests/create';
import { startMatchingForRequest } from '@/services/request-dispatch';
import { getServiceCategoryById } from '@/domain/services/resolve';
import { missingRequiredFields } from '@/domain/services/requirements';
import { ApronError } from '@/lib/errors';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';
import { checkRateLimit } from '@/lib/rate-limit';
import { parseWallTime, requireInstant } from '@/lib/time';

/**
 * Confirming a read-back into a real request (CLAUDE.md §8 step 4).
 *
 * The browser posts the RESOLVED selections — an airport id, an FBO id, local wall times,
 * a service category id per line. Every one of them is re-checked here against the
 * database: the airport must exist and be active, the FBO must belong to that airport, the
 * category must be active, and the local times must convert cleanly in the airport's own
 * zone. Nothing that arrives from a browser is trusted (CLAUDE.md §27).
 *
 * The model is not consulted at this step at all. Confirmation is pure deterministic work.
 */

const lineSchema = z.object({
  serviceCategoryId: z.string().uuid(),
  quantity: z.coerce.number().int().min(1).max(500),
  requirements: z.record(z.string(), z.unknown()).default({}),
});

const confirmSchema = z.object({
  sourceSentence: z.string().trim().max(4000).default(''),
  airportId: z.string().uuid(),
  fboId: z.string().uuid().nullable().default(null),
  /** `YYYY-MM-DDTHH:mm`, local at the airport. Converted here, never before. */
  arrivalLocal: z.string().nullable().default(null),
  departureLocal: z.string().nullable().default(null),
  passengerCount: z.coerce.number().int().min(0).max(400).default(0),
  crewCount: z.coerce.number().int().min(0).max(100).default(0),
  operationalNotes: z.string().max(2000).default(''),
  lines: z.array(lineSchema).min(1).max(20),
});

export interface ConfirmResult {
  readonly status: 'created' | 'error';
  readonly reference?: string;
  readonly requestId?: string;
  readonly message?: string;
  /** A DST edge the user must resolve before this can be confirmed. */
  readonly timeProblem?: { readonly field: string; readonly message: string };
  /**
   * Requirement fields the catalogue declares but the payload did not carry, named so the
   * composer can ask for them rather than reporting a failure the user cannot act on.
   */
  readonly unresolved?: readonly string[];
  /**
   * What happened when matching started, so the confirmation can say something true
   * rather than a generic "submitted". On the inline path these are real counts; on the
   * queued path the work is still in flight and only `lines` is meaningful.
   */
  readonly dispatch?: {
    readonly lines: number;
    readonly offered: number;
    readonly failed: number;
    readonly mode: 'queued' | 'inline';
  };
}

export async function confirmRequestAction(payload: unknown): Promise<ConfirmResult> {
  const correlationId = newCorrelationId();

  return withCorrelation({ correlationId, route: 'client/confirm' }, async () => {
    try {
      const actor = await requireActor();

      if (!can(actor, 'request.create')) {
        throw new ApronError('forbidden', 'You do not have permission to create requests');
      }
      if (actor.clientOrganizationId === null) {
        throw new ApronError('tenant_mismatch', 'This account is not linked to an organisation');
      }

      const limit = await checkRateLimit({
        key: `confirm:${actor.userId}`,
        limit: 20,
        windowSeconds: 600,
      });
      if (!limit.allowed) {
        return {
          status: 'error',
          message: 'Too many requests created in a short time. Try again shortly.',
        };
      }

      const parsed = confirmSchema.safeParse(payload);
      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Some details are missing or invalid.',
        };
      }

      const input = parsed.data;
      const db = getDb();

      // --- the airport must exist and be active ---------------------------
      const [airport] = await db
        .select({ id: airports.id, timezoneIana: airports.timezoneIana, active: airports.active })
        .from(airports)
        .where(eq(airports.id, input.airportId))
        .limit(1);

      if (airport === undefined || !airport.active) {
        return { status: 'error', message: 'That airport is not available.' };
      }

      // --- the FBO must belong to THAT airport ----------------------------
      if (input.fboId !== null) {
        const [fbo] = await db
          .select({ airportId: fbos.airportId, active: fbos.active })
          .from(fbos)
          .where(eq(fbos.id, input.fboId))
          .limit(1);

        if (fbo === undefined || !fbo.active || fbo.airportId !== airport.id) {
          // A database trigger enforces this too; failing here gives a usable message.
          return { status: 'error', message: 'That handler is not at the selected airport.' };
        }
      }

      // --- local wall times → instants, in the airport's zone --------------
      let arrivalUtc: Date | null = null;
      let departureUtc: Date | null = null;

      for (const [field, value] of [
        ['arrival', input.arrivalLocal],
        ['departure', input.departureLocal],
      ] as const) {
        if (value === null || value === '') continue;

        const wall = parseWallTime(value);
        if (wall === null) {
          return {
            status: 'error',
            message: `The ${field} time is not a valid date and time.`,
          };
        }

        try {
          const instant = requireInstant(wall, airport.timezoneIana);
          if (field === 'arrival') arrivalUtc = instant;
          else departureUtc = instant;
        } catch (error) {
          // A DST gap or a doubled hour. The user must choose — we never pick for them.
          return {
            status: 'error',
            timeProblem: {
              field,
              message:
                error instanceof ApronError
                  ? error.publicMessage
                  : `That ${field} time is ambiguous at this airport.`,
            },
            message: `The ${field} time needs to be confirmed.`,
          };
        }
      }

      if (arrivalUtc === null && departureUtc === null) {
        return { status: 'error', message: 'An arrival or departure time is required.' };
      }

      // --- every service category must be active, and complete --------------
      //
      // The catalogue declares which requirement fields a service cannot go without. The
      // clarification step asks for them, but a disabled button is not a control
      // (CLAUDE.md §30) — so the same rule is enforced here, where it actually binds.
      //
      // `createRequest` would refuse this anyway; it would do so with the validator's own
      // words ("Required"), which is true and useless. Naming the fields lets the composer
      // ask for them instead of showing a dead end.
      const stillNeeded: string[] = [];

      for (const line of input.lines) {
        const category = await getServiceCategoryById(line.serviceCategoryId);
        if (category === null || !category.active) {
          return { status: 'error', message: 'One of the selected services is not available.' };
        }

        for (const field of missingRequiredFields(category.configSchemaJson, line.requirements)) {
          stillNeeded.push(`${category.name}: ${field.label.toLowerCase()}`);
        }
      }

      if (stillNeeded.length > 0) {
        return {
          status: 'error',
          unresolved: stillNeeded,
          message:
            stillNeeded.length === 1
              ? `We still need one detail — ${stillNeeded[0] ?? ''}.`
              : `We still need ${String(stillNeeded.length)} details before this can be sent.`,
        };
      }

      const created = await createRequest({
        clientOrganizationId: actor.clientOrganizationId,
        createdByUserId: actor.userId,
        createdVia: 'client',
        sourceSentence: input.sourceSentence,
        airportId: airport.id,
        fboId: input.fboId,
        aircraftId: null,
        arrivalUtc,
        departureUtc,
        passengerCount: input.passengerCount,
        crewCount: input.crewCount,
        operationalNotes: input.operationalNotes,
        lines: input.lines.map((line) => ({
          serviceCategoryId: line.serviceCategoryId,
          quantity: line.quantity,
          requirements: line.requirements as Record<string, unknown>,
        })),
      });

      // The step §8 calls for: "enqueue matching". Without it the request is created and
      // then sits inert — every line stays in `matching`, no offer is ever dispatched, and
      // no provider sees the work. This is the join between intake and the waterfall.
      //
      // It runs AFTER the request is committed and never throws, so a queue problem
      // produces a request operations can retry rather than a failure for something that
      // actually happened.
      const dispatch = await startMatchingForRequest(created.request.id, {
        actorUserId: actor.userId,
      });

      return {
        status: 'created',
        reference: created.request.reference,
        requestId: created.request.id,
        dispatch: {
          lines: dispatch.lines,
          offered: dispatch.offered,
          failed: dispatch.failed,
          mode: dispatch.mode,
        },
      };
    } catch (error) {
      logError('request confirmation failed', error);
      return {
        status: 'error',
        message:
          error instanceof ApronError
            ? error.publicMessage
            : 'We could not create the request. Check the details and try again.',
      };
    }
  });
}

/** Reads a platform setting with a typed fallback, so a missing row cannot break a flow. */
export async function readNumericSetting(key: string, fallback: number): Promise<number> {
  const [row] = await getDb()
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, key))
    .limit(1);

  const value = row?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
