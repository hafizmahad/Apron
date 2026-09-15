'use server';

import '@/lib/server-guard';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor, requireSession } from '@/auth/context';
import { can } from '@/domain/permissions';
import { ensureThread, postMessage, type ThreadActor } from '@/services/messaging';
import { ApronError } from '@/lib/errors';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';

/**
 * Message thread actions (CLAUDE.md §18, §5).
 *
 * Two layers, and both are needed:
 *
 *  - the **permission** decides whether this role may post at all;
 *  - the **service** decides whether this actor may post into *this* thread, by re-reading
 *    it under the same visibility filter used for reads.
 *
 * A provider dispatcher holds the send permission and is still refused on another
 * company's thread — capability and tenancy are separate questions.
 */

export interface MessageActionResult {
  readonly status: 'ok' | 'error';
  readonly message?: string;
}

async function threadActor(): Promise<ThreadActor> {
  // The session, not just the actor: a message needs a human name on it, and the actor
  // record deliberately carries only what authorisation depends on.
  const actor = (await requireSession()).user;

  // Either permission is enough to post: operations hold the internal one, provider users
  // the thread one. The service still decides which threads that means.
  if (!can(actor, 'message.send.internal') && !can(actor, 'message.send.provider_thread')) {
    throw new ApronError('forbidden', 'Your role cannot post messages');
  }

  return {
    userId: actor.userId,
    role: actor.role,
    label: actor.fullName,
    providerCompanyId: actor.providerCompanyId ?? null,
    clientOrganizationId: actor.clientOrganizationId ?? null,
  };
}

function fail(error: unknown, fallback: string): MessageActionResult {
  logError(fallback, error);
  return {
    status: 'error',
    message: error instanceof ApronError ? error.publicMessage : fallback,
  };
}

export async function postMessageAction(formData: FormData): Promise<MessageActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'messages/post' }, async () => {
    try {
      const actor = await threadActor();
      const parsed = z
        .object({
          threadId: z.string().uuid(),
          body: z.string().trim().min(1, 'Write something first').max(4000),
        })
        .safeParse({ threadId: formData.get('threadId'), body: formData.get('body') });

      if (!parsed.success) {
        return {
          status: 'error',
          message: parsed.error.issues[0]?.message ?? 'That message could not be sent.',
        };
      }

      await postMessage({ threadId: parsed.data.threadId, body: parsed.data.body }, actor);

      for (const path of [
        '/ops/messages',
        `/ops/messages/${parsed.data.threadId}`,
        '/provider/messages',
        `/provider/messages/${parsed.data.threadId}`,
      ]) {
        revalidatePath(path);
      }

      return { status: 'ok', message: 'Sent.' };
    } catch (error) {
      return fail(error, 'That message could not be sent.');
    }
  });
}

/**
 * Opens a thread on a request — internal, or with one provider.
 *
 * Operations only: a provider does not start conversations, it answers them. Idempotent,
 * because `ensureThread` returns the existing thread rather than creating a second one.
 */
export async function openThreadAction(formData: FormData): Promise<MessageActionResult> {
  return withCorrelation({ correlationId: newCorrelationId(), route: 'messages/open' }, async () => {
    try {
      const actor = await requireActor();
      if (!can(actor, 'message.send.internal')) {
        throw new ApronError('forbidden', 'Your role cannot open a conversation');
      }

      const parsed = z
        .object({
          requestId: z.string().uuid(),
          scope: z.enum(['internal', 'provider']),
          providerCompanyId: z.string().uuid().optional(),
          subject: z.string().trim().max(200).optional(),
        })
        .safeParse({
          requestId: formData.get('requestId'),
          scope: formData.get('scope'),
          providerCompanyId: emptyToUndefined(formData.get('providerCompanyId')),
          subject: emptyToUndefined(formData.get('subject')),
        });

      if (!parsed.success) {
        return { status: 'error', message: 'That conversation could not be opened.' };
      }

      if (parsed.data.scope === 'provider' && parsed.data.providerCompanyId === undefined) {
        return { status: 'error', message: 'Choose which provider this conversation is with.' };
      }

      await ensureThread({
        requestId: parsed.data.requestId,
        scope: parsed.data.scope,
        providerCompanyId: parsed.data.providerCompanyId ?? null,
        ...(parsed.data.subject === undefined ? {} : { subject: parsed.data.subject }),
      });

      revalidatePath(`/ops/requests/${parsed.data.requestId}`);
      revalidatePath('/ops/messages');
      revalidatePath('/provider/messages');

      return { status: 'ok', message: 'Conversation opened.' };
    } catch (error) {
      return fail(error, 'That conversation could not be opened.');
    }
  });
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
