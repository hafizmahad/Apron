import Link from 'next/link';
import { Badge, Card, CardHeader, EmptyState, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { ActionButton } from '@/components/ui/action-controls';
import { markAllReadAction, markReadAction } from '@/app/notifications/actions';
import { loadNotifications } from '@/services/notifications';
import type { NotificationSeverity } from '@/db/schema/enums';
import { requireActor } from '@/auth/context';

/**
 * The notification centre (CLAUDE.md §18).
 *
 * One component serves all three portals; the route differs only so the surrounding shell
 * is the one the reader is already in. Rows are scoped to the signed-in user by the query
 * itself — there is no "show me someone else's" parameter to get wrong.
 *
 * Each entry links back to the thing it is about, because a notification that cannot be
 * acted on is just noise.
 */

const SEVERITY_TONE: Record<NotificationSeverity, BadgeTone> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
};

/** Where a notification points, by the entity it names. */
function destinationFor(
  portal: 'ops' | 'provider' | 'admin',
  entityType: string | null,
  entityId: string | null,
): string | null {
  if (entityId === null) return null;

  // A provider never sees the operations request page, and would be refused if they tried.
  if (portal === 'provider') {
    return entityType === 'provider_offer' ? '/provider/queue' : '/provider';
  }

  switch (entityType) {
    case 'request':
      return `/ops/requests/${entityId}`;
    case 'request_service_line':
    case 'provider_offer':
      // The line and offer pages are sections of the request page, so the request is the
      // honest destination rather than a deep link that does not exist.
      return '/ops/requests';
    default:
      return null;
  }
}

export async function NotificationCentre({
  portal,
}: {
  readonly portal: 'ops' | 'provider' | 'admin';
}) {
  const actor = await requireActor();
  const rows = await loadNotifications(actor.userId, { limit: 100 });
  const unread = rows.filter((row) => row.readAt === null);

  return (
    <>
      <PageHeader
        eyebrow="Notifications"
        title={unread.length === 0 ? 'Nothing unread' : `${String(unread.length)} unread`}
        description="Offers, acknowledgements, declines, timeouts, overrides and cancellations — everything the platform did that you may need to act on."
        actions={
          unread.length > 0 ? (
            <ActionButton
              action={markAllReadAction}
              fields={{}}
              label="Mark all as read"
              pendingLabel="Marking…"
            />
          ) : undefined
        }
      />

      <Card>
        <CardHeader
          title={`${String(rows.length)} in the last 100`}
          description="Newest first. An entry stays here whether or not its email ever left the building."
        />

        {rows.length === 0 ? (
          <EmptyState
            title="No notifications yet"
            description="You will be told here when an offer arrives, a provider answers, a deadline passes or operations intervenes."
          />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => {
              const href = destinationFor(portal, row.entityType, row.entityId);

              return (
                <li
                  key={row.id}
                  className={row.readAt === null ? 'bg-accent-wash/30 px-5 py-4' : 'px-5 py-4'}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={SEVERITY_TONE[row.severity]}>
                          {row.kind.replace(/[._]/g, ' ')}
                        </Badge>
                        {row.readAt === null && (
                          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-accent">
                            unread
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 text-[14px] font-medium text-text-primary">
                        {row.title}
                      </p>
                      <p className="mt-0.5 text-[13px] leading-relaxed text-text-secondary">
                        {row.body}
                      </p>
                      <p className="tabular mt-1 text-[11px] text-text-secondary">
                        {row.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {href !== null && (
                        <Link
                          href={href}
                          className="text-[13px] font-medium text-accent hover:underline"
                        >
                          Open
                        </Link>
                      )}
                      {row.readAt === null && (
                        <ActionButton
                          action={markReadAction}
                          fields={{ notificationId: row.id }}
                          label="Mark read"
                          pendingLabel="Marking…"
                          variant="ghost"
                        />
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
