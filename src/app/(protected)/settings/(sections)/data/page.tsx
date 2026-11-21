'use client';

import { TrashEntrySection } from '@/components/settings/TrashEntrySection';
import { DemoModeSection } from '@/components/settings/DemoModeSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Data: Trash, and Demo mode for Owners. Portal analytics exclusions live under Settings > Client portal. */
export default function DataSettingsPage() {
  const { show } = useSettingsAccess();
  return (
    <>
      <TrashEntrySection />

      {/* Demo Mode ; admin only, hidden when env-forced */}
      {show.demoMode && <DemoModeSection />}
    </>
  );
}
