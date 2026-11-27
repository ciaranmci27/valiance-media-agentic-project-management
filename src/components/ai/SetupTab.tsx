'use client';

import { KeyRound } from 'lucide-react';
import { AssistantServiceSection } from '@/components/settings/assistants/AssistantServiceSection';
import { AssistantsSwitchSection } from '@/components/settings/assistants/AssistantsSwitchSection';
import { AssistantSetupsSection } from '@/components/settings/assistants/AssistantSetupsSection';
import { AssistantStatusSection } from '@/components/settings/assistants/AssistantStatusSection';
import { ChatConnectionsSection } from '@/components/settings/assistants/ChatConnectionsSection';
import { ASSISTANTS_DEMO_NOTE } from '@/components/settings/assistants/demo';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { isModuleEnabled } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { assistantSettingsReadFor } from '@/lib/reads';
import { ASSISTANT_SERVICE_ANCHOR } from '@/lib/assistant';

/**
 * AI > Setup (Owners): everything that sets up AI for the whole company, in
 * the order it is done. Assistants on or off first; while off, that one card
 * is all there is about assistants. While on: who gets one, how each is
 * doing, and the agent service that runs them. Then the chat apps people
 * message (company bots), and where every key lives (Settings > Developers).
 * The demo shows samples with changes off.
 */
export function SetupTab() {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const agentsOn = isModuleEnabled(access, 'agents');
  const settings = useRead(assistantSettingsReadFor(isDemoMode)).data;
  const assistantsOn = agentsOn && !!settings?.enabled;

  return (
    <div className="space-y-6">
      {isDemoMode && <p role="note" className="rounded-lg bg-white/[0.04] px-3.5 py-3 text-sm text-zinc-300">{ASSISTANTS_DEMO_NOTE}</p>}
      <div id="assistants" className="scroll-mt-6">
        <AssistantsSwitchSection agentsOn={agentsOn} />
      </div>
      {assistantsOn && (
        <>
          <div id="assistant-setups" className="scroll-mt-6">
            <AssistantSetupsSection />
          </div>
          <div id="assistant-status" className="scroll-mt-6">
            <AssistantStatusSection />
          </div>
          <div id={ASSISTANT_SERVICE_ANCHOR} className="scroll-mt-6">
            <AssistantServiceSection />
          </div>
        </>
      )}
      {agentsOn && (
        <div id="chat-connections" className="scroll-mt-6">
          <ChatConnectionsSection />
        </div>
      )}
      <Card
        title="Keys"
        icon={<KeyRound />}
        id="ai-keys"
        description="Every key for people and agents, what each may do and when it was last used, lives in one list."
        action={<Button size="sm" variant="secondary" href="/settings/developers#api-keys">Open keys</Button>}
        bodyClassName="pb-1"
      >
        {null}
      </Card>
    </div>
  );
}
