'use client';

import { AlertTriangle, Loader2, PauseCircle, Sparkles } from 'lucide-react';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { aiHomeHref } from '@/lib/ai-home';
import {
  BROKEN_WORDS, fixerWords, HOLD_WORDS, HOST_DOWN_WORDS, PERSON_STATE_WORDS, type BrokenReason, type HoldReason, type MyAssistantView,
} from '@/lib/assistant';
import { AssistantActivityBand } from './AssistantActivityBand';
import { AssistantChatCard } from './AssistantChatCard';
import { AssistantSettingsCard } from './AssistantSettingsCard';
import { AssistantMemoryCard } from './AssistantMemoryCard';

type Assistant = NonNullable<MyAssistantView['assistant']>;

/**
 * The person's own assistant, inside AI > Your assistant: what it did (each
 * line with its undo), what it remembers, and beside them its settings and
 * chat. What it needs from the person sits above it, in the AI home's Needs
 * you. No keys, scopes, templates or rules: those live in Company AI and
 * Setup. Shown only while assistants are on (the AI home decides); someone
 * without one reads how to get one. Not working says why, and who fixes it:
 * an admin who was told, or, for an Owner, Setup.
 */
export function AssistantSection({ view, onOpenSetup }: { view: MyAssistantView; onOpenSetup?: () => void }) {
  const { isDemoMode } = useDemo();
  const { access } = useAuth();
  const isOwner = access?.role === 'owner';
  const label = view.label || 'Assistant';

  if (!view.assistant) {
    const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
    return (
      <EmptyState
        framed
        icon={<Sparkles />}
        title={`You don't have ${article} ${label.toLowerCase()} yet`}
        description={isOwner
          ? 'Give yourself and your team one in Setup. It keeps your work moving and answers you in chat.'
          : 'Ask an Owner to set one up for you. It keeps your work moving and answers you in chat.'}
        action={isOwner && onOpenSetup ? <Button size="sm" onClick={onOpenSetup}>Open Setup</Button> : undefined}
      />
    );
  }

  return <AssistantHome assistant={view.assistant} view={view} isDemo={isDemoMode} />;
}

function AssistantHome({ view, assistant, isDemo }: { view: MyAssistantView; assistant: Assistant; isDemo: boolean }) {
  const { teamMemberId, access } = useAuth();
  const isOwnerHere = access?.role === 'owner';
  const broken = assistant.state === 'broken';

  return (
    <div className="space-y-6">
      <p className="flex items-center gap-2 text-sm text-zinc-400">
        <AgentAvatar id={assistant.id} name={assistant.name} tone={assistant.avatar_tone} size="xs"
          presence={assistant.state === 'working' ? 'idle' : assistant.state === 'getting_ready' ? 'idle' : 'paused'} />
        <span className="font-medium text-zinc-200">{assistant.name}</span>
        <span aria-hidden="true">·</span>
        <span>{PERSON_STATE_WORDS[assistant.state]}</span>
      </p>
      {broken && assistant.reason && (
        <div role="status" className="flex flex-wrap items-start gap-3 rounded-xl bg-amber-500/[0.14] px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium text-amber-300">{assistant.name} is not working.</p>
            <p className="text-sm text-zinc-200">{BROKEN_WORDS[assistant.reason as BrokenReason]} {fixerWords(assistant.fixer)}</p>
          </div>
          {assistant.fixer === 'settings' && isOwnerHere && <Button size="sm" variant="secondary" href={aiHomeHref('setup', {}, 'assistant-service')}>Fix it</Button>}
        </div>
      )}
      {assistant.state === 'on_hold' && assistant.reason && (
        <div role="status" className="flex items-start gap-3 rounded-xl bg-white/[0.04] px-4 py-3">
          <PauseCircle size={16} className="mt-0.5 flex-shrink-0 text-zinc-400" aria-hidden="true" />
          <div className="space-y-1">
            {assistant.host_down && <p className="text-sm font-medium text-zinc-100">{HOST_DOWN_WORDS} {fixerWords(assistant.fixer)}</p>}
            <p className="text-sm text-zinc-300">{HOLD_WORDS[assistant.reason as HoldReason].person}</p>
          </div>
        </div>
      )}
      {assistant.state === 'getting_ready' && (
        <div role="status" className="flex items-start gap-3 rounded-xl bg-white/[0.04] px-4 py-3">
          <Loader2 size={16} className="mt-0.5 flex-shrink-0 animate-spin text-zinc-400" aria-hidden="true" />
          <p className="text-sm text-zinc-300">{assistant.name} is getting ready. This takes a few minutes; set it up below meanwhile.</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <AssistantActivityBand assistantName={assistant.name} isDemo={isDemo} />
          {teamMemberId && (
            <AssistantMemoryCard personId={teamMemberId} assistantName={assistant.name} remembering={assistant.preferences.switches.remember} isDemo={isDemo} />
          )}
        </div>
        <div className="space-y-6 lg:col-span-2">
          <AssistantSettingsCard assistant={assistant} isDemo={isDemo} />
          <AssistantChatCard connections={view.connections} assistantName={assistant.name} isDemo={isDemo} />
        </div>
      </div>
    </div>
  );
}
