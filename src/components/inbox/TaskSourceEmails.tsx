'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment } from 'react';
import { ArrowUpRight, Mail } from 'lucide-react';
import { NewSinceDivider } from '@/components/tasks/TaskUnread';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { taskEmailCountsRead, taskEmailsRead } from '@/lib/reads';
import type { TaskSourceEmails as TaskSourceEmailsData } from '@/lib/inbound-email/inbox-types';
import { formatFullTime } from './inbox-badges';

/** The client emails linked to a task: a cached read, warmed before the panel opens. */
export function useTaskSourceEmails(taskId: string | null): TaskSourceEmailsData | null {
  const { isDemoMode } = useDemo();
  const read = useRead(taskId ? taskEmailsRead(taskId, isDemoMode) : null);
  if (read.data) return read.data;
  // A failed read shows as no emails, never as a load that does not end.
  return read.failed ? NO_EMAILS : null;
}

const NO_EMAILS: TaskSourceEmailsData = { link_count: 0, emails: [] };

/** How many emails link to the task; 0 until loaded and in demo mode. */
export function useTaskEmailCount(taskId: string): number {
  return useKnownTaskEmailCount(taskId) ?? 0;
}

/** The same count, or undefined while it is not known (still loading, demo mode). */
export function useKnownTaskEmailCount(taskId: string): number | undefined {
  const { isDemoMode } = useDemo();
  const counts = useRead(isDemoMode ? null : taskEmailCountsRead).data;
  return counts ? counts.get(taskId) ?? 0 : undefined;
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
export function TaskSourceEmailsSection({ data, taskId, projectId, heading = true, expected = 0, isNew }: {
  data: TaskSourceEmailsData | null;
  /** Linked since the person last looked: a divider goes above the first. */
  isNew?: (email: TaskSourceEmailsData['emails'][number]) => boolean;
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
  const firstNew = isNew ? data.emails.findIndex(isNew) : -1;
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
          {data.emails.map((email, index) => (
            <Fragment key={`${email.message_id}-${email.relation}`}>
            {index === firstNew && <NewSinceDivider />}
            <li>
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
            </Fragment>
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
