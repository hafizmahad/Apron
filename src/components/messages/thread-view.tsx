'use client';

import { useState, useTransition } from 'react';
import { userRoleLabel } from '@/lib/domain-labels';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { postMessageAction } from '@/app/messages/actions';
import { cn } from '@/lib/cn';

/**
 * A message thread and its composer (CLAUDE.md §18, §21).
 *
 * System entries are rendered differently from prose, because "the offer expired and this
 * re-matched" is the platform narrating itself, not a person speaking. Conflating the two
 * would let a dispatcher read a lifecycle event as a colleague's instruction.
 *
 * The composer is hidden — not merely disabled — when this actor may read but not post.
 * A disabled box invites a fight with the UI; its absence states the position.
 */

export interface ThreadMessageView {
  readonly id: string;
  readonly body: string;
  readonly isSystem: boolean;
  readonly authorLabel: string;
  readonly authorName: string | null;
  readonly authorRole: string | null;
  readonly createdAt: string;
}

export function ThreadView({
  threadId,
  messages,
  canPost,
  closed,
  currentUserLabel,
}: {
  readonly threadId: string;
  readonly messages: readonly ThreadMessageView[];
  readonly canPost: boolean;
  readonly closed: boolean;
  readonly currentUserLabel: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');

  return (
    <div>
      {messages.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-text-secondary">
          Nothing has been said yet.
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {messages.map((message) => {
            const mine = !message.isSystem && message.authorName === currentUserLabel;

            return (
              <li
                key={message.id}
                className={cn('px-5 py-4', message.isSystem && 'bg-canvas-cool')}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
                    {message.isSystem ? (
                      <Badge tone="neutral">Apron</Badge>
                    ) : (
                      <>
                        {message.authorName ?? message.authorLabel}
                        {mine && <span className="text-[11px] text-text-secondary">(you)</span>}
                        {message.authorRole !== null && (
                          <span className="text-[11px] text-text-secondary">
                            {userRoleLabel(message.authorRole)}
                          </span>
                        )}
                      </>
                    )}
                  </span>
                  <time className="tabular shrink-0 text-[11px] text-text-secondary">
                    {message.createdAt}
                  </time>
                </div>
                <p
                  className={cn(
                    'mt-1 whitespace-pre-wrap text-[13px] leading-relaxed',
                    message.isSystem ? 'text-text-secondary' : 'text-text-primary',
                  )}
                >
                  {message.body}
                </p>
              </li>
            );
          })}
        </ol>
      )}

      {closed ? (
        <div className="border-t border-border px-5 py-4">
          <Alert tone="info">This conversation is closed. The history above is kept in full.</Alert>
        </div>
      ) : canPost ? (
        <form
          className="border-t border-border bg-canvas-cool px-5 py-4"
          action={(data) => {
            data.set('threadId', threadId);
            setError(null);
            startTransition(async () => {
              const result = await postMessageAction(data);
              if (result.status === 'error') {
                setError(result.message ?? 'That message could not be sent.');
                return;
              }
              setBody('');
            });
          }}
        >
          <label htmlFor={`message-${threadId}`} className="sr-only">
            Write a message
          </label>
          <textarea
            id={`message-${threadId}`}
            name="body"
            rows={3}
            required
            maxLength={4000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Write a message…"
            className="block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary placeholder:text-text-secondary/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          />

          {error !== null && (
            <div className="mt-2">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] text-text-secondary">
              Everyone on this conversation sees it, and it is kept with the request.
            </p>
            <Button type="submit" variant="primary" size="sm" disabled={pending || body.trim() === ''}>
              {pending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="border-t border-border px-5 py-3">
          <p className="text-[12px] text-text-secondary">
            You can read this conversation but not post to it.
          </p>
        </div>
      )}
    </div>
  );
}
