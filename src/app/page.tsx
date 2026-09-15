import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActor } from '@/auth/context';
import { ApronMark } from '@/components/ui/domain-icon';
import { Button } from '@/components/ui/primitives';
import { homePortal } from '@/domain/permissions';

export const dynamic = 'force-dynamic';

/**
 * The public entry point.
 *
 * A signed-in visitor is sent straight to their own portal — arriving at `/` with a live
 * session and being shown a marketing page is a dead end, not a landing. Anonymous
 * visitors get the sign-in route.
 */
export default async function HomePage() {
  const actor = await getActor();
  if (actor !== null) {
    redirect(homePortal(actor));
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div className="flex items-center gap-3 text-text-primary">
        <ApronMark className="h-8 w-11" />
        <div>
          <p className="font-display text-2xl font-semibold leading-none">Apron</p>
          <p className="mt-1 text-[11px] uppercase tracking-[0.28em] text-text-secondary">
            Private aviation, simplified
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface p-8 shadow-card">
        <h1 className="font-display text-3xl leading-tight text-text-primary">
          Ground services coordination
        </h1>
        <p className="mt-3 max-w-prose text-text-secondary">
          Apron turns one sentence about an arrival into structured operational data,
          resolves the real airport and FBO records, determines which approved providers
          can actually cover each service in the requested window, and coordinates
          fulfilment across operations, providers and clients.
        </p>

        <dl className="mt-8 grid gap-4 sm:grid-cols-3">
          {[
            { term: 'Operations', detail: 'Dispatch, matching, exceptions, decision trace' },
            { term: 'Providers', detail: 'Acknowledge, assign vehicles, drivers and officers' },
            { term: 'Admin', detail: 'Approvals, catalogue, registry, audit, AI reliability' },
          ].map((item) => (
            <div key={item.term} className="rounded-md border border-border bg-canvas-cool p-4">
              <dt className="text-sm font-semibold text-text-primary">{item.term}</dt>
              <dd className="mt-1 text-[13px] leading-relaxed text-text-secondary">
                {item.detail}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/login">
            <Button size="lg">Sign in</Button>
          </Link>
          <Link
            className="text-sm font-medium text-text-secondary underline underline-offset-4 hover:text-text-primary"
            href="/api/health"
          >
            Platform health
          </Link>
        </div>
      </div>
    </main>
  );
}
