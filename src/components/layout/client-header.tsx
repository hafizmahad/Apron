import Link from 'next/link';
import { ApronMark } from '@/components/ui/domain-icon';
import { logoutAction } from '@/app/(public)/login/actions';
import type { SessionUser } from '@/auth/session';

/**
 * The client surface header.
 *
 * Minimal by design (CLAUDE.md §1): the organisation name, a way back to the composer,
 * and sign-out. No internal navigation, no service codes, no provider names beyond what
 * the request itself legitimately shows.
 */
export function ClientHeader({
  user,
  organizationName,
}: {
  readonly user: SessionUser;
  readonly organizationName: string;
}) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
        <Link href="/client" className="flex items-center gap-3 text-text-primary">
          <ApronMark className="h-7 w-10" />
          <span className="font-display text-lg font-semibold leading-none">Apron</span>
        </Link>

        <div className="flex items-center gap-4">
          <div className="hidden text-right sm:block">
            <p className="text-[13px] font-medium leading-tight text-text-primary">
              {organizationName}
            </p>
            <p className="text-[11px] leading-tight text-text-secondary">{user.fullName}</p>
          </div>

          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md border border-border-strong px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-canvas-cool hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
