import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import {
  Bell,
  BellRing,
  Building2,
  CalendarRange,
  LayoutDashboard,
  MessageSquare,
  Truck,
  Users,
} from 'lucide-react';
import { requireSessionOrRedirect, redirectToHomePortal } from '@/auth/context';
import { isProviderUser } from '@/domain/permissions';
import { PortalShell, type NavSection } from '@/components/layout/portal-shell';
import { countUnread } from '@/services/notifications';
import { getDb } from '@/db/client';
import { providerCompanies } from '@/db/schema';

/**
 * Service Provider Portal shell and route guard.
 *
 * Every page beneath this layout is scoped to exactly one provider company — the one on
 * the session. The company name is shown in the sidebar so a dispatcher who works for two
 * operators can never be in doubt about which account they are acting in.
 */
export default async function ProviderLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSessionOrRedirect('/provider');
  const actor = session.user;

  if (!isProviderUser(actor) || actor.providerCompanyId === null) {
    redirectToHomePortal(actor);
  }

  const companyId = actor.providerCompanyId;
  const rows = await getDb()
    .select({ displayName: providerCompanies.displayName, status: providerCompanies.status })
    .from(providerCompanies)
    .where(eq(providerCompanies.id, companyId))
    .limit(1);

  const company = rows[0];
  const headerList = await headers();
  const activePath = headerList.get('x-apron-pathname') ?? '/provider';


  // The badge is read here, in the layout, so it is current on every navigation rather
  // than stale until the notification page itself is opened.
  const unread = await countUnread(actor.userId);

  const sections: NavSection[] = [
    {
      items: [
        { href: '/provider', label: 'Dashboard', icon: <LayoutDashboard className="size-4" /> },
        { href: '/provider/queue', label: 'Request queue', icon: <BellRing className="size-4" /> },
        { href: '/provider/schedule', label: 'Schedule', icon: <CalendarRange className="size-4" /> },
      ],
    },
    {
      title: 'Company',
      items: [
        { href: '/provider/resources', label: 'Resources', icon: <Truck className="size-4" /> },
        { href: '/provider/coverage', label: 'Coverage & hours', icon: <Building2 className="size-4" /> },
        { href: '/provider/team', label: 'Team', icon: <Users className="size-4" /> },
        { href: '/provider/messages', label: 'Messages', icon: <MessageSquare className="size-4" /> },
        {
          href: '/provider/notifications',
          label: 'Notifications',
          icon: <Bell className="size-4" />,
          ...(unread > 0 ? { badge: unread } : {}),
        },
      ],
    },
  ];

  return (
    <PortalShell
      portal="provider"
      user={actor}
      sections={sections}
      activePath={activePath}
      contextLabel={company?.displayName ?? 'Your company'}
    >
      {children}
    </PortalShell>
  );
}
