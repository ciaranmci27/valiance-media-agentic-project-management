'use client';

import { BusinessInfoSection } from '@/components/settings/BusinessInfoSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Business info, invoice defaults and the auto-approve hours policy (all in BusinessInfoSection). */
export default function BusinessSettingsPage() {
  const { show } = useSettingsAccess();
  if (!show.business) return null;
  return (
    <div id="business" className="scroll-mt-6">
      <BusinessInfoSection />
    </div>
  );
}
