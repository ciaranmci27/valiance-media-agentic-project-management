'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, type ReactNode } from 'react';
import { ArrowUpRight, Mail, Video } from 'lucide-react';
import { NewSinceDivider } from '@/components/tasks/TaskUnread';
import { Tooltip } from '@/components/ui/Tooltip';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { taskEmailsRead, taskLinkCountsRead, type TaskLinkCounts } from '@/lib/reads';
import { meetingPackageOf, type TaskSourceEmail, type TaskSourceEmails as TaskSourceEmailsData } from '@/lib/communications/inbox-types';
import { formatDay, formatFullTime, formatMeetingTime } from './inbox-badges';

export type { TaskLinkCounts };

/** The client emails and meetings linked to a task: a cached read, warmed before the panel opens. */
export function useTaskSourceEmails(taskId: string | null): TaskSourceEmailsData | null {
  const { isDemoMode } = useDemo();
  const read = useRead(taskId ? taskEmailsRead(taskId, isDemoMode) : null);
  if (read.data) return read.data;
  // A failed read shows as no emails, never as a load that does not end.
  return read.failed ? NO_EMAILS : null;
}

const NO_EMAILS: TaskSourceEmailsData = { link_count: 0, emails: [] };
const NO_LINKS: TaskLinkCounts = { emails: 0, meetings: 0 };

/** How many emails and meetings link to the task; none until loaded and in demo mode. */
export function useTaskLinkCounts(taskId: string): TaskLinkCounts {
  return useKnownTaskLinkCounts(taskId) ?? NO_LINKS;
}

/** The same counts, or undefined while they are not known (still loading, demo mode). */
export function useKnownTaskLinkCounts(taskId: string): TaskLinkCounts | undefined {
  const { isDemoMode } = useDemo();
  const counts = useRead(isDemoMode ? null : taskLinkCountsRead).data;
  return counts ? counts.get(taskId) ?? NO_LINKS : undefined;
}

/**
 * The counts from the task's own list, once it is read: each email once,
 * each meeting once however many of its packages link it, and links in an
 * inbox the person cannot open counted as emails (as the cards count them).
 */
export function linkCountsOf(data: TaskSourceEmailsData): TaskLinkCounts {
  const emails = new Set(data.emails.filter((e) => e.channel !== 'meeting').map((e) => e.message_id));
  const meetings = new Set(data.emails.filter((e) => e.channel === 'meeting').map((e) => e.thread_id));
  return { emails: emails.size + Math.max(0, data.link_count - data.emails.length), meetings: meetings.size };
}

/** What the linked list holds, in words: "Emails", "Meetings" or "Emails and meetings". */
export function linkSectionTitle(counts: TaskLinkCounts): string {
  if (counts.meetings && counts.emails) return 'Emails and meetings';
  return counts.meetings ? 'Meetings' : 'Emails';
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * A task's linked emails and meetings as two counts, each shown only above
 * zero: the Mail icon for emails, the meeting icon for meetings, with a
 * tooltip. `className` and `iconSize` match the counts beside it (comments,
 * files) in each place.
 */
export function TaskLinkCountBadges({ counts, className, iconSize }: { counts: TaskLinkCounts; className: string; iconSize: number }) {
  return (
    <>
      {counts.emails > 0 && (
        <Tooltip content={plural(counts.emails, 'linked email')}>
          <span className={className}>
            <Mail size={iconSize} aria-hidden="true" />
            <span className="sr-only">{plural(counts.emails, 'linked email')}</span>
            <span aria-hidden="true">{counts.emails}</span>
          </span>
        </Tooltip>
      )}
      {counts.meetings > 0 && (
        <Tooltip content={plural(counts.meetings, 'linked meeting')}>
          <span className={className}>
            <Video size={iconSize} aria-hidden="true" />
            <span className="sr-only">{plural(counts.meetings, 'linked meeting')}</span>
            <span aria-hidden="true">{counts.meetings}</span>
          </span>
        </Tooltip>
      )}
    </>
  );
}

const RELATION: Record<TaskSourceEmail['relation'], string> = {
  created: 'started this task',
  updated: 'changed this task',
  related: 'is about this task',
};

const ROW = 'block min-w-0 rounded-lg bg-white/[0.03] p-2 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/** One meeting in the list: every package of it that links the task, folded into one row. */
interface MeetingEntry {
  first: TaskSourceEmail;
  packages: TaskSourceEmail[];
}

/**
 * Every email and meeting linked to the task, oldest first, in two groups
 * when it has both: an email by subject and sender, a meeting by its title
 * and time (once, however many of its packages link the task). Each opens
 * where it lives; the whole conversation set is one click away in the Inbox
 * filtered to this task. `heading={false}` when the caller's own section
 * supplies the title.
 */
export function TaskSourceEmailsSection({ data, taskId, projectId, heading = true, expected = 0, isNew }: {
  data: TaskSourceEmailsData | null;
  /** Linked since the person last looked: a divider goes above the first. */
  isNew?: (email: TaskSourceEmail) => boolean;
  taskId?: string | null;
  /** The task's project: inside that project's page, links open its Communication tab, not the Inbox. */
  projectId?: string | null;
  heading?: boolean;
  /** Emails and meetings known to be linked (the card counts): placeholder rows until the list arrives. */
  expected?: number;
}) {
  const pathname = usePathname();
  if (!data && expected > 0) {
    return (
      <ul className="space-y-1" aria-busy="true" aria-label="Loading linked emails and meetings">
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
  const href = (threadId: string, messageId: string) => inProject
    ? `/projects/${projectId}?tab=communication&thread=${threadId}&message=${messageId}`
    : `/inbox?thread=${threadId}&message=${messageId}`;
  const emails = data.emails.filter((e) => e.channel !== 'meeting');
  const meetings: MeetingEntry[] = [];
  for (const link of data.emails.filter((e) => e.channel === 'meeting')) {
    const entry = meetings.find((m) => m.first.thread_id === link.thread_id);
    if (entry) entry.packages.push(link);
    else meetings.push({ first: link, packages: [link] });
  }
  const both = emails.length > 0 && meetings.length > 0;
  const firstNewEmail = isNew ? emails.findIndex(isNew) : -1;
  const firstNewMeeting = isNew ? meetings.findIndex((m) => m.packages.some(isNew)) : -1;
  const title = linkSectionTitle(linkCountsOf(data));
  return (
    <div className="min-w-0 space-y-2">
      {heading && (
        <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300">
          <Mail size={14} aria-hidden="true" />
          {title}
        </h3>
      )}
      {emails.length > 0 && (
        <div className="space-y-1">
          {both && <GroupLabel icon={<Mail size={12} aria-hidden="true" />} text={emails.length === 1 ? 'Email' : 'Emails'} />}
          <ul className="space-y-1" aria-label="Linked emails">
            {emails.map((email, index) => (
              <Fragment key={`${email.message_id}-${email.relation}`}>
                {index === firstNewEmail && <NewSinceDivider />}
                <li>
                  <Link href={href(email.thread_id, email.message_id)} className={ROW}>
                    <span className="block truncate text-sm text-zinc-200">{email.subject || '(no subject)'}</span>
                    <span className="mt-0.5 block truncate text-xs text-zinc-400">
                      {email.from?.name || email.from?.address || 'Unknown sender'}, {formatFullTime(email.received_at)}, {RELATION[email.relation]}{email.by === 'person' ? ' (linked by a person)' : ''}
                    </span>
                  </Link>
                </li>
              </Fragment>
            ))}
          </ul>
        </div>
      )}
      {meetings.length > 0 && (
        <div className="space-y-1">
          {both && <GroupLabel icon={<Video size={12} aria-hidden="true" />} text={meetings.length === 1 ? 'Meeting' : 'Meetings'} />}
          <ul className="space-y-1" aria-label="Linked meetings">
            {meetings.map((meeting, index) => {
              const { first, packages } = meeting;
              const when = formatMeetingTime(first.meeting_starts_at, null) ?? formatDay(first.received_at);
              const kinds = [...new Set(packages.map((p) => (meetingPackageOf(p.subject) === 'notes' ? "Gemini's notes" : 'Transcript')))];
              return (
                <Fragment key={first.thread_id}>
                  {index === firstNewMeeting && <NewSinceDivider />}
                  <li>
                    <Link href={href(first.thread_id, first.message_id)} className={ROW}>
                      <span className="flex min-w-0 items-center gap-1.5 text-sm text-zinc-200">
                        <Video size={13} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
                        <span className="sr-only">Meeting: </span>
                        <span className="truncate">{first.meeting_title || 'Untitled meeting'}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-zinc-400">
                        {when}, {kinds.join(' and ')}, {RELATION[first.relation]}{first.by === 'person' ? ' (linked by a person)' : ''}
                      </span>
                    </Link>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </div>
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
          {hidden === 1 ? 'One more email or meeting is' : `${hidden} more emails or meetings are`} in an inbox you cannot open.
        </p>
      )}
    </div>
  );
}

function GroupLabel({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <p className="flex items-center gap-1.5 pt-0.5 text-[11px] font-medium text-zinc-400">
      {icon}
      {text}
    </p>
  );
}
