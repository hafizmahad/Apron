import type { Metadata } from 'next';
import { requirePermission } from '@/auth/context';
import { ThreadDetailPage } from '@/components/messages/thread-pages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Conversation' };

export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  await requirePermission('request.view.offered_to_own_provider');
  const { id } = await params;
  return <ThreadDetailPage threadId={id} basePath="/provider/messages" />;
}
