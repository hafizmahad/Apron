import { redirect } from 'next/navigation';
import { requireSessionOrRedirect } from '@/auth/context';
import { homePortal, isClient } from '@/domain/permissions';

/**
 * Client surface shell and route guard.
 *
 * Deliberately NOT the operational `PortalShell`: the client experience is a minimal
 * external surface, not a fourth console (CLAUDE.md §1). No sidebar, no internal
 * navigation, no exposure to service codes, provider ranking or admin concepts.
 *
 * Operations and Admin are redirected to their own portals rather than shown this — they
 * have a far richer view of the same requests, so landing here would be a downgrade, not
 * a permission problem.
 */
export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSessionOrRedirect('/client');
  const actor = session.user;

  if (!isClient(actor)) {
    redirect(homePortal(actor));
  }

  return <div className="min-h-screen bg-canvas">{children}</div>;
}
