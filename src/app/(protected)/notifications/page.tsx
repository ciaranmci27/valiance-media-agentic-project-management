'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckSquare, FolderKanban, Target, MessageSquare, Users, Loader2, CheckCheck } from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { demoNotifications } from '@/lib/demo-data';
import { createClient } from '@/lib/supabase/client';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import type { Notification, NotificationEntityType } from '@/lib/types';

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
  return new Date(dateStr).toLocaleDateString();
}

function getEntityIcon(entityType: NotificationEntityType | null) {
  switch (entityType) {
    case 'task':    return CheckSquare;
    case 'project': return FolderKanban;
    case 'lead':    return Target;
    case 'comment': return MessageSquare;
    case 'member':  return Users;
    default:        return Bell;
  }
}

const PAGE_SIZE = 30;

export default function NotificationsPage() {
  const router = useRouter();
  const { isDemoMode } = useDemo();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loadingMoreRef = useRef(false);

  const fetchNotifications = useCallback(async (loadMore = false, tab: FilterTab = filter) => {
    if (loadMore) {
      if (loadingMoreRef.current || !hasMore) return;
      loadingMoreRef.current = true;
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
      setHasMore(true);
    }

    if (isDemoMode) {
      const list = tab === 'unread' ? demoNotifications.filter(n => !n.is_read) : [...demoNotifications];
      setNotifications(list);
      setUnreadCount(demoNotifications.filter(n => !n.is_read).length);
      setHasMore(false);
      setIsLoading(false);
      setIsLoadingMore(false);
      loadingMoreRef.current = false;
      return;
    }

    const supabase = createClient();
    const offset = loadMore ? notifications.length : 0;

    try {
      let listQuery = supabase
        .from('team_member_notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (tab === 'unread') listQuery = listQuery.eq('is_read', false);

      const [listResult, countResult] = await Promise.all([
        listQuery,
        supabase
          .from('team_member_notifications')
          .select('*', { count: 'exact', head: true })
          .eq('is_read', false),
      ]);

      if (listResult.data) {
        const rows = listResult.data as Notification[];
        setNotifications(prev => (loadMore ? [...prev, ...rows] : rows));
        setHasMore(rows.length === PAGE_SIZE);
      }
      if (countResult.count !== null) setUnreadCount(countResult.count);
    } catch (error) {
      console.error('Error fetching notifications:', error);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
      loadingMoreRef.current = false;
    }
  }, [filter, hasMore, isDemoMode, notifications.length]);

  // Initial load + reload whenever the filter tab changes.
  useEffect(() => {
    fetchNotifications(false, filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, isDemoMode]);

  const handleMarkAsRead = async (id: string) => {
    setNotifications(prev =>
      filter === 'unread'
        ? prev.filter(n => n.id !== id)
        : prev.map(n => (n.id === id ? { ...n, is_read: true } : n)),
    );
    setUnreadCount(prev => Math.max(0, prev - 1));
    window.dispatchEvent(new Event('notifications-updated'));
    if (isDemoMode) return;
    try {
      await createClient().from('team_member_notifications').update({ is_read: true }).eq('id', id);
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  };

  const handleMarkAllAsRead = async () => {
    if (unreadCount === 0) return;
    setNotifications(prev => (filter === 'unread' ? [] : prev.map(n => ({ ...n, is_read: true }))));
    setUnreadCount(0);
    window.dispatchEvent(new Event('notifications-updated'));
    if (isDemoMode) return;
    try {
      await createClient()
        .from('team_member_notifications')
        .update({ is_read: true })
        .eq('is_read', false);
    } catch (error) {
      console.error('Error marking all as read:', error);
    }
  };

  const handleNotificationClick = async (notification: Notification) => {
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
        subtitle={unreadCount > 0 ? `${unreadCount} unread` : 'You are all caught up'}
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
            <Button variant="ghost" size="sm" onClick={() => fetchNotifications(true)} disabled={isLoadingMore}>
              {isLoadingMore ? <Loader2 size={16} className="animate-spin" /> : 'Load more'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
