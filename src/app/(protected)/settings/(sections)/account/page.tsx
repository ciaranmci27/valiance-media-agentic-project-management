'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ProfileSection } from '@/components/settings/ProfileSection';
import { TimezoneSection } from '@/components/settings/TimezoneSection';
import { SignInSection } from '@/components/settings/SignInSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { CardRow } from '@/components/ui/Card';
import { useSettingsAccess } from '@/components/settings/settings-groups';
import { AI_SECTION_HREFS } from '@/lib/ai-home';

/** Your account. Your AI tools and chat accounts live in AI > Your assistant; an old #anchor here lands there. */
export default function AccountSettingsPage() {
  const { show } = useSettingsAccess();
  const router = useRouter();
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (Object.hasOwn(AI_SECTION_HREFS, id)) router.replace(AI_SECTION_HREFS[id]);
  }, [router]);
  return (
    <>
      <ProfileSection />
      {/* Two short personal choices side by side on wide screens (Rule 9). */}
      <CardRow className="lg:grid-cols-2">
        <TimezoneSection />
        <AppearanceSection />
      </CardRow>
      {/* Your password and Google link. The demo shows a sample with nothing to change. */}
      {show.signIn && <SignInSection />}
    </>
  );
}
