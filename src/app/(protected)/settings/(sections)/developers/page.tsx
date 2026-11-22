'use client';

import { useAuth } from '@/lib/auth-context';
import { ApiKeysSection } from '@/components/settings/ApiKeysSection';
import { WebhooksPanel } from '@/components/settings/WebhooksPanel';
import { WebhookRetriesCard } from '@/components/settings/WebhookRetriesCard';
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

      {/* Retrying failed deliveries on a schedule (Owners only, with webhooks on) */}
      {/* Carries its own anchor: it renders nothing once retries are on. */}
      {show.webhookRetries && <WebhookRetriesCard />}
    </>
  );
}
