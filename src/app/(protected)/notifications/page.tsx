'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckSquare, FolderKanban, Target, MessageSquare, Users, Loader2, CheckCheck, Webhook, Repeat } from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import type { NotificationEntityType } from '@/lib/types';
import { appLocale } from '@/lib/region';
import { peekRead, setReadData, useRead } from '@/lib/query-cache';
import { fetchNotificationPage, notificationsRead, unreadNotificationsRead } from '@/lib/reads';
import { useNeedsYouActions } from '@/lib/needs-you-actions';
import type { NotificationFeedView, NotificationPage, NotificationView } from '@/lib/notifications';

type FilterTab = 'all' | 'unread';

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString(appLocale());
}

function getEntityIcon(entityType: NotificationEntityType | null) {
  switch (entityType) {
    case 'task':    return CheckSquare;
    case 'project': return FolderKanban;
    case 'lead':    return Target;
    case 'comment': return MessageSquare;
    case 'member':  return Users;
    case 'webhook': return Webhook;
    case 'schedule': return Repeat;
    default:        return Bell;
  }
}

/** Later pages, kept under the first page they follow; a fresh first page drops them. */
interface MorePages {
  base: NotificationPage | undefined;
  items: NotificationView[];
  cursor: string | null;
}

const VIEWS: readonly NotificationFeedView[] = ['updates', 'unread'];

/**
 * Updates: notifications about what happened, newest first. A notice that
 * announces something waiting on you (a question or approval asked, an
 * agent's findings, an inbox decision) is not listed here: that item is in
 * Needs you, counted once. The first page is a cached read (live sync
 * refreshes it); Load more reads the pages after it.
 */
export default function NotificationsPage() {
  const router = useRouter();
  const { isDemoMode } = useDemo();
  const actions = useNeedsYouActions();
  const [filter, setFilter] = useState<FilterTab>('all');
  const view: NotificationFeedView = filter === 'unread' ? 'unread' : 'updates';
  const first = useRead(notificationsRead(view, isDemoMode));
  const unreadCount = useRead(unreadNotificationsRead(isDemoMode)).data ?? first.data?.unread ?? 0;
  const [more, setMore] = useState<MorePages>({ base: undefined, items: [], cursor: null });
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // A refreshed or switched first page starts the list over, as a new notification should.
  const current = more.base === first.data ? more : { base: first.data, items: [], cursor: first.data?.next_cursor ?? null };
  const notifications = [...(first.data?.items ?? []), ...current.items];
  const isLoading = first.loading;
  const hasMore = !!current.cursor && !isDemoMode;

  const loadMore = async () => {
    if (isLoadingMore || !current.cursor) return;
    setIsLoadingMore(true);
    try {
      const page = await fetchNotificationPage(view, current.cursor);
      setMore({ base: first.data, items: [...current.items, ...page.items], cursor: page.next_cursor });
    } catch (error) {
      console.error('Error fetching notifications:', error);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Shown at once on every cached list and the count; the write then refreshes them.
  const markLocally = (read: (n: NotificationView) => boolean) => {
    const update = (list: NotificationView[]) => list.map((n) => (read(n) ? { ...n, is_read: true } : n));
    for (const v of VIEWS) {
      const cached = notificationsRead(v, isDemoMode);
      const page = peekRead(cached);
      if (!page) continue;
      setReadData(cached, () => ({ ...page, items: v === 'unread' ? page.items.filter((n) => !read(n)) : update(page.items) }));
    }
    // Pages loaded after the first one stay, under the first page as it now reads.
    const base = first.data;
    const nextBase = peekRead(notificationsRead(view, isDemoMode));
    setMore((m) => (m.base && m.base === base ? { base: nextBase, items: update(m.items), cursor: m.cursor } : m));
  };

  const handleMarkAsRead = async (id: string) => {
    markLocally((n) => n.id === id);
    setReadData(unreadNotificationsRead(isDemoMode), (n) => Math.max(0, (n ?? 0) - 1));
    await actions.markRead([id]);
  };

  const handleMarkAllAsRead = async () => {
    if (unreadCount === 0) return;
    markLocally(() => true);
    setReadData(unreadNotificationsRead(isDemoMode), () => 0);
    await actions.markRead('all');
  };

  const handleNotificationClick = async (notification: NotificationView) => {
    if (!notification.is_read) await handleMarkAsRead(notification.id);
    if (notification.link) router.push(notification.link);
  };

  const tabs: { id: FilterTab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'unread', label: 'Unread' },
  ];

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Notifications"
        subtitle={
          <span className="hidden sm:inline">
            {unreadCount > 0 ? `${unreadCount} unread` : 'You are all caught up'}
          </span>
        }
        actions={
          <Button variant="secondary" size="sm" onClick={handleMarkAllAsRead} disabled={unreadCount === 0}>
            <CheckCheck size={16} />
            <span className="hidden sm:inline">Mark all as read</span>
          </Button>
        }
      />

      <div className="p-4 lg:p-6 space-y-4">
        <div className="seg-track seg-sm w-fit">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              className={`seg-item flex items-center gap-1.5 ${filter === tab.id ? 'is-active' : ''}`}
            >
              {tab.label}
              {tab.id === 'unread' && unreadCount > 0 && (
                <span className={`text-[11px] px-1.5 py-0.5 rounded-full leading-none ${
                  filter === tab.id ? 'bg-white/20 text-white' : 'bg-brand-500/15 text-brand-300'
                }`}>
                  {unreadCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="glass-card rounded-2xl overflow-hidden">
          {isLoading ? (
            <div className="py-16 text-center text-zinc-400">
              <Loader2 size={20} className="animate-spin mx-auto mb-3 text-brand-400" />
              <p className="text-sm">Loading notifications...</p>
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-full bg-white/[0.06] flex items-center justify-center mb-4">
                <Bell size={20} className="text-zinc-400" />
              </div>
              <p className="text-sm font-medium text-zinc-300">
                {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
              </p>
              <p className="text-xs text-zinc-500 mt-1">You are all caught up</p>
            </div>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {notifications.map(notification => {
                const Icon = getEntityIcon(notification.entity_type);
                return (
                  <button
                    key={notification.id}
                    onClick={() => handleNotificationClick(notification)}
                    className={`w-full text-left px-4 lg:px-5 py-4 hover:bg-white/[0.04] transition-colors ${
                      !notification.is_read ? 'bg-brand-500/[0.06]' : ''
                    }`}
                  >
                    <div className="flex items-start gap-3.5">
                      <div
                        className={`flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${
                          !notification.is_read ? 'bg-brand-500/15 text-brand-300' : 'bg-white/[0.06] text-zinc-400'
                        }`}
                      >
                        <Icon size={17} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${!notification.is_read ? 'font-semibold text-white' : 'font-medium text-zinc-300'}`}>
                          {notification.title}
                        </p>
                        {notification.message && (
                          <p className="text-[13px] text-zinc-400 line-clamp-2 mt-0.5">{notification.message}</p>
                        )}
                        <p className="text-xs text-zinc-500 mt-1.5">{timeAgo(notification.created_at)}</p>
                      </div>
                      {!notification.is_read && (
                        <div className="h-2 w-2 rounded-full bg-brand-500 shrink-0 mt-2" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {!isLoading && hasMore && notifications.length > 0 && (
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={isLoadingMore}>
              {isLoadingMore ? <Loader2 size={16} className="animate-spin" /> : 'Load more'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
