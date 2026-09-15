import Link from 'next/link';
import { Badge, Card, CardHeader, type BadgeTone } from '@/components/ui/primitives';
import { RecordForm, type RecordFieldSpec } from '@/components/ui/action-controls';
import { openThreadAction } from '@/app/messages/actions';
import { loadThreadsForRequest, threadTargetsForRequest } from '@/services/messaging';
import { requireSession } from '@/auth/context';
import type { ThreadScope } from '@/db/schema/enums';

/**
 * The conversations attached to one request, on the Operations request page (§12, §18).
 *
 * Operations can open two kinds: an **internal** note the provider never sees, and a
 * conversation **with one provider**. The distinction is the whole point — an internal
 * remark about a provider's reliability must not be one mis-click from reaching them, so
 * the two are separate threads with separate visibility, not one thread with a flag.
 */

const SCOPE_TONE: Record<ThreadScope, BadgeTone> = {
  internal: 'neutral',
  provider: 'accent',
  client: 'gold',
};

const SCOPE_LABEL: Record<ThreadScope, string> = {
  internal: 'internal only',
  provider: 'with provider',
  client: 'with client',
};

export async function RequestThreads({
  requestId,
  canOpen,
}: {
  readonly requestId: string;
  readonly canOpen: boolean;
}) {
  const user = (await requireSession()).user;
  const actor = {
    userId: user.userId,
    role: user.role,
    label: user.fullName,
    providerCompanyId: user.providerCompanyId ?? null,
    clientOrganizationId: user.clientOrganizationId ?? null,
  };

  const [threads, targets] = await Promise.all([
    loadThreadsForRequest(requestId, actor),
    canOpen ? threadTargetsForRequest(requestId) : Promise.resolve([]),
  ]);

  const fields: readonly RecordFieldSpec[] = [
    {
      name: 'scope',
      label: 'Who can see this',
      type: 'select',
      required: true,
      defaultValue: 'internal',
      wide: true,
      options: [
        { value: 'internal', label: 'Internal only — operations and admin' },
        ...(targets.length > 0
          ? [{ value: 'provider', label: 'With a provider — they can read and reply' }]
          : []),
      ],
      hint:
        targets.length === 0
          ? 'No provider holds work on this request yet, so there is nobody to talk to outside operations.'
          : 'An internal note is never visible to a provider or a client.',
    },
    ...(targets.length > 0
      ? ([
          {
            name: 'providerCompanyId',
            label: 'Provider',
            type: 'select',
            defaultValue: '',
            wide: true,
            options: [
              { value: '', label: 'not applicable for an internal note' },
              ...targets.map((target) => ({
                value: target.providerCompanyId,
                label: target.displayName,
              })),
            ],
            hint: 'Only companies currently holding an offer or an acknowledged service.',
          },
        ] satisfies readonly RecordFieldSpec[])
      : []),
    {
      name: 'subject',
      label: 'Subject',
      type: 'text',
      wide: true,
      placeholder: 'Late arrival — revised pickup',
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Conversations"
        description="Attached to this request, so the context travels with it."
      />

      {threads.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-text-secondary">
          Nothing opened yet.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {threads.map((thread) => (
            <li key={thread.id}>
              <Link
                href={`/ops/messages/${thread.id}`}
                className="block px-5 py-3 transition-colors hover:bg-canvas-cool"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={SCOPE_TONE[thread.scope]}>{SCOPE_LABEL[thread.scope]}</Badge>
                    {thread.providerName !== null && (
                      <span className="text-[12px] text-text-secondary">{thread.providerName}</span>
                    )}
                  </span>
                  <span className="tabular shrink-0 text-[11px] text-text-secondary">
                    {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}
                  </span>
                </div>
                {thread.subject !== '' && (
                  <p className="mt-1 text-[13px] font-medium text-text-primary">{thread.subject}</p>
                )}
                <p className="mt-0.5 line-clamp-1 text-[12px] text-text-secondary">
                  {thread.lastMessagePreview ?? 'Nothing said yet.'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {canOpen && (
        <div className="border-t border-border px-5 py-4">
          <RecordForm
            action={openThreadAction}
            fields={fields}
            hiddenFields={{ requestId }}
            trigger="Open a conversation"
            title="New conversation"
            description="Opening the same kind twice reuses the existing one rather than splitting the history."
            submitLabel="Open conversation"
          />
        </div>
      )}
    </Card>
  );
}
