'use client';

import { Suspense } from 'react';
import { TemplatesSection } from '@/components/settings/templates/TemplatesSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Templates: company-wide playbooks and every project's own, for whoever uses or writes them. */
export default function TemplatesSettingsPage() {
  const { show } = useSettingsAccess();
  if (!show.templates) return null;
  return (
    <Suspense fallback={null}>
      <TemplatesSection />
    </Suspense>
  );
}
