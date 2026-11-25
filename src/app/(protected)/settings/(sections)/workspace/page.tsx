'use client';

import { EncryptionSection } from '@/components/settings/workspace/EncryptionSection';
import { BrandSection } from '@/components/settings/workspace/BrandSection';
import { FeaturesSection } from '@/components/settings/workspace/FeaturesSection';
import { RegionSection } from '@/components/settings/workspace/RegionSection';
import { SignInMethodsSection } from '@/components/settings/workspace/SignInMethodsSection';
import { ProviderPlansSection } from '@/components/settings/workspace/ProviderPlansSection';
import { CompanyKnowledgeSection } from '@/components/settings/workspace/CompanyKnowledgeSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Workspace: the parts of the app the workspace uses, its brand, how people sign in, its region, company knowledge, AI provider plans and, while it needs attention, its encryption key (Owners only). */
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
      {show.signInMethods && (
        <div id="sign-in-methods" className="scroll-mt-6">
          <SignInMethodsSection />
        </div>
      )}
      {show.region && (
        <div id="region" className="scroll-mt-6">
          <RegionSection />
        </div>
      )}
      {show.companyKnowledge && (
        <div id="company-knowledge" className="scroll-mt-6">
          <CompanyKnowledgeSection />
        </div>
      )}
      {show.providerPlans && (
        <div id="provider-plans" className="scroll-mt-6">
          <ProviderPlansSection />
        </div>
      )}
      {/* Carries its own anchor: it renders nothing while there is nothing to do. */}
      {show.encryption && <EncryptionSection />}
    </>
  );
}
