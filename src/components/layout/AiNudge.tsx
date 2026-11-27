'use client';

import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { linkedFor } from '@/components/assistant/AssistantChatCard';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { myIdentitiesRead } from '@/lib/reads';
import { AI_NUDGE_COPY, aiNudge, aiNudgeDismissKey } from '@/lib/nav';
import type { AiHub } from '@/lib/use-ai-hub';

/**
 * The sidebar's one AI nudge until AI is set up (lib/nav aiNudge): an Owner
 * with no agent or assistant yet is asked to set AI up; a person whose
 * assistant waits on them to link a chat account is asked to connect it.
 * One plain line and one action; the X hides it for good in this browser.
 */
export function AiNudgeCard({ hub, onNavigate }: { hub: AiHub; onNavigate: () => void }) {
  const { team, loading } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const assistant = hub.assistant;
  const assistantsOn = !!assistant?.agents_on && !!assistant.enabled;
  const chatApps = assistantsOn && assistant?.assistant ? assistant.connections.filter((c) => c.enabled) : [];
  // Read only when the answer could matter: a person with an assistant and a chat app to link.
  const identities = useRead(chatApps.length > 0 && access?.role !== 'owner' ? myIdentitiesRead(isDemoMode) : null).data;

  const nudge = loading ? null : aiNudge({
    role: access?.role,
    aiEntry: hub.access.entry,
    hasAgents: team.some((member) => member.role === 'agent'),
    assistantsOn,
    hasAssistant: !!assistant?.assistant,
    chatApps: chatApps.length,
    linkedChats: identities ? chatApps.filter((connection) => linkedFor(connection, identities)).length : null,
  });

  const key = nudge && teamMemberId ? aiNudgeDismissKey(teamMemberId, nudge) : null;
  // Remembered per person and kind in this browser; unreadable storage shows the nudge.
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!key || key in dismissed) return;
    let stored = false;
    try { stored = localStorage.getItem(key) === '1'; } catch { /* storage blocked: show it */ }
    setDismissed((prev) => ({ ...prev, [key]: stored }));
  }, [key, dismissed]);

  if (!nudge || !key || dismissed[key] !== false) return null;
  const copy = AI_NUDGE_COPY[nudge];
  const dismiss = () => {
    try { localStorage.setItem(key, '1'); } catch { /* storage blocked: hidden until reload */ }
    setDismissed((prev) => ({ ...prev, [key]: true }));
  };

  return (
    <div className="px-3 pb-3">
      <div role="note" aria-label={copy.title} className="relative rounded-lg bg-brand-500/[0.12] p-3 pr-9">
        <p className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <Sparkles size={16} className="flex-shrink-0 text-brand-300" aria-hidden="true" />
          {copy.title}
        </p>
        <p className="mt-1 text-xs text-zinc-400">{copy.line}</p>
        <Button size="sm" href={copy.href} onClick={onNavigate} className="mt-3">{copy.action}</Button>
        <div className="absolute right-1.5 top-1.5">
          <IconButton icon={<X />} label="Hide this" size="sm" tooltipPosition="right" onClick={dismiss} />
        </div>
      </div>
    </div>
  );
}
