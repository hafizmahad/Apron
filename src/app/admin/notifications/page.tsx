import type { Metadata } from 'next';
import { NotificationCentre } from '@/components/notifications/notification-centre';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Notifications' };

export default function AdminNotificationsPage() {
  return <NotificationCentre portal="admin" />;
}
