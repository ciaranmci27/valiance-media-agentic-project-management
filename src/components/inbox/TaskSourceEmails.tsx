'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Mail } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { inboxClient } from '@/lib/inbound-email/inbox-client';
import type { TaskSourceEmails as TaskSourceEmailsData } from '@/lib/inbound-email/inbox-types';
import { formatFullTime } from './inbox-badges';

/** The client emails a task came from. */
export function useTaskSourceEmails(taskId: string | null): TaskSourceEmailsData | null {
  const { isDemoMode } = useDemo();
  const { emailsRefreshSignal } = useApp();
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const [data, setData] = useState<{ taskId: string; value: TaskSourceEmailsData } | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    client.taskSources(taskId)
      .then((value) => { if (!cancelled) setData({ taskId, value }); })
      .catch(() => { if (!cancelled) setData({ taskId, value: { link_count: 0, emails: [] } }); });
    return () => { cancelled = true; };
  }, [client, taskId, emailsRefreshSignal]);

  return data && data.taskId === taskId ? data.value : null;
}

export function TaskSourceEmailsSection({ data }: { data: TaskSourceEmailsData | null }) {
  if (!data || data.link_count === 0) return null;
  const hidden = data.link_count - data.emails.length;
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300">
        <Mail size={14} aria-hidden="true" />
        Source emails
      </h3>
      {data.emails.length > 0 && (
        <ul className="space-y-1">
          {data.emails.map((email) => (
            <li key={`${email.message_id}-${email.relation}`}>
              <Link
                href={`/inbox?thread=${email.thread_id}&message=${email.message_id}`}
                className="block rounded-lg bg-white/[0.03] p-2 transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <span className="block truncate text-sm text-zinc-200">{email.subject || '(no subject)'}</span>
                <span className="mt-0.5 block truncate text-xs text-zinc-400">
                  {email.from?.name || email.from?.address || 'Unknown sender'}, {formatFullTime(email.received_at)}, {email.relation === 'created' ? 'created this task' : 'updated this task'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="text-xs text-zinc-400">
          {hidden === 1 ? 'One more email is' : `${hidden} more emails are`} in an inbox you cannot open.
        </p>
      )}
    </div>
  );
}
