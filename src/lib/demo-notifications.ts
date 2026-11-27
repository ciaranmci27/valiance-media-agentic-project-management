'use client';

import { demoNotifications } from '@/lib/demo-data';
import {
  activeSnoozes, isReceiptCategory, withCategory, type NotificationFeedView, type NotificationPage, type NotificationView, type Snooze,
} from '@/lib/notifications';

/**
 * The demo's notifications and snoozes, kept in the browser for the visit:
 * reads answer from here and writes change it, so marking read, done or
 * snoozing behaves as it would against a database. Nothing is sent.
 */

let rows: NotificationView[] | null = null;
let snoozes: Snooze[] = [];

function all(): NotificationView[] {
  rows ??= demoNotifications.map(withCategory);
  return rows;
}

function visible(row: NotificationView, hidden: Set<string>): boolean {
  return !isReceiptCategory(row.category) && !hidden.has(`notification:${row.id}`);
}

/** A page of the demo's Updates, as GET /api/workspace/notifications answers. */
export function demoNotificationPage(view: NotificationFeedView): NotificationPage {
  const hidden = activeSnoozes(snoozes, Date.now());
  const items = all().filter((row) => visible(row, hidden) && (view === 'done'
    ? !!row.done_at
    : !row.done_at && (view === 'updates' || !row.is_read)));
  return { items: items.map((row) => ({ ...row })), unread: demoUnreadCount(), total: items.length, next_cursor: null };
}

export function demoUnreadCount(): number {
  const hidden = activeSnoozes(snoozes, Date.now());
  return all().filter((row) => visible(row, hidden) && !row.done_at && !row.is_read).length;
}

/** Marks the demo's notifications read (every one when ids is 'all'). */
export function demoMarkRead(ids: readonly string[] | 'all') {
  rows = all().map((row) => (ids === 'all' || ids.includes(row.id) ? { ...row, is_read: true } : row));
}

/** Marks the demo's notifications done (read too), or not done again. */
export function demoMarkDone(ids: readonly string[] | 'all', done: boolean) {
  const now = new Date().toISOString();
  rows = all().map((row) => {
    if (ids !== 'all' && !ids.includes(row.id)) return row;
    if (ids === 'all' && (row.done_at || isReceiptCategory(row.category))) return row;
    return done ? { ...row, done_at: now, is_read: true } : { ...row, done_at: null };
  });
}

export function demoSnoozes(): Snooze[] {
  return snoozes.filter((s) => Date.parse(s.until) > Date.now());
}

export function demoSnooze(snooze: Snooze) {
  snoozes = [...snoozes.filter((s) => !(s.item_kind === snooze.item_kind && s.item_id === snooze.item_id)), snooze];
}

export function demoUnsnooze(kind: Snooze['item_kind'], id: string) {
  snoozes = snoozes.filter((s) => !(s.item_kind === kind && s.item_id === id));
}
