import { eq } from 'drizzle-orm';
import Image from 'next/image';
import { redirect } from 'next/navigation';
import { requireSession } from '@/auth/context';
import { homePortal } from '@/domain/permissions';
import { ClientHeader } from '@/components/layout/client-header';
import { RequestComposer } from '@/components/requests/request-composer';
import { getDb } from '@/db/client';
import { clientOrganizations } from '@/db/schema';
import { listActiveServiceCategories } from '@/domain/services/resolve';
import { loadClientRequests } from '@/db/queries/client-requests';
import { ClientRequestList } from '@/components/requests/client-request-list';
import { backgroundAssets, serviceIconFor, serviceImageFor } from '@/lib/assets';

export const dynamic = 'force-dynamic';

/**
 * The client request composer (CLAUDE.md §1, §8).
 *
 * One sentence in, an editable structured read-back out. The service list is read from
 * the live catalogue rather than hard-coded, so a category an admin adds appears here
 * immediately (ADR-008).
 */
export default async function ClientHomePage() {
  const session = await requireSession();
  const actor = session.user;

  if (actor.clientOrganizationId === null) {
    // Reached when a NON-client lands here: the App Router renders the layout and the page
    // in parallel, so this runs even though the layout is already redirecting them away.
    // The end state was always correct — a 307 to their own portal — but throwing logged a
    // misleading internal error on every one of those redirects. Redirecting agrees with
    // the layout instead of fighting it.
    redirect(homePortal(actor));
  }

  const db = getDb();
  const [organization] = await db
    .select({ id: clientOrganizations.id, name: clientOrganizations.name })
    .from(clientOrganizations)
    .where(eq(clientOrganizations.id, actor.clientOrganizationId))
    .limit(1);

  const categories = await listActiveServiceCategories();

  // Their own requests, newest arrival first. Scoped by organisation in the query itself.
  const requests = await loadClientRequests(actor.clientOrganizationId, { limit: 25 });

  return (
    <>
      <ClientHeader user={actor} organizationName={organization?.name ?? 'Your organisation'} />

      <main className="mx-auto w-full max-w-5xl px-5 pb-16 sm:px-8">
        {/* Hero */}
        <section className="relative mt-8 overflow-hidden rounded-lg border border-border">
          <Image
            src={backgroundAssets.clientHero}
            alt=""
            aria-hidden
            width={1600}
            height={600}
            priority
            className="h-60 w-full object-cover sm:h-80"
          />
          {/*
            Weighted to the left, where the copy sits, and released on the right so the
            sunrise survives. A flat wash across a bright photograph reads as a mistake.
          */}
          <div className="absolute inset-0 bg-gradient-to-r from-sidebar-deep/94 via-sidebar-deep/62 to-sidebar-deep/10" />
          <div className="absolute inset-0 flex flex-col justify-center gap-3 p-7 sm:p-10">
            <p className="text-[11px] uppercase tracking-[0.24em] text-text-inverse-muted">
              {organization?.name ?? 'Your organisation'}
            </p>
            <h1 className="max-w-lg font-display text-[28px] leading-tight text-text-inverse sm:text-[32px]">
              Tell us about the arrival. We will arrange the ground.
            </h1>
            <p className="max-w-md text-[13px] leading-relaxed text-text-inverse-muted">
              One sentence is enough. We will read it back as editable detail before
              anything is sent to a supplier.
            </p>
          </div>
        </section>

        <RequestComposer
          services={categories.map((category) => ({
            id: category.id,
            code: category.code,
            name: category.name,
            description: category.description,
            unitLabel: category.unitLabel,
            iconPath: serviceIconFor(category.code),
            imagePath: serviceImageFor(category.code),
          }))}
        />

        <ClientRequestList requests={requests} />
      </main>
    </>
  );
}
