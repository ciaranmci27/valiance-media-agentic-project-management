'use client';

import { EncryptionSection } from '@/components/settings/workspace/EncryptionSection';
import { BrandSection } from '@/components/settings/workspace/BrandSection';
import { FeaturesSection } from '@/components/settings/workspace/FeaturesSection';
import { RegionSection } from '@/components/settings/workspace/RegionSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Workspace: the parts of the app the workspace uses, its brand, its region and, while it needs attention, its encryption key (Owners only). */
export default function WorkspaceSettingsPage() {
  const { show } = useSettingsAccess();
  return (
    <>
      {show.features && (
        <div id="features" className="scroll-mt-6">
          <FeaturesSection />
        </div>
      )}
      {show.brand && (
        <div id="brand" className="scroll-mt-6">
          <BrandSection />
        </div>
      )}
      {show.region && (
        <div id="region" className="scroll-mt-6">
          <RegionSection />
        </div>
      )}
      {/* Carries its own anchor: it renders nothing while there is nothing to do. */}
      {show.encryption && <EncryptionSection />}
    </>
  );
}
