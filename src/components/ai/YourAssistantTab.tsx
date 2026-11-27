'use client';

import { NeedsYouView } from '@/components/agent/NeedsYouView';
import { AssistantSection } from '@/components/assistant/MyAssistantPage';
import { ApiKeysSection } from '@/components/settings/ApiKeysSection';
import { ConnectAiSection } from '@/components/settings/ConnectAiSection';
import { LinkedAccountsSection } from '@/components/settings/LinkedAccountsSection';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import type { AiHub } from '@/lib/use-ai-hub';

/**
 * AI > Your assistant, for every person: what agents wait on you for (your
 * own asks, answered in place), your assistant while assistants are on, the
 * AI tools you connect yourself (Claude, ChatGPT and others) and the chat
 * accounts your assistant knows you by, and your own API keys. With assistants off, nothing here
 * mentions an assistant: it is your asks and your AI tools.
 */
export function YourAssistantTab({ hub, onOpenTask, onOpenSetup }: {
  hub: AiHub;
  onOpenTask: (taskId: string) => void;
  onOpenSetup?: () => void;
}) {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const showAssistant = hub.access.assistantContent && !!hub.assistant;
  const canMakeKeys = !isDemoMode && access?.role !== 'guest';

  return (
    <div className="space-y-6">
      <NeedsYouView scope="mine" needs={hub.mine.needs} items={hub.mine.items} drafts={hub.mine.drafts} onOpenTask={onOpenTask} />
      {showAssistant && <AssistantSection view={hub.assistant!} onOpenSetup={onOpenSetup} />}
      {/* Your own AI tools: anyone who signs in; keys are not made in the demo or by guests. */}
      <ConnectAiSection canMakeKeys={canMakeKeys} />
      {/* Your own API keys, for a tool that cannot sign in with Connect AI (everyone else's are in Settings > Developers). */}
      {canMakeKeys && <ApiKeysSection scope="mine" />}
      {showAssistant && <LinkedAccountsSection />}
    </div>
  );
}
