'use client';

import { useState } from 'react';
import { useDemo } from '@/lib/demo-context';
import { peekRead, setReadData, useRead } from '@/lib/query-cache';
import { fetchGroupRows, fetchNotificationGroups, fetchNotificationPage, notificationGroupsRead, notificationsRead, unreadNotificationsRead } from '@/lib/reads';
import { useNeedsYouActions } from '@/lib/needs-you-actions';
import { NOTIFICATION_FEED_VIEWS, type NotificationFeedView, type NotificationGroup, type NotificationGroupPage, type NotificationPage, type NotificationView, type UpdateFilters } from '@/lib/notifications';

/** Later pages, kept under the first page they follow; a fresh first page drops them. */
interface MorePages {
  base: NotificationPage | undefined;
  items: NotificationView[];
  cursor: string | null;
}

export interface Updates {
  items: NotificationView[];
  /** Unread Updates: the one count beside Updates. */
  unread: number;
  /** How many the view holds in all, when known. */
  total: number | null;
  loading: boolean;
  failed: boolean;
  reload: () => void;
  /** More to read after the ones shown. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** Done (read too) or not done again; answers whether the server kept it. */
  setDone: (id: string, done: boolean) => Promise<boolean>;
}

/**
 * A member's Updates (updates or done), as the Notifications page and the
 * bell list them: the first page is a cached read that live sync refreshes,
 * later pages are read on demand, and every write (read, done) shows at once
 * on each cached list and the count, then goes through the one action layer.
 */
export function useUpdates(view: Exclude<NotificationFeedView, 'unread'>): Updates {
  const { isDemoMode } = useDemo();
  const actions = useNeedsYouActions();
  const first = useRead(notificationsRead(view, isDemoMode));
  const unread = useRead(unreadNotificationsRead(isDemoMode)).data ?? first.data?.unread ?? 0;
  const [more, setMore] = useState<MorePages>({ base: undefined, items: [], cursor: null });
  const [loadingMore, setLoadingMore] = useState(false);

  const current = more.base === first.data ? more : { base: first.data, items: [], cursor: first.data?.next_cursor ?? null };
  const items = [...(first.data?.items ?? []), ...current.items];

  /** Changes rows on every cached list, and the pages loaded after the first. */
  const patchLocally = (change: (n: NotificationView) => NotificationView | null) => {
    const apply = (list: NotificationView[]) => list.flatMap((n) => {
      const next = change(n);
      return next ? [next] : [];
    });
    for (const v of NOTIFICATION_FEED_VIEWS) {
      const cached = notificationsRead(v, isDemoMode);
      const page = peekRead(cached);
      if (!page) continue;
      const keep = apply(page.items).filter((n) => (v === 'done' ? !!n.done_at : !n.done_at && (v === 'updates' || !n.is_read)));
      const dropped = page.items.length - keep.length;
      setReadData(cached, () => ({ ...page, items: keep, total: page.total == null ? page.total : Math.max(0, page.total - dropped) }));
    }
    const base = first.data;
    const nextBase = peekRead(notificationsRead(view, isDemoMode));
    setMore((m) => (m.base && m.base === base ? { base: nextBase, items: apply(m.items), cursor: m.cursor } : m));
  };

  const markRead = async (id: string) => {
    const row = items.find((n) => n.id === id);
    if (!row || row.is_read) return;
    patchLocally((n) => (n.id === id ? { ...n, is_read: true } : n));
    setReadData(unreadNotificationsRead(isDemoMode), (n) => Math.max(0, (n ?? 0) - 1));
    await actions.markRead([id]);
  };

  const markAllRead = async () => {
    if (unread === 0) return;
    patchLocally((n) => ({ ...n, is_read: true }));
    setReadData(unreadNotificationsRead(isDemoMode), () => 0);
    await actions.markRead('all');
  };

  const setDone = async (id: string, done: boolean) => {
    const row = items.find((n) => n.id === id);
    const wasUnread = !!row && !row.is_read && !row.done_at;
    patchLocally((n) => (n.id === id ? (done ? { ...n, done_at: new Date().toISOString(), is_read: true } : { ...n, done_at: null }) : n));
    if (done && wasUnread) setReadData(unreadNotificationsRead(isDemoMode), (n) => Math.max(0, (n ?? 0) - 1));
    const outcome = await actions.markDone([id], done);
    return outcome.status === 'done';
  };

  const loadMore = async () => {
    if (loadingMore || !current.cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchNotificationPage(view, current.cursor);
      setMore({ base: first.data, items: [...current.items, ...page.items], cursor: page.next_cursor });
    } catch (error) {
      console.error('Error fetching notifications:', error);
    } finally {
      setLoadingMore(false);
    }
  };

  return {
    items,
    unread,
    total: first.data?.total ?? null,
    loading: first.loading,
    failed: !!first.failed && !first.data,
    reload: first.reload,
    hasMore: !!current.cursor && !isDemoMode,
    loadingMore,
    loadMore,
    markRead,
    markAllRead,
    setDone,
  };
}

export interface GroupedUpdates {
  groups: NotificationGroup[];
  /** How many groups match in all, when known. */
  total: number | null;
  loading: boolean;
  failed: boolean;
  reload: () => void;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /** Opening a group reads all of it. */
  markGroupRead: (group: NotificationGroup) => Promise<void>;
  /** Done on a group: every open Update in it; answers the ids, so Undo can bring them back. */
  doneGroup: (group: NotificationGroup) => Promise<string[] | null>;
}

/**
 * A member's Updates grouped by what they are about (pm.notification_update_groups):
 * "Website wireframes: 3 updates", filtered to agents or projects. The first
 * page is a cached read live sync refreshes; writes show at once.
 */
export function useGroupedUpdates(filters: UpdateFilters): GroupedUpdates {
  const { isDemoMode } = useDemo();
  const actions = useNeedsYouActions();
  const read = notificationGroupsRead(filters, isDemoMode);
  const first = useRead(read);
  const [more, setMore] = useState<{ base: NotificationGroupPage | undefined; groups: NotificationGroup[]; cursor: string | null }>({ base: undefined, groups: [], cursor: null });
  const current = more.base === first.data ? more : { base: first.data, groups: [], cursor: first.data?.next_cursor ?? null };
  const groups = [...(first.data?.groups ?? []), ...current.groups];

  const patch = (key: string, change: (g: NotificationGroup) => NotificationGroup | null) => {
    const apply = (list: NotificationGroup[]) => list.flatMap((g) => {
      if (g.group_key !== key) return [g];
      const next = change(g);
      return next ? [next] : [];
    });
    const page = peekRead(read);
    if (page) {
      const kept = apply(page.groups);
      setReadData(read, () => ({ ...page, groups: kept, total: page.total == null ? page.total : Math.max(0, page.total - (page.groups.length - kept.length)) }));
    }
    const nextBase = peekRead(read);
    setMore((m) => (m.base && m.base === first.data ? { base: nextBase, groups: apply(m.groups), cursor: m.cursor } : m));
  };

  const markGroupRead = async (group: NotificationGroup) => {
    if (group.unread_count === 0) return;
    patch(group.group_key, (g) => ({ ...g, unread_count: 0, latest: { ...g.latest, is_read: true } }));
    setReadData(unreadNotificationsRead(isDemoMode), (n) => Math.max(0, (n ?? 0) - group.unread_count));
    await actions.markRead({ group: group.group_key });
  };

  const doneGroup = async (group: NotificationGroup) => {
    const ids = group.group_count <= 1 ? [group.latest.id] : (await fetchGroupRows(group.group_key, isDemoMode)).map((n) => n.id);
    patch(group.group_key, () => null);
    if (group.unread_count > 0) setReadData(unreadNotificationsRead(isDemoMode), (n) => Math.max(0, (n ?? 0) - group.unread_count));
    const outcome = await actions.markDone(ids, true);
    return outcome.status === 'done' ? ids : null;
  };

  const loadMore = async () => {
    if (!current.cursor) return;
    const page = await fetchNotificationGroups(filters, current.cursor);
    setMore({ base: first.data, groups: [...current.groups, ...page.groups], cursor: page.next_cursor });
  };

  return {
    groups,
    total: first.data?.total ?? null,
    loading: first.loading,
    failed: !!first.failed && !first.data,
    reload: first.reload,
    hasMore: !!current.cursor && !isDemoMode,
    loadMore,
    markGroupRead,
    doneGroup,
  };
}
