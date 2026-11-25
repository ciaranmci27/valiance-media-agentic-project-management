'use client';

import { useAuth } from '@/lib/auth-context';
import { ApiKeysSection } from '@/components/settings/ApiKeysSection';
import { WebhooksPanel } from '@/components/settings/WebhooksPanel';
import { WebhooksOffCard } from '@/components/settings/WebhooksOffCard';
import { WebhookRetriesCard } from '@/components/settings/WebhookRetriesCard';
import { DeveloperDocsSection } from '@/components/settings/DeveloperDocsSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/**
 * Settings > Developers: your API keys, webhooks (shown while the module is
 * off too, with the way to turn it on), then the MCP and API addresses and docs.
 */
export default function DeveloperSettingsPage() {
  const { teamMemberId } = useAuth();
  const { show, webhooksState } = useSettingsAccess();
  return (
    <>
      {show.apiKeys && <ApiKeysSection />}

      {show.webhooks && (
        <div id="webhooks" className="scroll-mt-6">
          {webhooksState === 'manage'
            ? <WebhooksPanel teamMemberId={teamMemberId} />
            : <WebhooksOffCard canTurnOn={webhooksState === 'turn-on'} />}
        </div>
      )}

      {/* Retrying failed deliveries on a schedule (Owners only, with webhooks on) */}
      {/* Carries its own anchor: it renders nothing once retries are on. */}
      {show.webhookRetries && <WebhookRetriesCard />}

      {show.developerDocs && <DeveloperDocsSection />}
    </>
  );
}
