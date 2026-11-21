'use client';

import { UpdatesSection } from '@/components/settings/updates/UpdatesSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Updates: new versions of the app and how to install them (Owners only). */
export default function UpdatesSettingsPage() {
  const { show } = useSettingsAccess();
  if (!show.updates) return null;
  return <UpdatesSection />;
}
