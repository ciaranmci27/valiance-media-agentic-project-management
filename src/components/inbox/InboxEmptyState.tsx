'use client';

import { Check, Forward, Inbox as InboxIcon, Settings, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { hasPermission } from '@/lib/access-control';
import { useAuth } from '@/lib/auth-context';
import type { InboxSummary } from '@/lib/inbound-email/inbox-types';

/** The whole Inbox before any email has arrived: what it is and how mail gets here. */
export function InboxEmptyState({ inboxes }: { inboxes: InboxSummary[] }) {
  const { access } = useAuth();
  const canManage = hasPermission(access, 'inbound_email.manage');
  const hasInbox = inboxes.length > 0;

  const steps = [
    {
      icon: InboxIcon,
      title: 'Create an inbox',
      body: 'Pick the address clients write to and the agent that handles it.',
      done: hasInbox,
    },
    {
      icon: Forward,
      title: 'Forward client email',
      body: 'Point that address at the inbox relay address shown in Settings.',
      done: false,
    },
    {
      icon: Sparkles,
      title: 'The agent triages it',
      body: 'Tasks, drafted replies and questions for you show up here.',
      done: false,
    },
  ];

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-2xl text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.06]">
          <InboxIcon size={22} className="text-zinc-400" aria-hidden="true" />
        </div>
        <h2 className="text-base font-semibold text-white">No client email yet</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-zinc-400">
          Email lands here once an agent has read it, with the tasks it made and anything that needs you. Nothing is ever sent from here.
        </p>

        <ol className="mt-8 grid gap-3 text-left sm:grid-cols-3">
          {steps.map((step, index) => {
            const Icon = step.done ? Check : step.icon;
            return (
              <li key={step.title} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="flex items-center gap-2">
                  <span
                    className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${step.done ? 'bg-brand-500/15 text-brand-300' : 'bg-white/[0.06] text-zinc-400'}`}
                  >
                    <Icon size={14} aria-hidden="true" />
                  </span>
                  <span className="text-xs font-medium text-zinc-500">
                    Step {index + 1}
                    {step.done && <span className="sr-only"> (done)</span>}
                  </span>
                </div>
                <p className="mt-3 text-sm font-medium text-white">{step.title}</p>
                <p className="mt-1 text-xs text-zinc-400">{step.body}</p>
              </li>
            );
          })}
        </ol>

        {hasInbox && (
          <ul className="mx-auto mt-6 max-w-md space-y-2 text-left">
            {inboxes.map((inbox) => (
              <li key={inbox.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{inbox.name}</p>
                  <p className="truncate font-mono text-xs text-zinc-400">{inbox.address}</p>
                </div>
                <span className="flex-shrink-0 text-xs text-zinc-400">
                  {inbox.enabled ? (inbox.handler ? `Handled by ${inbox.handler.name}` : 'No handler yet') : 'Turned off'}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 flex justify-center">
          {canManage ? (
            <Button href="/settings#email-inboxes" variant={hasInbox ? 'secondary' : 'primary'} size="sm" icon={<Settings size={14} aria-hidden="true" />}>
              {hasInbox ? 'Inbox settings' : 'Set up an inbox'}
            </Button>
          ) : (
            !hasInbox && <p className="text-xs text-zinc-400">Ask an admin to set up an inbox in Settings.</p>
          )}
        </div>
      </div>
    </div>
  );
}
