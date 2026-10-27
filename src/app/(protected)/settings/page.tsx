'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { DEFAULT_SETTINGS_HREF, settingsHrefForSection } from '@/components/settings/settings-groups';

/**
 * /settings is now a menu of pages. Old links still land: /settings opens
 * Account, and /settings#<section> (email-inboxes, say) opens the page that
 * holds that section with the hash kept, so the page scrolls to it. Done on
 * the client because the hash never reaches the server.
 */
export default function SettingsIndexPage() {
  const router = useRouter();

  useEffect(() => {
    const { hash, search } = window.location;
    const target = settingsHrefForSection(hash.slice(1));
    router.replace(target ? `${target}${search}${hash}` : `${DEFAULT_SETTINGS_HREF}${search}`);
  }, [router]);

  return null;
}
