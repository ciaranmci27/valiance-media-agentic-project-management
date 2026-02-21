'use client';

import { useState, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, CheckSquare, FolderKanban, Target, MessageSquare, Users } from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { demoNotifications } from '@/lib/demo-data';
import { createClient } from '@/lib/supabase/client';
import type { Notification, NotificationEntityType } from '@/lib/types';

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

export function NotificationDropdown() {
  const router = useRouter();
  const pathname = usePathname();
  const { isDemoMode } = useDemo();
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch unread count on mount and when pathname changes
  useEffect(() => {
    if (isDemoMode) {
      setUnreadCount(demoNotifications.filter(n => !n.is_read).length);
      return;
    }

    const fetchUnreadCount = async () => {
      const supabase = createClient();
      try {
        const { count } = await supabase
          .from('team_member_notifications')
          .select('*', { count: 'exact', head: true })
          .eq('is_read', false);
        if (count !== null) setUnreadCount(count);
      } catch (error) {
        console.error('Error fetching unread count:', error);
      }
    };

    fetchUnreadCount();
  }, [pathname, isDemoMode]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchNotifications = async () => {
    setIsLoading(true);

    if (isDemoMode) {
      setNotifications([...demoNotifications]);
      setUnreadCount(demoNotifications.filter(n => !n.is_read).length);
      setIsLoading(false);
      return;
    }

    const supabase = createClient();
    try {
      const [notifResult, countResult] = await Promise.all([
        supabase
          .from('team_member_notifications')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('team_member_notifications')
          .select('*', { count: 'exact', head: true })
          .eq('is_read', false),
      ]);

      if (notifResult.data) setNotifications(notifResult.data as Notification[]);
      if (countResult.count !== null) setUnreadCount(countResult.count);
    } catch (error) {
      console.error('Error fetching notifications:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggle = () => {
    const willOpen = !isOpen;
    setIsOpen(willOpen);
    if (willOpen) fetchNotifications();
  };

  const handleMarkAsRead = async (id: string) => {
    if (isDemoMode) {
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
      return;
    }

    const supabase = createClient();
    try {
      await supabase.from('team_member_notifications').update({ is_read: true }).eq('id', id);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  };

  const handleMarkAllAsRead = async () => {
    const unreadIds = notifications.filter(n => !n.is_read).map(n => n.id);
    if (unreadIds.length === 0) return;

    if (isDemoMode) {
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
      setUnreadCount(prev => Math.max(0, prev - unreadIds.length));
      return;
    }

    const supabase = createClient();
    try {
      await supabase.from('team_member_notifications').update({ is_read: true }).in('id', unreadIds);
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
      setUnreadCount(prev => Math.max(0, prev - unreadIds.length));
    } catch (error) {
      console.error('Error marking all as read:', error);
    }
  };

  const handleNotificationClick = async (notification: Notification) => {
    if (!notification.is_read) {
      await handleMarkAsRead(notification.id);
    }
    if (notification.link) {
      router.push(notification.link);
    }
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell button */}
      <button
        onClick={handleToggle}
        className="relative p-2 rounded-lg text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-medium text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="fixed inset-x-4 top-16 z-50 sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96 rounded-xl border border-zinc-200 bg-white shadow-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
            <h3 className="font-semibold text-zinc-900 text-sm">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllAsRead}
                className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-96 overflow-y-auto">
            {isLoading ? (
              <div className="py-10 text-center text-zinc-400">
                <div className="animate-spin h-5 w-5 border-2 border-indigo-600 border-t-transparent rounded-full mx-auto mb-2" />
                <p className="text-sm">Loading...</p>
              </div>
            ) : notifications.length === 0 ? (
              <div className="py-10 text-center text-zinc-400">
                <Bell className="mx-auto mb-2 opacity-40" size={28} />
                <p className="text-sm">No notifications yet</p>
              </div>
            ) : (
              <div className="divide-y divide-zinc-100">
                {notifications.map((notification) => {
                  const Icon = getEntityIcon(notification.entity_type);
                  return (
                    <button
                      key={notification.id}
                      onClick={() => handleNotificationClick(notification)}
                      className={`w-full text-left px-4 py-3 hover:bg-zinc-50 transition-colors ${
                        !notification.is_read ? 'bg-indigo-50/50' : ''
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={`flex h-8 w-8 items-center justify-center rounded-lg shrink-0 ${
                            !notification.is_read
                              ? 'bg-indigo-100 text-indigo-600'
                              : 'bg-zinc-100 text-zinc-400'
                          }`}
                        >
                          <Icon size={16} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p
                            className={`text-sm truncate ${
                              !notification.is_read
                                ? 'font-semibold text-zinc-900'
                                : 'font-medium text-zinc-700'
                            }`}
                          >
                            {notification.title}
                          </p>
                          {notification.message && (
                            <p className="text-xs text-zinc-500 line-clamp-2 mt-0.5">
                              {notification.message}
                            </p>
                          )}
                          <p className="text-xs text-zinc-400 mt-1">
                            {timeAgo(notification.created_at)}
                          </p>
                        </div>
                        {!notification.is_read && (
                          <div className="h-2 w-2 rounded-full bg-indigo-600 shrink-0 mt-2" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
