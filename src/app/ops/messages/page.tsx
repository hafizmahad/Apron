import type { Metadata } from 'next';
import { requirePermission } from '@/auth/context';
import { ThreadListPage } from '@/components/messages/thread-pages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Messages' };

export default async function Page() {
  await requirePermission('message.view.any');
  return <ThreadListPage basePath="/ops/messages" />;
}
