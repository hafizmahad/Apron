import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, CardHeader, EmptyState, PageHeader, type BadgeTone } from '@/components/ui/primitives';
import { ThreadView } from '@/components/messages/thread-view';
import { loadThread, loadThreads, type ThreadActor } from '@/services/messaging';
import { requireSession } from '@/auth/context';
import type { ThreadScope } from '@/db/schema/enums';

/**
 * The messages surfaces, shared by Operations and the Provider Portal (CLAUDE.md §18).
 *
 * One implementation, two mount points. The visibility filter lives in the service, so
 * neither page decides who sees what — mounting the same component under `/provider`
 * cannot accidentally widen a provider's view.
 */

const SCOPE_TONE: Record<ThreadScope, BadgeTone> = {
  internal: 'neutral',
  provider: 'accent',
  client: 'gold',
};

const SCOPE_LABEL: Record<ThreadScope, string> = {
  internal: 'internal',
  provider: 'with provider',
  client: 'with client',
};

async function actorFromSession(): Promise<{ actor: ThreadActor; fullName: string }> {
  const user = (await requireSession()).user;
  return {
    fullName: user.fullName,
    actor: {
      userId: user.userId,
      role: user.role,
      label: user.fullName,
      providerCompanyId: user.providerCompanyId ?? null,
      clientOrganizationId: user.clientOrganizationId ?? null,
    },
  };
}

function formatInstant(value: Date | null): string {
  return value === null ? '—' : `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export async function ThreadListPage({ basePath }: { readonly basePath: '/ops/messages' | '/provider/messages' }) {
  const { actor } = await actorFromSession();
  const threads = await loadThreads(actor);

  const isProvider = basePath === '/provider/messages';

  return (
    <>
      <PageHeader
        eyebrow={isProvider ? 'Provider' : 'Tools'}
        title="Messages"
        description={
          isProvider
            ? 'Your conversations with operations, one per request. You see only threads involving your own company.'
            : 'Conversations attached to requests — internal, with a provider, or with a client. Newest activity first.'
        }
      />

      <Card>
        <CardHeader
          title={`${String(threads.length)} conversation${threads.length === 1 ? '' : 's'}`}
          description="A conversation belongs to a request, so its context is never lost."
        />

        {threads.length === 0 ? (
          <EmptyState
            title="No conversations yet"
            description={
              isProvider
                ? 'Operations can start a conversation with you about any request you are working on. It will appear here.'
                : 'Open a conversation from a request to talk to a provider, or to leave an internal note the provider never sees.'
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {threads.map((thread) => (
              <li key={thread.id}>
                <Link
                  href={`${basePath}/${thread.id}`}
                  className="block px-5 py-4 transition-colors hover:bg-canvas-cool"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text-primary">{thread.reference}</span>
                      <Badge tone={SCOPE_TONE[thread.scope]}>{SCOPE_LABEL[thread.scope]}</Badge>
                      {thread.providerName !== null && !isProvider && (
                        <span className="text-[12px] text-text-secondary">
                          {thread.providerName}
                        </span>
                      )}
                      {thread.serviceName !== null && (
                        <span className="text-[12px] text-text-secondary">
                          · {thread.serviceName}
                        </span>
                      )}
                      {thread.closedAt !== null && <Badge tone="neutral">closed</Badge>}
                    </span>
                    <span className="tabular shrink-0 text-[11px] text-text-secondary">
                      {formatInstant(thread.lastMessageAt)}
                    </span>
                  </div>

                  {thread.subject !== '' && (
                    <p className="mt-1 text-[13px] font-medium text-text-primary">{thread.subject}</p>
                  )}

                  <p className="mt-1 line-clamp-2 text-[13px] text-text-secondary">
                    {thread.lastMessagePreview ?? 'Nothing has been said yet.'}
                  </p>

                  <p className="tabular mt-1 text-[11px] text-text-secondary">
                    {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

export async function ThreadDetailPage({
  threadId,
  basePath,
}: {
  readonly threadId: string;
  readonly basePath: '/ops/messages' | '/provider/messages';
}) {
  const { actor, fullName } = await actorFromSession();
  const thread = await loadThread(threadId, actor);

  // Null covers both "no such thread" and "not yours". Deliberately indistinguishable:
  // a 403 on a real id would confirm the id exists.
  if (thread === null) notFound();

  const isProvider = basePath === '/provider/messages';

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link href={basePath} className="hover:text-text-primary">
              Messages
            </Link>{' '}
            · {thread.reference}
          </>
        }
        title={thread.subject === '' ? `${SCOPE_LABEL[thread.scope]} conversation` : thread.subject}
        description={
          thread.serviceName === null
            ? `Attached to request ${thread.reference}.`
            : `Attached to ${thread.serviceName} on request ${thread.reference}.`
        }
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={SCOPE_TONE[thread.scope]}>{SCOPE_LABEL[thread.scope]}</Badge>
            {thread.providerName !== null && !isProvider && (
              <Badge tone="neutral">{thread.providerName}</Badge>
            )}
          </div>
        }
      />

      {!isProvider && (
        <p className="mb-4 text-[13px]">
          <Link href={`/ops/requests/${thread.requestId}`} className="text-accent hover:underline">
            Open the request →
          </Link>
        </p>
      )}

      <Card>
        <ThreadView
          threadId={thread.id}
          canPost={thread.canPost}
          closed={thread.closedAt !== null}
          currentUserLabel={fullName}
          messages={thread.messages.map((message) => ({
            id: message.id,
            body: message.body,
            isSystem: message.isSystem,
            authorLabel: message.authorLabel,
            authorName: message.authorName,
            authorRole: message.authorRole,
            createdAt: formatInstant(message.createdAt),
          }))}
        />
      </Card>
    </>
  );
}
