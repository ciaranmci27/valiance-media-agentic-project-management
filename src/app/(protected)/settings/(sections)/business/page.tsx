'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Settings > Business is now Settings > Billing. Old links still land: the
 * query and hash come along, so /settings/business#business opens Billing.
 */
export default function BusinessSettingsRedirect() {
  const router = useRouter();
  useEffect(() => {
    const { search, hash } = window.location;
    router.replace(`/settings/billing${search}${hash}`);
  }, [router]);
  return null;
}
