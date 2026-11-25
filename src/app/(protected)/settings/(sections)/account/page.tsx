'use client';

import { ProfileSection } from '@/components/settings/ProfileSection';
import { TimezoneSection } from '@/components/settings/TimezoneSection';
import { SignInSection } from '@/components/settings/SignInSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { LinkedAccountsSection } from '@/components/settings/LinkedAccountsSection';
import { ConnectAiSection } from '@/components/settings/ConnectAiSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

export default function AccountSettingsPage() {
  const { show } = useSettingsAccess();
  return (
    <>
      <ProfileSection />
      <TimezoneSection />
      {/* Your password and Google link. The demo shows a sample with nothing to change. */}
      {show.signIn && <SignInSection />}
      {show.connectAi && <ConnectAiSection canMakeKeys={show.apiKeys} />}
      <LinkedAccountsSection />
      <AppearanceSection />
    </>
  );
}
