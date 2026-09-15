import type { Metadata } from 'next';
import { requirePermission } from '@/auth/context';
import { ThreadListPage } from '@/components/messages/thread-pages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Messages' };

/**
 * Viewing threads is a read: `provider_staff` may read their company's conversations even
 * though they may not post to them. Requiring the *send* permission here turned an
 * ordinary role difference into an error page.
 */
export default async function Page() {
  await requirePermission('request.view.offered_to_own_provider');
  return <ThreadListPage basePath="/provider/messages" />;
}
