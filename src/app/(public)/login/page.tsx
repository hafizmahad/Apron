import type { Metadata } from 'next';
import Image from 'next/image';
import { redirect } from 'next/navigation';
import { getActor } from '@/auth/context';
import { ApronMark } from '@/components/ui/domain-icon';
import { backgroundAssets } from '@/lib/assets';
import { homePortal } from '@/domain/permissions';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to Apron.',
};

export const dynamic = 'force-dynamic';

/**
 * The authentication surface.
 *
 * Split layout: the supplied auth background carries the brand on the left, the form sits
 * on a clean surface on the right. The image is decorative and is marked as such, so a
 * screen reader goes straight to the form. On narrow screens the image is dropped
 * entirely rather than squeezed — it would only push the form below the fold.
 */
export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly next?: string }>;
}) {
  const actor = await getActor();
  if (actor !== null) {
    // Already signed in: go where this actor belongs rather than showing a form they
    // cannot use.
    redirect(homePortal(actor));
  }

  const { next } = await searchParams;

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel — hidden below lg, where it would only cost vertical space. */}
      <div className="relative hidden overflow-hidden bg-sidebar lg:block">
        <Image
          src={backgroundAssets.login}
          alt=""
          aria-hidden
          fill
          sizes="55vw"
          priority
          className="object-cover"
        />
        {/*
          Two overlays rather than one flat wash. The photograph is dark already, so
          crushing it uniformly — as the previous 45% opacity plus a heavy gradient did —
          left an expensive image looking like a muddy rectangle.

          The horizontal pass holds contrast for the copy on the LEFT, where the sky is
          open, and releases toward the right so the hangar light survives. The vertical
          pass seats the wordmark at the top and the legal line at the bottom.
        */}
        <div className="absolute inset-0 bg-gradient-to-r from-sidebar-deep/92 via-sidebar-deep/55 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-b from-sidebar-deep/55 via-transparent to-sidebar-deep/75" />

        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-3 text-text-inverse">
            <ApronMark className="h-9 w-12" />
            <div>
              <p className="font-display text-2xl font-semibold leading-none">Apron</p>
              <p className="mt-1.5 text-[11px] uppercase tracking-[0.3em] text-text-inverse-muted">
                Private aviation, simplified
              </p>
            </div>
          </div>

          <div className="max-w-md">
            <p className="font-display text-[28px] leading-snug text-text-inverse">
              One sentence in. A coordinated arrival out.
            </p>
            <p className="mt-4 text-sm leading-relaxed text-text-inverse-muted">
              Apron turns a request into structured operational data, finds the providers
              who can genuinely cover each service in the window, and coordinates
              fulfilment across operations, providers and clients.
            </p>
          </div>

          <p className="text-[11px] text-text-inverse-muted">
            Authorised users only. Activity is logged.
          </p>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <ApronMark className="h-8 w-11 text-text-primary" />
            <p className="font-display text-xl font-semibold text-text-primary">Apron</p>
          </div>

          <h1 className="font-display text-[26px] leading-tight text-text-primary">Sign in</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
            Operations, provider and administration portals.
          </p>

          <div className="mt-8">
            <LoginForm {...(next === undefined ? {} : { next })} />
          </div>

        </div>
      </div>
    </main>
  );
}
