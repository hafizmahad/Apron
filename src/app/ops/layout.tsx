import { headers } from 'next/headers';
import {
  CalendarClock,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Plane,
  Radar,
  ShieldAlert,
  Users,
  Bell,
} from 'lucide-react';
import { requireSessionOrRedirect, redirectToHomePortal } from '@/auth/context';
import { isOperations, isPlatformAdmin } from '@/domain/permissions';
import { PortalShell, type NavSection } from '@/components/layout/portal-shell';
import { countUnread } from '@/services/notifications';

/**
 * Operations Portal shell and route guard.
 *
 * The layout is a real authorisation boundary, not decoration: an actor who is not
 * operations or admin never renders a child route. Each page additionally performs its own
 * server-side permission check, because a layout guard protects navigation while a page
 * guard protects data (CLAUDE.md §5 "Never authorize solely by route visibility").
 */
export default async function OperationsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSessionOrRedirect('/ops');
  const actor = session.user;

  if (!isOperations(actor) && !isPlatformAdmin(actor)) {
    redirectToHomePortal(actor);
  }

  const headerList = await headers();
  const activePath = headerList.get('x-apron-pathname') ?? '/ops';


  // The badge is read here, in the layout, so it is current on every navigation rather
  // than stale until the notification page itself is opened.
  const unread = await countUnread(actor.userId);

  const sections: NavSection[] = [
    {
      items: [
        { href: '/ops', label: 'Dashboard', icon: <LayoutDashboard className="size-4" /> },
        { href: '/ops/requests', label: 'Requests', icon: <ListChecks className="size-4" /> },
        { href: '/ops/schedule', label: 'Schedule', icon: <CalendarClock className="size-4" /> },
        { href: '/ops/exceptions', label: 'Exceptions', icon: <ShieldAlert className="size-4" /> },
      ],
    },
    {
      title: 'Network',
      items: [
        { href: '/ops/providers', label: 'Providers', icon: <Users className="size-4" /> },
        { href: '/ops/airports', label: 'Airports & FBOs', icon: <Plane className="size-4" /> },
      ],
    },
    {
      title: 'Tools',
      items: [
        { href: '/ops/research', label: 'Research assistant', icon: <Radar className="size-4" /> },
        { href: '/ops/messages', label: 'Messages', icon: <MessageSquare className="size-4" /> },
        {
          href: '/ops/notifications',
          label: 'Notifications',
          icon: <Bell className="size-4" />,
          ...(unread > 0 ? { badge: unread } : {}),
        },
      ],
    },
  ];

  return (
    <PortalShell portal="ops" user={actor} sections={sections} activePath={activePath}>
      {children}
    </PortalShell>
  );
}
