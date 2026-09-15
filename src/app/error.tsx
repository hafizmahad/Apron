'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/primitives';

/**
 * The application error boundary (CLAUDE.md §21, §28).
 *
 * Without this, a thrown `ApronError` — including an ordinary authorisation refusal —
 * renders as a bare 500 with a framework stack. That is both a poor experience and
 * actively misleading: "you do not have permission" is not a server fault.
 *
 * Next only gives the client the error's `digest`, never its message, which is correct:
 * the message could carry internal detail. The digest is shown so a support request can
 * be tied to the exact server log line, which already holds the full cause and the
 * correlation id.
 */
export default function ApplicationError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    // Surfaces in the browser console for a developer; the server has already logged the
    // real cause with its correlation id.
    console.error('Apron application error', error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col justify-center px-6 py-16">
      <div className="rounded-lg border border-border bg-surface p-8 shadow-card">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-secondary">
          Something went wrong
        </p>
        <h1 className="mt-2 font-display text-2xl leading-tight text-text-primary">
          We could not load this page
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-text-secondary">
          The problem has been recorded with full detail. If it keeps happening, quote the
          reference below.
        </p>

        {error.digest !== undefined && (
          <p className="mt-4 rounded-md bg-canvas-cool px-3 py-2 font-mono text-[12px] text-text-secondary">
            Reference: {error.digest}
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={reset}>Try again</Button>
          <Link href="/">
            <Button variant="secondary">Back to start</Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
