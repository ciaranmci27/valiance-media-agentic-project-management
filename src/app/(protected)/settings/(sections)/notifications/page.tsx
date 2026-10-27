'use client';

import { NotificationPreferencesSection } from '@/components/settings/NotificationPreferencesSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

export default function NotificationSettingsPage() {
  const { canManageAgents } = useSettingsAccess();
  return <NotificationPreferencesSection canManageAgents={canManageAgents} />;
}
