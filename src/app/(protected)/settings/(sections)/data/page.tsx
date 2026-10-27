'use client';

import { TrashEntrySection } from '@/components/settings/TrashEntrySection';
import { AnalyticsExclusionsSection } from '@/components/settings/AnalyticsExclusionsSection';
import { DemoModeSection } from '@/components/settings/DemoModeSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

export default function DataSettingsPage() {
  const { show } = useSettingsAccess();
  return (
    <>
      <TrashEntrySection />

      {/* Analytics Exclusions ; admin only */}
      {show.analyticsExclusions && (
        <div id="analytics-exclusions" className="scroll-mt-6">
          <AnalyticsExclusionsSection />
        </div>
      )}

      {/* Demo Mode ; admin only, hidden when env-forced */}
      {show.demoMode && <DemoModeSection />}
    </>
  );
}
