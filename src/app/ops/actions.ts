'use server';

import '@/lib/server-guard';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor } from '@/auth/context';
import { can } from '@/domain/permissions';
import {
  cancelRequest,
  overrideProvider,
  releaseContactsToProvider,
  retryFailedLine,
  type InterventionActor,
} from '@/services/interventions';
import { ApronError } from '@/lib/errors';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';

/**
 * Operations intervention actions (CLAUDE.md §12 "manual override controls", §5 "overrides
 * must require a reason").
 *
 * Every one of these is a judgement call by a person that overrules the engine, so every
 * one of them carries a written reason into the audit trail. None of them writes state
 * directly: they call the intervention services, which take the same advisory lock the
 * offer machinery takes, so an override cannot race a dispatch or an acknowledgement.
 *
 * Note what is deliberately absent — there is no action here that marks a line assigned,
 * completed or acknowledged on a provider's behalf. Operations can redirect work and stop
 * it; only the provider, through its own portal, reports having done it.
 */

export interface OpsActionResult {
  readonly status: 'ok' | 'error';
  readonly message?: string;
}

async function opsActor(permission: Parameters<typeof can>[1]): Promise<InterventionActor> {
  const actor = await requireActor();
  if (!can(actor, permission)) {
    throw new ApronError('forbidden', 'Your role cannot do that');
  }
  return { userId: actor.userId, role: actor.role, label: actor.userId };
}

function fail(error: unknown, fallback: string): OpsActionResult {
  logError(fallback, error);
  return {
    status: 'error',
    message: error instanceof ApronError ? error.publicMessage : fallback,
  };
}

/** A request detail page and every list that shows its state. */
function revalidateRequest(requestId: string): void {
  revalidatePath(`/ops/requests/${requestId}`);
  revalidatePath('/ops/requests');
  revalidatePath('/ops/exceptions');
  revalidatePath('/ops');
  revalidatePath('/provider');
  revalidatePath('/provider/queue');
  revalidatePath('/client');
}

const reason = z.string().trim().min(3, 'Give a short reason — it is recorded').max(500);

// ---------------------------------------------------------------------------
// override the engine's provider choice
// ---------------------------------------------------------------------------

export async function overrideProviderAction(formData: FormData): Promise<OpsActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'ops/override' }, async () => {
    try {
      const actor = await opsActor('request.override_provider');
      const parsed = z
        .object({
          requestId: z.string().uuid(),
          requestServiceLineId: z.string().uuid(),
          providerCompanyId: z.string().uuid('Choose a provider'),
          reason,
        })
        .safeParse({
          requestId: formData.get('requestId'),
          requestServiceLineId: formData.get('requestServiceLineId'),
          providerCompanyId: formData.get('providerCompanyId'),
          reason: formData.get('reason'),
        });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the override details.',
        };
      }

      await overrideProvider(
        {
          requestServiceLineId: parsed.data.requestServiceLineId,
          providerCompanyId: parsed.data.providerCompanyId,
          reason: parsed.data.reason,
          now: new Date(),
        },
        actor,
      );

      revalidateRequest(parsed.data.requestId);
      return {
        status: 'ok',
        message: 'Offer sent to that provider. Any previous live offer on this service was withdrawn.',
      };
    } catch (error) {
      return fail(error, 'Could not send this service to that provider.');
    }
  });
}

// ---------------------------------------------------------------------------
// cancel the whole request
// ---------------------------------------------------------------------------

export async function cancelRequestAction(formData: FormData): Promise<OpsActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'ops/cancel' }, async () => {
    try {
      const actor = await opsActor('request.cancel');
      const parsed = z
        .object({ requestId: z.string().uuid(), reason })
        .safeParse({ requestId: formData.get('requestId'), reason: formData.get('reason') });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the cancellation details.',
        };
      }

      await cancelRequest({ requestId: parsed.data.requestId, reason: parsed.data.reason }, actor);

      revalidateRequest(parsed.data.requestId);
      return {
        status: 'ok',
        message: 'Request cancelled. Live offers were withdrawn and confirmed assignments released.',
      };
    } catch (error) {
      return fail(error, 'Could not cancel this request.');
    }
  });
}

// ---------------------------------------------------------------------------
// put a failed line back into matching
// ---------------------------------------------------------------------------

export async function retryLineAction(formData: FormData): Promise<OpsActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'ops/retry' }, async () => {
    try {
      const actor = await opsActor('request.update');
      const parsed = z
        .object({
          requestId: z.string().uuid(),
          requestServiceLineId: z.string().uuid(),
          reason,
        })
        .safeParse({
          requestId: formData.get('requestId'),
          requestServiceLineId: formData.get('requestServiceLineId'),
          reason: formData.get('reason'),
        });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the retry details.',
        };
      }

      await retryFailedLine(
        {
          requestServiceLineId: parsed.data.requestServiceLineId,
          reason: parsed.data.reason,
          now: new Date(),
        },
        actor,
      );

      revalidateRequest(parsed.data.requestId);
      return {
        status: 'ok',
        message:
          'Back in matching. Providers that previously declined are still excluded — retry does not re-ask them.',
      };
    } catch (error) {
      return fail(error, 'Could not retry this service.');
    }
  });
}

// ---------------------------------------------------------------------------
// release passenger contacts before acknowledgement
// ---------------------------------------------------------------------------

export async function releaseContactsAction(formData: FormData): Promise<OpsActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'ops/release' }, async () => {
    try {
      const actor = await opsActor('request.release_contacts_to_provider');
      const parsed = z
        .object({
          requestId: z.string().uuid(),
          requestServiceLineId: z.string().uuid(),
          providerCompanyId: z.string().uuid(),
          reason,
        })
        .safeParse({
          requestId: formData.get('requestId'),
          requestServiceLineId: formData.get('requestServiceLineId'),
          providerCompanyId: formData.get('providerCompanyId'),
          reason: formData.get('reason'),
        });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Check the release details.',
        };
      }

      await releaseContactsToProvider(
        {
          requestServiceLineId: parsed.data.requestServiceLineId,
          providerCompanyId: parsed.data.providerCompanyId,
          reason: parsed.data.reason,
        },
        actor,
      );

      revalidateRequest(parsed.data.requestId);
      return {
        status: 'ok',
        message: 'Contacts released. The provider can see them now, and the release is on the record.',
      };
    } catch (error) {
      return fail(error, 'Could not release contact details.');
    }
  });
}
