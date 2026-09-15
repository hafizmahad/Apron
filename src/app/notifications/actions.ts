'use server';

import '@/lib/server-guard';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireActor } from '@/auth/context';
import { markAllNotificationsRead, markNotificationRead } from '@/services/notifications';
import { logError, newCorrelationId, withCorrelation } from '@/lib/logging';

/**
 * Notification centre actions (CLAUDE.md §18).
 *
 * Both are scoped to the signed-in user inside the service, by adding `user_id` to the
 * WHERE clause rather than by checking ownership first and then updating. A notification
 * belonging to someone else therefore matches nothing and changes nothing — there is no
 * window between the check and the write, and no id to guess that would help.
 */

export interface NotificationActionResult {
  readonly status: 'ok' | 'error';
  readonly message?: string;
}

function revalidateAll(): void {
  for (const path of ['/ops/notifications', '/provider/notifications', '/admin/notifications']) {
    revalidatePath(path);
  }
}

export async function markReadAction(formData: FormData): Promise<NotificationActionResult> {
  return withCorrelation(
    { correlationId: newCorrelationId(), route: 'notifications/read' },
    async () => {
      try {
        const actor = await requireActor();
        const parsed = z
          .object({ notificationId: z.string().uuid() })
          .safeParse({ notificationId: formData.get('notificationId') });

        if (!parsed.success) {
          return { status: 'error', message: 'That notification was not identified.' };
        }

        await markNotificationRead(parsed.data.notificationId, actor.userId);
        revalidateAll();
        return { status: 'ok' };
      } catch (error) {
        logError('could not mark notification read', error);
        return { status: 'error', message: 'Could not mark that as read.' };
      }
    },
  );
}

// The unused FormData keeps the signature identical to every other action control, so the
// same button component drives it.
export async function markAllReadAction(_formData: FormData): Promise<NotificationActionResult> {
  return withCorrelation(
    { correlationId: newCorrelationId(), route: 'notifications/read-all' },
    async () => {
      try {
        const actor = await requireActor();
        const count = await markAllNotificationsRead(actor.userId);
        revalidateAll();
        return {
          status: 'ok',
          message: count === 0 ? 'Nothing was unread.' : `${String(count)} marked as read.`,
        };
      } catch (error) {
        logError('could not mark notifications read', error);
        return { status: 'error', message: 'Could not mark those as read.' };
      }
    },
  );
}
