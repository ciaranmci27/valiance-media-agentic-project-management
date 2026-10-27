'use client';

import { ProfileSection } from '@/components/settings/ProfileSection';
import { TimezoneSection } from '@/components/settings/TimezoneSection';
import { PasswordSection } from '@/components/settings/PasswordSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

export default function AccountSettingsPage() {
  const { show } = useSettingsAccess();
  return (
    <>
      <ProfileSection />
      <TimezoneSection />
      {/* No password change in demo mode */}
      {show.password && <PasswordSection />}
      <AppearanceSection />
    </>
  );
}
