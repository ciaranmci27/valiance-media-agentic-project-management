'use client';

import { notFound, useParams } from 'next/navigation';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { useCustomSettingsSection } from '@/lib/extensions/hooks';

/**
 * A Settings page the install added (src/custom/index.ts `settingsSections`),
 * in the same card and header as the core sections. Owners only unless the
 * section opens itself with `roles` or `permission`.
 */
export default function CustomSettingsPage() {
  const { key } = useParams<{ key: string }>();
  const section = useCustomSettingsSection(key);
  if (!section) notFound();

  const Body = section.component;
  return (
    <div id={section.key} className="scroll-mt-6">
      <section className="glass-card rounded-xl p-4 lg:p-6">
        <SettingsSectionHeader icon={section.icon} title={section.label} description={section.description} />
        <Body />
      </section>
    </div>
  );
}
