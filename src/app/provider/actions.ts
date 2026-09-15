'use server';

import '@/lib/server-guard';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor } from '@/auth/context';
import { canActOnOffer, canAssignResources } from '@/domain/permissions';
import { acknowledgeOffer, declineOffer } from '@/services/offers';
import { createAssignment, releaseAssignment } from '@/services/assignments';
import { loadOffer } from '@/db/queries/provider-queue';
import { ApronError } from '@/lib/errors';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';
import type { ResourceKind } from '@/db/schema/enums';

/**
 * Provider Portal actions (CLAUDE.md §13).
 *
 * Each one performs BOTH checks before doing anything:
 *   - the capability check (`canActOnOffer`, `canAssignResources`) — may this ROLE?
 *   - the tenancy check — is this the actor's OWN company's work?
 *
 * The tenancy check is done by loading the offer scoped to the actor's company: another
 * company's offer simply is not found, so there is no id to act on. That is stronger than
 * fetching then comparing, because there is no window in which the wrong row is in hand.
 */

export interface ActionResult {
  readonly status: 'ok' | 'error';
  readonly message?: string;
}

const acknowledgeSchema = z.object({ offerId: z.string().uuid() });

export async function acknowledgeOfferAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'provider/acknowledge' }, async () => {
    try {
      const actor = await requireActor();
      const parsed = acknowledgeSchema.safeParse({ offerId: formData.get('offerId') });
      if (!parsed.success) return { status: 'error', message: 'That offer could not be identified.' };

      if (actor.providerCompanyId === null) {
        throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
      }
      if (!canActOnOffer(actor, 'acknowledge', actor.providerCompanyId)) {
        throw new ApronError('forbidden', 'Your role cannot acknowledge offers');
      }

      // Scoped load: another company's offer is not found, not merely rejected.
      const offer = await loadOffer(actor.providerCompanyId, parsed.data.offerId);
      if (offer === null) {
        throw new ApronError('not_found', 'That offer is no longer in your queue');
      }

      await acknowledgeOffer({
        offerId: offer.offerId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.userId,
        providerCompanyId: actor.providerCompanyId,
        now: new Date(),
      });

      revalidatePath('/provider');
      revalidatePath('/provider/queue');
      return { status: 'ok' };
    } catch (error) {
      logError('acknowledge failed', error);
      return {
        status: 'error',
        message: error instanceof ApronError ? error.publicMessage : 'Could not accept this offer.',
      };
    }
  });
}

const declineSchema = z.object({
  offerId: z.string().uuid(),
  reason: z.string().trim().min(3, 'Tell us briefly why').max(500),
});

export async function declineOfferAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'provider/decline' }, async () => {
    try {
      const actor = await requireActor();
      const parsed = declineSchema.safeParse({
        offerId: formData.get('offerId'),
        reason: formData.get('reason'),
      });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Add a short reason before declining.',
        };
      }

      if (actor.providerCompanyId === null) {
        throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
      }
      if (!canActOnOffer(actor, 'decline', actor.providerCompanyId)) {
        throw new ApronError('forbidden', 'Your role cannot decline offers');
      }

      const offer = await loadOffer(actor.providerCompanyId, parsed.data.offerId);
      if (offer === null) {
        throw new ApronError('not_found', 'That offer is no longer in your queue');
      }

      await declineOffer({
        offerId: offer.offerId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.userId,
        providerCompanyId: actor.providerCompanyId,
        now: new Date(),
        reason: parsed.data.reason,
      });

      revalidatePath('/provider');
      revalidatePath('/provider/queue');
      return { status: 'ok' };
    } catch (error) {
      logError('decline failed', error);
      return {
        status: 'error',
        message: error instanceof ApronError ? error.publicMessage : 'Could not decline this offer.',
      };
    }
  });
}

const assignSchema = z.object({
  requestServiceLineId: z.string().uuid(),
  startUtc: z.string().datetime(),
  endUtc: z.string().datetime(),
  /** `kind:id` pairs from the checkbox group. */
  resources: z.array(z.string().min(3)).min(1, 'Choose at least one resource'),
});

export async function assignResourcesAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'provider/assign' }, async () => {
    try {
      const actor = await requireActor();

      const parsed = assignSchema.safeParse({
        requestServiceLineId: formData.get('requestServiceLineId'),
        startUtc: formData.get('startUtc'),
        endUtc: formData.get('endUtc'),
        resources: formData.getAll('resource').map(String),
      });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Choose the resources to assign.',
        };
      }

      if (actor.providerCompanyId === null) {
        throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
      }
      if (!canAssignResources(actor, actor.providerCompanyId)) {
        throw new ApronError('forbidden', 'Your role cannot assign resources');
      }

      const resources = parsed.data.resources.map((entry) => {
        const [kind, resourceId] = entry.split(':');
        if (kind === undefined || resourceId === undefined) {
          throw new ApronError('validation_failed', 'A selected resource was not recognised');
        }
        return { kind: kind as ResourceKind, resourceId };
      });

      // `createAssignment` re-verifies that this company holds the acknowledged offer for
      // the line, so a tampered line id cannot be assigned against.
      await createAssignment({
        requestServiceLineId: parsed.data.requestServiceLineId,
        providerCompanyId: actor.providerCompanyId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.userId,
        startUtc: new Date(parsed.data.startUtc),
        endUtc: new Date(parsed.data.endUtc),
        resources,
      });

      revalidatePath('/provider');
      revalidatePath('/provider/queue');
      revalidatePath('/provider/schedule');
      return { status: 'ok' };
    } catch (error) {
      logError('assignment failed', error);
      return {
        status: 'error',
        // A resource conflict carries a specific, actionable message — surface it as-is.
        message:
          error instanceof ApronError
            ? error.publicMessage
            : 'Could not assign those resources. Try again.',
      };
    }
  });
}

const releaseSchema = z.object({
  assignmentId: z.string().uuid(),
  reason: z.string().trim().min(3, 'Give a short reason').max(500),
});

export async function releaseAssignmentAction(formData: FormData): Promise<ActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'provider/release' }, async () => {
    try {
      const actor = await requireActor();
      const parsed = releaseSchema.safeParse({
        assignmentId: formData.get('assignmentId'),
        reason: formData.get('reason'),
      });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'Give a reason before releasing.',
        };
      }

      if (actor.providerCompanyId === null) {
        throw new ApronError('tenant_mismatch', 'This account is not linked to a provider company');
      }
      if (!canAssignResources(actor, actor.providerCompanyId)) {
        throw new ApronError('forbidden', 'Your role cannot release assignments');
      }

      await releaseAssignment({
        assignmentId: parsed.data.assignmentId,
        providerCompanyId: actor.providerCompanyId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorLabel: actor.userId,
        reason: parsed.data.reason,
      });

      revalidatePath('/provider');
      revalidatePath('/provider/schedule');
      return { status: 'ok' };
    } catch (error) {
      logError('release failed', error);
      return {
        status: 'error',
        message:
          error instanceof ApronError ? error.publicMessage : 'Could not release that assignment.',
      };
    }
  });
}
