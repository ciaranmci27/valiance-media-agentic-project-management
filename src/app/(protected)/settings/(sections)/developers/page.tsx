'use client';

import { useAuth } from '@/lib/auth-context';
import { isModuleEnabled } from '@/lib/access-control';
import { ApiKeysSection } from '@/components/settings/ApiKeysSection';
import { KeyLifetimeSection } from '@/components/settings/KeyLifetimeSection';
import { WebhooksPanel } from '@/components/settings/WebhooksPanel';
import { WebhooksOffCard } from '@/components/settings/WebhooksOffCard';
import { WebhookRetriesCard } from '@/components/settings/WebhookRetriesCard';
import { DeveloperDocsSection } from '@/components/settings/DeveloperDocsSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/**
 * Settings > Developers, for Owners, whoever manages every key and webhook
 * managers: everyone else's keys, how long new keys last (Owners), webhooks
 * (shown while the module is off too, with the way to turn it on), then the
 * MCP and API addresses and docs. Your own keys are in AI > Your assistant,
 * or here while AI agents is off (that area is closed then).
 */
export default function DeveloperSettingsPage() {
  const { access } = useAuth();
  const { show, webhooksState } = useSettingsAccess();
  return (
    <>
      {show.myKeys && <ApiKeysSection scope="mine" />}
      {show.apiKeys && <ApiKeysSection scope="workspace" />}

      {show.keyLifetimes && <KeyLifetimeSection agentsOn={isModuleEnabled(access, 'agents')} />}

      {show.webhooks && (
        <div id="webhooks" className="scroll-mt-6">
          {webhooksState === 'manage'
            ? <WebhooksPanel />
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
