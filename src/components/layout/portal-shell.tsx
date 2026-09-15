import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ApronMark } from '@/components/ui/domain-icon';
import { Monogram } from '@/components/ui/monogram';
import { backgroundAssets } from '@/lib/assets';
import { cn } from '@/lib/cn';
import type { SessionUser } from '@/auth/session';
import { logoutAction } from '@/app/(public)/login/actions';

/**
 * The authenticated application shell (CLAUDE.md §21).
 *
 * One shell serves all three portals; only the navigation items and the sidebar
 * atmosphere change. That keeps the operational muscle memory identical across portals
 * and means a visual fix lands everywhere at once.
 *
 * Desktop-first, as the brief requires for authenticated operations screens, but the
 * sidebar collapses to a horizontal bar below `lg` rather than disappearing — a
 * dispatcher checking a job from a phone still needs to navigate.
 *
 * The sidebar artwork sits at very low emphasis behind the navigation and is `aria-hidden`:
 * it is atmosphere, never information.
 */

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** Shown as a count badge — pending acknowledgements, exceptions. */
  readonly badge?: number;
}

export interface NavSection {
  readonly title?: string;
  readonly items: readonly NavItem[];
}

export type PortalKind = 'ops' | 'provider' | 'admin';

const SIDEBAR_BACKGROUND: Record<PortalKind, string> = {
  ops: backgroundAssets.opsSidebar,
  provider: backgroundAssets.providerSidebar,
  admin: backgroundAssets.adminSidebar,
};

const PORTAL_LABEL: Record<PortalKind, string> = {
  ops: 'Operations',
  provider: 'Provider',
  admin: 'Administration',
};

export function PortalShell({
  portal,
  user,
  sections,
  activePath,
  contextLabel,
  children,
}: {
  readonly portal: PortalKind;
  readonly user: SessionUser;
  readonly sections: readonly NavSection[];
  readonly activePath: string;
  /** The provider company or organisation this session is scoped to, when there is one. */
  readonly contextLabel?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas lg:flex-row">
      <Sidebar
        portal={portal}
        user={user}
        sections={sections}
        activePath={activePath}
        {...(contextLabel === undefined ? {} : { contextLabel })}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-8 sm:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function Sidebar({
  portal,
  user,
  sections,
  activePath,
  contextLabel,
}: {
  readonly portal: PortalKind;
  readonly user: SessionUser;
  readonly sections: readonly NavSection[];
  readonly activePath: string;
  readonly contextLabel?: string;
}) {
  // Resolved once for the whole sidebar, so exactly one item can be current.
  const activeHref = activeNavHref(activePath, sections);

  return (
    <aside
      className={cn(
        'relative isolate flex shrink-0 flex-col overflow-hidden bg-sidebar text-text-inverse',
        'lg:h-screen lg:w-[264px] lg:sticky lg:top-0',
      )}
    >
      {/* Atmosphere only: very low emphasis, never carries information. */}
      <Image
        src={SIDEBAR_BACKGROUND[portal]}
        alt=""
        aria-hidden
        fill
        sizes="264px"
        className="-z-10 object-cover opacity-[0.14]"
      />
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-sidebar-deep/40 via-transparent to-sidebar-deep/80" />

      <div className="flex items-center gap-3 px-5 py-5">
        <ApronMark className="h-7 w-10 text-text-inverse" />
        <div className="min-w-0">
          <p className="font-display text-lg font-semibold leading-none">Apron</p>
          <p className="mt-1 truncate text-[11px] uppercase tracking-[0.22em] text-text-inverse-muted">
            {PORTAL_LABEL[portal]}
          </p>
        </div>
      </div>

      {contextLabel !== undefined && (
        <div className="mx-5 mb-4 rounded-md bg-sidebar-soft/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.14em] text-text-inverse-muted">
            Signed in for
          </p>
          <p className="mt-0.5 truncate text-[13px] font-medium">{contextLabel}</p>
        </div>
      )}

      <nav aria-label={`${PORTAL_LABEL[portal]} navigation`} className="flex-1 overflow-y-auto px-3 pb-4">
        {sections.map((section, index) => (
          <div key={section.title ?? `section-${index}`} className={cn(index > 0 && 'mt-6')}>
            {section.title !== undefined && (
              <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-inverse-muted">
                {section.title}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} active={item.href === activeHref} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <UserPanel user={user} />
    </aside>
  );
}

function NavLink({ item, active }: { readonly item: NavItem; readonly active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-3 rounded-md px-2.5 py-2 text-[13px] transition-colors',
        active
          ? 'bg-sidebar-soft text-text-inverse'
          : 'text-text-inverse-muted hover:bg-sidebar-soft/60 hover:text-text-inverse',
      )}
    >
      <span
        className={cn(
          'shrink-0 transition-colors',
          active ? 'text-gold' : 'text-text-inverse-muted group-hover:text-text-inverse',
        )}
      >
        {item.icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.badge !== undefined && item.badge > 0 && (
        <span
          className="tabular shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold leading-4 text-text-inverse"
          aria-label={`${item.badge} needing attention`}
        >
          {item.badge > 99 ? '99+' : item.badge}
        </span>
      )}
    </Link>
  );
}

function UserPanel({ user }: { readonly user: SessionUser }) {
  return (
    <div className="border-t border-white/10 px-4 py-4">
      <div className="flex items-center gap-3">
        <Monogram name={user.fullName} subjectId={user.userId} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-text-inverse">{user.fullName}</p>
          <p className="truncate text-[11px] text-text-inverse-muted">{user.email}</p>
        </div>
      </div>

      <form action={logoutAction} className="mt-3">
        <button
          type="submit"
          className={cn(
            'w-full rounded-md border border-white/15 px-3 py-1.5 text-[12px] font-medium',
            'text-text-inverse-muted transition-colors hover:bg-sidebar-soft hover:text-text-inverse',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold',
          )}
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

/**
 * Which single nav item the current path belongs to.
 *
 * "Longest match wins", and it returns exactly one href. The obvious rule — an item is
 * active if the path starts with its href — marks the portal root active on every page
 * beneath it, so `/admin/requests` lit up both *Overview* and *Request oversight*. Two
 * items looked selected, the reader could not tell where they were, and `aria-current`
 * was announced twice, which is wrong on its own terms.
 *
 * Returning the winner rather than testing each item in isolation is what makes "exactly
 * one" a property of the function instead of something each caller has to arrange.
 */
export function activeNavHref(currentPath: string, sections: readonly NavSection[]): string | null {
  const candidates = sections
    .flatMap((section) => section.items)
    .map((item) => item.href)
    .filter((href) => currentPath === href || currentPath.startsWith(`${href}/`));

  if (candidates.length === 0) return null;

  // The most specific match: `/admin/requests` beats `/admin`.
  return candidates.reduce((best, href) => (href.length > best.length ? href : best));
}
