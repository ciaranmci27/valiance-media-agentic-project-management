'use client';

import { AssistantServiceSection } from '@/components/settings/assistants/AssistantServiceSection';
import { AssistantsSwitchSection } from '@/components/settings/assistants/AssistantsSwitchSection';
import { AssistantSetupsSection } from '@/components/settings/assistants/AssistantSetupsSection';
import { AssistantStatusSection } from '@/components/settings/assistants/AssistantStatusSection';
import { ChatConnectionsSection } from '@/components/settings/assistants/ChatConnectionsSection';
import { ASSISTANTS_DEMO_NOTE } from '@/components/settings/assistants/demo';
import { useSettingsAccess } from '@/components/settings/settings-groups';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { isModuleEnabled } from '@/lib/access-control';
import { ASSISTANT_SERVICE_ANCHOR } from '@/lib/assistant';

/**
 * Assistants (Owners only): connect the agent service that runs them, turn
 * them on and name them, pick who gets one and give everyone theirs, see
 * whose need attention, and connect chat. The demo shows sample assistants
 * with changes off.
 */
export default function AssistantsSettingsPage() {
  const { show } = useSettingsAccess();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const agentsOn = isModuleEnabled(access, 'agents');
  if (!show.assistants) return null;
  return (
    <>
      {isDemoMode && <p role="note" className="rounded-lg bg-white/[0.04] px-3.5 py-3 text-sm text-zinc-300">{ASSISTANTS_DEMO_NOTE}</p>}
      {agentsOn && (
        <div id={ASSISTANT_SERVICE_ANCHOR} className="scroll-mt-6">
          <AssistantServiceSection />
        </div>
      )}
      <div id="assistants" className="scroll-mt-6">
        <AssistantsSwitchSection agentsOn={agentsOn} />
      </div>
      {agentsOn && (
        <>
          <div id="assistant-setups" className="scroll-mt-6">
            <AssistantSetupsSection />
          </div>
          <div id="assistant-status" className="scroll-mt-6">
            <AssistantStatusSection />
          </div>
          <div id="chat-connections" className="scroll-mt-6">
            <ChatConnectionsSection />
          </div>
        </>
      )}
    </>
  );
}
