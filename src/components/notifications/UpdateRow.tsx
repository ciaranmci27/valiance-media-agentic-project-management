'use client';

import { Bell, Bot, Check, CheckSquare, FileText, FolderKanban, MessageSquare, Repeat, Sparkles, Target, Undo2, Users, Webhook, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { formatAgo, formatFull } from '@/lib/time-format';
import { notificationSender, notificationSenderLabel, type NotificationView } from '@/lib/notifications';

/** What a notice is about, as its icon: by category first, then the thing it hangs on. */
function iconOf(n: NotificationView): LucideIcon {
  if (n.category === 'assistant_alert') return Sparkles;
  if (n.category === 'agent_message' || n.category.startsWith('agent_')) return Bot;
  if (n.category === 'invoice_drafts' || n.category === 'retainer_failed') return FileText;
  switch (n.entity_type) {
    case 'task': return CheckSquare;
    case 'project': return FolderKanban;
    case 'lead': return Target;
    case 'comment': return MessageSquare;
    case 'member': return Users;
    case 'webhook': return Webhook;
    case 'schedule': return Repeat;
    default: return Bell;
  }
}

type Member = { id: string; name: string; avatar?: string | null; role: string };

/**
 * One Update: what happened, who did it and when, unread marked with a dot.
 * The row opens its link; Done (or Not done, in the Done view) sits on the
 * right. `compact` is the bell's: one line of title, no message.
 */
export function UpdateRow({ notification, team, viewerId, onOpen, onDone, doneView = false, compact = false, title, message, unread: unreadOverride, extra, nested = false }: {
  notification: NotificationView;
  /** A group's line in place of the notice's title ("Website wireframes: 3 updates"). */
  title?: string;
  /** In place of the notice's message (a group shows its latest notice here). */
  message?: string | null;
  /** Unread, when a group says so for all its notices. */
  unread?: boolean;
  /** A control beside Done (a group's Show updates). */
  extra?: ReactNode;
  /** A notice listed under its group: indented, no icon tile. */
  nested?: boolean;
  team: readonly Member[];
  viewerId: string | null;
  onOpen: (n: NotificationView) => void;
  /** Done, or not done again in the Done view; left out, no button. */
  onDone?: (n: NotificationView) => void;
  doneView?: boolean;
  compact?: boolean;
}) {
  const Icon = iconOf(notification);
  const unread = unreadOverride ?? (!notification.is_read && !notification.done_at);
  const heading = title ?? notification.title;
  const body = message === undefined ? notification.message : message;
  const sender = notificationSender(notification, team);
  return (
    <div className={`group flex items-start gap-3 transition-colors hover:bg-white/[0.03] ${compact ? 'px-3 py-2.5' : nested ? 'py-2.5 pl-[60px] pr-4 lg:pl-[64px] lg:pr-5' : 'px-4 py-3 lg:px-5'} ${unread ? 'bg-brand-500/[0.05]' : ''}`}>
      <button
        type="button"
        onClick={() => onOpen(notification)}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {!nested && (
          <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${unread ? 'bg-brand-500/15 text-brand-300' : 'bg-white/[0.06] text-zinc-400'}`}>
            <Icon size={15} aria-hidden="true" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className={`block break-words text-sm ${compact ? 'line-clamp-1' : 'line-clamp-2'} ${unread ? 'font-semibold text-white' : 'font-medium text-zinc-300'}`}>
            {unread && <span className="sr-only">Unread: </span>}
            {heading}
          </span>
          {!compact && body && (
            <span className="mt-0.5 block break-words text-xs leading-relaxed text-zinc-400 line-clamp-2">{body}</span>
          )}
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
            {sender.kind === 'system'
              ? <Bell size={12} aria-hidden="true" className="flex-shrink-0 text-zinc-500" />
              : <Avatar name={sender.name} src={sender.avatar ?? undefined} id={sender.id} size="xs" />}
            <span className="min-w-0 truncate text-zinc-400">{notificationSenderLabel(sender, viewerId)}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={notification.created_at} title={formatFull(notification.created_at)} className="flex-shrink-0 tabular-nums">{formatAgo(notification.created_at)}</time>
          </span>
        </span>
      </button>
      <span className="flex flex-shrink-0 items-center gap-1.5 pt-1">
        {unread && <span className="h-2 w-2 rounded-full bg-brand-500" aria-hidden="true" />}
        {extra}
        {onDone && (
          <IconButton
            size="sm"
            icon={doneView ? <Undo2 /> : <Check />}
            label={doneView ? 'Not done' : 'Done'}
            tooltipPosition="left"
            onClick={() => onDone(notification)}
          />
        )}
      </span>
    </div>
  );
}
