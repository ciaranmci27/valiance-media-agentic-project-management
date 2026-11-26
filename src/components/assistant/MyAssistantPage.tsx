'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Mail, PauseCircle, Sparkles, Zap } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { QuestionCard } from '@/components/questions/QuestionCard';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { myAssistantActivityRead, myAssistantRead, useOpenQuestions } from '@/lib/reads';
import { timeAgo } from '@/lib/task-times';
import {
  BROKEN_WORDS, fixerWords, HOLD_WORDS, HOST_DOWN_WORDS, PERSON_STATE_WORDS, type BrokenReason, type HoldReason, type MyAssistantView,
} from '@/lib/assistant';
import { AssistantActivityBand } from './AssistantActivityBand';
import { AssistantChatCard } from './AssistantChatCard';
import { AssistantSettingsCard } from './AssistantSettingsCard';
import { AssistantMemoryCard } from './AssistantMemoryCard';

type Assistant = NonNullable<MyAssistantView['assistant']>;

/**
 * My Assistant: one page per person for their own assistant. What needs
 * them (its questions, approvals and reply drafts) first, then what it did
 * (each line with its undo), and beside them its settings and chat. No keys,
 * scopes, templates or rules: those live in the Agents area for admins.
 * With assistants off for the workspace, someone who has one still sees it,
 * on hold, with every control; someone who has none reads that they are off.
 * Not working says why, and who fixes it: an admin who was told, or, for an
 * Owner (or when nobody else could be told), Settings > Assistants.
 */
export function MyAssistantPage() {
  const { isDemoMode } = useDemo();
  const { access } = useAuth();
  const read = useRead(myAssistantRead(isDemoMode));
  const view = read.data;
  const isOwner = access?.role === 'owner';
  const label = view?.label ?? 'Assistant';

  if (!view) {
    return (
      <div className="animate-fadeIn min-h-screen">
        <Header title={label} />
        <div className="p-4 lg:p-6">
          {read.failed ? (
            <div role="alert" className="mx-auto max-w-5xl glass-card rounded-xl flex flex-wrap items-center gap-3 px-4 py-4 text-sm text-zinc-300">
              Could not load your assistant.
              <Button variant="secondary" size="sm" onClick={read.reload}>Try again</Button>
            </div>
          ) : (
            <div className="mx-auto flex max-w-5xl items-center gap-2 text-sm text-zinc-400" role="status">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />Loading your assistant
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!view.agents_on || !view.assistant) {
    const noAgents = !view.agents_on;
    const off = !view.enabled;
    const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
    const title = noAgents ? `${label}s are not turned on yet` : off ? `${label}s are off for your workspace` : `You don't have ${article} ${label.toLowerCase()} yet`;
    return (
      <div className="animate-fadeIn min-h-screen">
        <Header title={label} />
        <div className="p-4 lg:p-6">
          <div className="mx-auto max-w-3xl glass-card rounded-xl py-16 px-6 text-center">
            <Sparkles size={28} className="mx-auto mb-3 text-brand-300" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-zinc-400">
              {isOwner
                ? noAgents ? 'Turn on AI agents, then assistants, in Settings.' : off ? 'Turn them on in Settings, then give your team theirs in one step.' : 'Give yourself and your team one in Settings.'
                : off || noAgents ? 'An Owner turns them on for everyone. Ask them if you would like one.' : 'Ask an Owner to set one up for you. It keeps your work moving and answers you in chat.'}
            </p>
            {isOwner && <Button className="mt-5" href="/settings/assistants">Open Assistant settings</Button>}
          </div>
        </div>
      </div>
    );
  }

  return <AssistantHome view={view} assistant={view.assistant} isDemo={isDemoMode} />;
}

function AssistantHome({ view, assistant, isDemo }: { view: MyAssistantView; assistant: Assistant; isDemo: boolean }) {
  const { teamMemberId, access } = useAuth();
  const isOwnerHere = access?.role === 'owner';
  const openQuestions = useOpenQuestions();
  const activity = useRead(myAssistantActivityRead(isDemo)).data;
  const router = useRouter();
  const questions = openQuestions.filter((question) => question.asked_by === assistant.id);
  const drafts = activity?.drafts ?? [];
  const needsCount = questions.length + drafts.length;
  const broken = assistant.state === 'broken';

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title={view.label}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <AgentAvatar id={assistant.id} name={assistant.name} tone={assistant.avatar_tone} size="xs"
              presence={assistant.state === 'working' ? 'idle' : assistant.state === 'getting_ready' ? 'idle' : 'paused'} />
            <span className="text-zinc-300">{assistant.name}</span>
            <span aria-hidden="true">·</span>
            <span>{PERSON_STATE_WORDS[assistant.state]}</span>
          </span>
        }
      />
      <div className="p-4 lg:p-6">
        <div className="mx-auto max-w-5xl space-y-5">
          {broken && assistant.reason && (
            <div role="status" className="flex flex-wrap items-start gap-3 rounded-xl bg-amber-500/[0.14] px-4 py-3">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium text-amber-300">{assistant.name} is not working.</p>
                <p className="text-sm text-zinc-200">{BROKEN_WORDS[assistant.reason as BrokenReason]} {fixerWords(assistant.fixer)}</p>
              </div>
              {assistant.fixer === 'settings' && isOwnerHere && <Button size="sm" variant="secondary" href="/settings/assistants#assistant-service">Fix it</Button>}
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

          <div className="grid gap-5 lg:grid-cols-5">
            <div className="space-y-5 lg:col-span-3">
              <section className="glass-card rounded-xl overflow-hidden border border-amber-500/20" aria-labelledby="assistant-needs-heading">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-500/15 bg-amber-500/[0.05]">
                  <Zap size={15} className="text-amber-300" aria-hidden="true" />
                  <h2 id="assistant-needs-heading" className="text-sm font-semibold text-white">Needs you</h2>
                  <span className={`text-xs tabular-nums px-1.5 py-0.5 rounded-full ${needsCount > 0 ? 'bg-amber-500/15 text-amber-300' : 'bg-white/[0.06] text-zinc-400'}`}>{needsCount}</span>
                  <span className="text-xs text-zinc-500 ml-auto hidden sm:block truncate pl-3">questions, approvals and drafts</span>
                </div>
                {needsCount === 0 ? (
                  <p className="px-4 py-6 text-sm text-zinc-400">Nothing needs you. When {assistant.name} has a question or a draft for you, it lands here.</p>
                ) : (
                  <div className="divide-y divide-white/[0.04]">
                    {questions.map((question) => (
                      <QuestionCard key={question.id} question={question} variant="band" place
                        onOpenTask={(taskId) => router.push(question.project_id ? `/projects/${question.project_id}?task=${taskId}` : '/my-tasks')} />
                    ))}
                    {drafts.map((draft) => (
                      <div key={draft.id} className="flex items-center gap-3 px-4 py-3">
                        <Mail size={15} className="flex-shrink-0 text-sky-300" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-zinc-200">Reply draft ready{draft.subject ? `: ${draft.subject}` : ''}</p>
                          {draft.completed_at && <p className="text-[11px] text-zinc-500 tabular-nums">{timeAgo(draft.completed_at)}</p>}
                        </div>
                        <Link href={`/inbox?thread=${draft.thread_id}`} className="flex-shrink-0 rounded-md px-2 py-1 text-xs font-medium text-brand-300 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                          Open
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <AssistantActivityBand assistantName={assistant.name} isDemo={isDemo} />
              {teamMemberId && (
                <AssistantMemoryCard personId={teamMemberId} assistantName={assistant.name} remembering={assistant.preferences.switches.remember} isDemo={isDemo} />
              )}
            </div>
            <div className="space-y-5 lg:col-span-2">
              <AssistantSettingsCard assistant={assistant} isDemo={isDemo} />
              <AssistantChatCard connections={view.connections} assistantName={assistant.name} isDemo={isDemo} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
