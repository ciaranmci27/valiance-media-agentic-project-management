'use client';

import { useAuth } from '@/lib/auth-context';
import { ApiKeysSection } from '@/components/settings/ApiKeysSection';
import { WebhooksPanel } from '@/components/settings/WebhooksPanel';
import { useSettingsAccess } from '@/components/settings/settings-groups';

export default function DeveloperSettingsPage() {
  const { teamMemberId } = useAuth();
  const { show } = useSettingsAccess();
  return (
    <>
      {show.apiKeys && <ApiKeysSection />}

      {/* Webhooks ; for members allowed to manage outbound integrations */}
      {show.webhooks && (
        <div id="webhooks" className="scroll-mt-6">
          <WebhooksPanel teamMemberId={teamMemberId} />
        </div>
      )}
    </>
  );
}
