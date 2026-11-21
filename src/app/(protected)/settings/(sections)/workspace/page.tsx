'use client';

import { BrandSection } from '@/components/settings/workspace/BrandSection';
import { FeaturesSection } from '@/components/settings/workspace/FeaturesSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Workspace: the parts of the app the workspace uses, and its brand (Owners only). */
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
    </>
  );
}
