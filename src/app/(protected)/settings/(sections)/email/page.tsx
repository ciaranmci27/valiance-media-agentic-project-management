'use client';

import { EmailOverview } from '@/components/settings/email/EmailOverview';
import { ReceivingSection } from '@/components/settings/email/ReceivingSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

export default function EmailSettingsPage() {
  const { show } = useSettingsAccess();
  return (
    <>
      <EmailOverview />
      {show.receiving && (
        <div id="receiving" className="scroll-mt-6">
          <ReceivingSection />
        </div>
      )}
    </>
  );
}
