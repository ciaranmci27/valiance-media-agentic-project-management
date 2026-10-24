'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, Mail } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { inboxClient } from '@/lib/inbound-email/inbox-client';
import { createClient } from '@/lib/supabase/client';
import type { TaskSourceEmails as TaskSourceEmailsData } from '@/lib/inbound-email/inbox-types';
import { formatFullTime } from './inbox-badges';

/** The client emails a task came from. */
// A task's emails, kept for the session: hovering a card fetches them, so the
// panel opens with them, and reopening a task never shows a load.
const sourceCache = new Map<string, TaskSourceEmailsData>();
const sourceRequests = new Map<string, Promise<TaskSourceEmailsData>>();

function fetchTaskSources(client: ReturnType<typeof inboxClient>, taskId: string): Promise<TaskSourceEmailsData> {
  const pending = sourceRequests.get(taskId);
  if (pending) return pending;
  const request = client.taskSources(taskId)
    .then((value) => { sourceCache.set(taskId, value); return value; })
    .finally(() => { sourceRequests.delete(taskId); });
  sourceRequests.set(taskId, request);
  return request;
}

/** Warm a task's emails before it opens (a card hovered or focused). */
export function usePrefetchTaskSources(): (taskId: string) => void {
  const { isDemoMode } = useDemo();
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  return (taskId: string) => {
    if (!sourceCache.has(taskId)) void fetchTaskSources(client, taskId).catch(() => undefined);
  };
}

export function useTaskSourceEmails(taskId: string | null): TaskSourceEmailsData | null {
  const { isDemoMode } = useDemo();
  const { emailsRefreshSignal } = useApp();
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const [data, setData] = useState<{ taskId: string; value: TaskSourceEmailsData } | null>(null);

  // Always refreshed on open and on inbox changes; the kept copy shows meanwhile.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    fetchTaskSources(client, taskId)
      .then((value) => { if (!cancelled) setData({ taskId, value }); })
      .catch(() => { if (!cancelled) setData({ taskId, value: { link_count: 0, emails: [] } }); });
    return () => { cancelled = true; };
  }, [client, taskId, emailsRefreshSignal]);

  if (data && data.taskId === taskId) return data.value;
  return taskId ? sourceCache.get(taskId) ?? null : null;
}

// How many emails each task is linked to, for the cards: one light read for
// every task, again whenever inbox data changes. Only links the person can read.
let emailCounts = new Map<string, number>();
let countsVersion = 0;
let countsLoadedFor: number | null = null;
const countListeners = new Set<() => void>();

async function loadEmailCounts(signal: number) {
  if (countsLoadedFor === signal) return;
  countsLoadedFor = signal;
  const supabase = createClient();
  const next = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('email_task_links').select('task_id').order('id').range(from, from + 999);
    if (error) return;
    for (const row of (data ?? []) as { task_id: string }[]) next.set(row.task_id, (next.get(row.task_id) ?? 0) + 1);
    if (!data || data.length < 1000) break;
  }
  emailCounts = next;
  countsVersion++;
  countListeners.forEach((listener) => listener());
}

function subscribeCounts(listener: () => void) {
  countListeners.add(listener);
  return () => { countListeners.delete(listener); };
}

/** How many emails link to the task; 0 until loaded and in demo mode. */
export function useTaskEmailCount(taskId: string): number {
  const { isDemoMode } = useDemo();
  const { emailsRefreshSignal } = useApp();
  useEffect(() => {
    if (!isDemoMode) void loadEmailCounts(emailsRefreshSignal);
  }, [isDemoMode, emailsRefreshSignal]);
  useSyncExternalStore(subscribeCounts, () => countsVersion, () => 0);
  return isDemoMode ? 0 : emailCounts.get(taskId) ?? 0;
}

const RELATION: Record<TaskSourceEmailsData['emails'][number]['relation'], string> = {
  created: 'started this task',
  updated: 'changed this task',
  related: 'is about this task',
};

/**
 * Every email linked to the task, oldest first: who wrote it, when, and how
 * it bears on the task, with the whole conversation one click away in the
 * Inbox filtered to this task. `heading={false}` when the caller's own
 * section supplies the title.
 */
export function TaskSourceEmailsSection({ data, taskId, projectId, heading = true, expected = 0 }: {
  data: TaskSourceEmailsData | null;
  taskId?: string | null;
  /** The task's project: inside that project's page, links open its Communication tab, not the Inbox. */
  projectId?: string | null;
  heading?: boolean;
  /** Emails known to be linked (the card count): placeholder rows until the list arrives. */
  expected?: number;
}) {
  const pathname = usePathname();
  if (!data && expected > 0) {
    return (
      <ul className="space-y-1" aria-busy="true" aria-label="Loading linked emails">
        {Array.from({ length: Math.min(expected, 3) }).map((_, i) => (
          <li key={i} className="space-y-1.5 rounded-lg bg-white/[0.03] p-2">
            <div className="h-3.5 w-3/4 animate-pulse rounded bg-white/[0.08] motion-reduce:animate-none" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-white/[0.05] motion-reduce:animate-none" />
          </li>
        ))}
      </ul>
    );
  }
  if (!data || data.link_count === 0) return null;
  const hidden = data.link_count - data.emails.length;
  const inProject = !!projectId && !!pathname?.startsWith(`/projects/${projectId}`);
  const emailHref = (threadId: string, messageId: string) => inProject
    ? `/projects/${projectId}?tab=communication&thread=${threadId}&message=${messageId}`
    : `/inbox?thread=${threadId}&message=${messageId}`;
  return (
    <div className="space-y-2">
      {heading && (
        <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300">
          <Mail size={14} aria-hidden="true" />
          Communication
        </h3>
      )}
      {data.emails.length > 0 && (
        <ul className="space-y-1">
          {data.emails.map((email) => (
            <li key={`${email.message_id}-${email.relation}`}>
              <Link
                href={emailHref(email.thread_id, email.message_id)}
                className="block rounded-lg bg-white/[0.03] p-2 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <span className="block truncate text-sm text-zinc-200">{email.subject || '(no subject)'}</span>
                <span className="mt-0.5 block truncate text-xs text-zinc-400">
                  {email.from?.name || email.from?.address || 'Unknown sender'}, {formatFullTime(email.received_at)}, {RELATION[email.relation]}{email.by === 'person' ? ' (linked by a person)' : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {taskId && data.emails.length > 0 && (
        <Link
          href={inProject ? `/projects/${projectId}?tab=communication&email_task=${taskId}` : `/inbox?task=${taskId}`}
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {inProject ? 'Open in Communication' : 'Open in the Inbox'}
          <ArrowUpRight size={12} aria-hidden="true" />
        </Link>
      )}
      {hidden > 0 && (
        <p className="text-xs text-zinc-400">
          {hidden === 1 ? 'One more email is' : `${hidden} more emails are`} in an inbox you cannot open.
        </p>
      )}
    </div>
  );
}
