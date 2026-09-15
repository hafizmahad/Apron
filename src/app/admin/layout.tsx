import { headers } from 'next/headers';
import {
  Blocks,
  Bell,
  BrainCircuit,
  ClipboardList,
  LayoutDashboard,
  Plane,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { requireSessionOrRedirect, redirectToHomePortal } from '@/auth/context';
import { isPlatformAdmin } from '@/domain/permissions';
import { PortalShell, type NavSection } from '@/components/layout/portal-shell';
import { countUnread } from '@/services/notifications';

/**
 * Admin Console shell and route guard.
 *
 * Platform administrators only — operations deliberately cannot reach governance data
 * (CLAUDE.md §5). Visually the most restrained of the three portals, as the brief requires.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSessionOrRedirect('/admin');
  const actor = session.user;

  if (!isPlatformAdmin(actor)) {
    redirectToHomePortal(actor);
  }

  const headerList = await headers();
  const activePath = headerList.get('x-apron-pathname') ?? '/admin';


  // The badge is read here, in the layout, so it is current on every navigation rather
  // than stale until the notification page itself is opened.
  const unread = await countUnread(actor.userId);

  const sections: NavSection[] = [
    {
      items: [{ href: '/admin', label: 'Overview', icon: <LayoutDashboard className="size-4" /> }],
    },
    {
      title: 'Governance',
      items: [
        { href: '/admin/providers', label: 'Provider approvals', icon: <ShieldCheck className="size-4" /> },
        { href: '/admin/users', label: 'Users & roles', icon: <Users className="size-4" /> },
        { href: '/admin/requests', label: 'Request oversight', icon: <ClipboardList className="size-4" /> },
        { href: '/admin/audit', label: 'Audit explorer', icon: <ScrollText className="size-4" /> },
      ],
    },
    {
      title: 'Configuration',
      items: [
        { href: '/admin/catalogue', label: 'Service catalogue', icon: <Blocks className="size-4" /> },
        { href: '/admin/registry', label: 'Airport & FBO registry', icon: <Plane className="size-4" /> },
        { href: '/admin/settings', label: 'Settings & flags', icon: <Settings className="size-4" /> },
      ],
    },
    {
      title: 'Observability',
      items: [
        { href: '/admin/ai', label: 'AI reliability', icon: <BrainCircuit className="size-4" /> },
        {
          href: '/admin/notifications',
          label: 'Notifications',
          icon: <Bell className="size-4" />,
          ...(unread > 0 ? { badge: unread } : {}),
        },
      ],
    },
  ];

  return (
    <PortalShell portal="admin" user={actor} sections={sections} activePath={activePath}>
      {children}
    </PortalShell>
  );
}
