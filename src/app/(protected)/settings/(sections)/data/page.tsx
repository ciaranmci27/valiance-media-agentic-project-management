'use client';

import { TrashEntrySection } from '@/components/settings/TrashEntrySection';
import { DemoModeSection } from '@/components/settings/DemoModeSection';
import { CardRow } from '@/components/ui/Card';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Data: Trash, and Demo mode for Owners. Portal analytics exclusions live under Settings > Client portal. */
export default function DataSettingsPage() {
  const { show } = useSettingsAccess();
  return (
    <>
      {/* Side by side on wide screens when both show (Rule 9). Demo mode: Owners only, hidden when env-forced. */}
      <CardRow className={show.demoMode ? 'lg:grid-cols-2' : ''}>
        <TrashEntrySection />
        {show.demoMode && <DemoModeSection />}
      </CardRow>
    </>
  );
}
