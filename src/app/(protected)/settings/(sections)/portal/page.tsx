'use client';

import { AnalyticsExclusionsSection } from '@/components/settings/AnalyticsExclusionsSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Client portal: settings that apply to every project's portal (shown while the portal is on). */
export default function PortalSettingsPage() {
  const { show } = useSettingsAccess();
  if (!show.analyticsExclusions) return null;
  return (
    <div id="analytics-exclusions" className="scroll-mt-6">
      <AnalyticsExclusionsSection />
    </div>
  );
}
