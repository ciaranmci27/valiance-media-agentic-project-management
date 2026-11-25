'use client';

import { AssistantsSwitchSection } from '@/components/settings/assistants/AssistantsSwitchSection';
import { AssistantSetupsSection } from '@/components/settings/assistants/AssistantSetupsSection';
import { AssistantStatusSection } from '@/components/settings/assistants/AssistantStatusSection';
import { ChatConnectionsSection } from '@/components/settings/assistants/ChatConnectionsSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';
import { useAuth } from '@/lib/auth-context';
import { isModuleEnabled } from '@/lib/access-control';

/**
 * Assistants (Owners only): turn them on and name them, pick who gets one
 * and give everyone theirs, see whose need attention, and connect chat.
 */
export default function AssistantsSettingsPage() {
  const { show } = useSettingsAccess();
  const { access } = useAuth();
  const agentsOn = isModuleEnabled(access, 'agents');
  if (!show.assistants) return null;
  return (
    <>
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
