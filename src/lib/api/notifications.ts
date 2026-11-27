import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from './errors';
import {
  GROUP_KEY, RECEIPT_CATEGORIES, SNOOZE_KINDS, SNOOZE_MAX_DAYS, decodeCursor, encodeCursor, isReceiptCategory, parseGroupKey, safeNotificationLink, withCategory,
  type NotificationActor, type UpdateFilters, type NotificationFeedView, type NotificationGroupPage, type NotificationPage, type NotificationView, type Snooze,
} from '@/lib/notifications';
import type { Notification } from '@/lib/types';

/**
 * A member's notifications on the server (20261127000700): the Updates feed,
 * its groups and unread count, done, and snoozes. The member is always the
 * signed-in one (or the API key's), passed in; nothing here reads anyone
 * else's rows. On a database before the migration the feed and the count
 * still answer from the old columns (only the findings nudge is told apart
 * there, by its title convention; a question's notice is listed as before);
 * done and snooze say the update is missing.
 */

/** The database has not had 20261127000700 yet: a function, table or column it adds is missing. */
export function missingFoundation(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (['42883', 'PGRST202', '42703', 'PGRST204', '42P01', 'PGRST205'].includes(error.code ?? '')) return true;
  const message = (error.message ?? '').toLowerCase();
  return message.includes('does not exist') || message.includes('could not find the function') || message.includes('schema cache');
}

/** What team_member_notifications_category_check allows. */
const CATEGORY_FORMAT = /^[a-z][a-z0-9_]{0,59}$/;

export const notificationsNotReady = (migration = '20261127000700_notifications_foundation.sql') => new ApiError(503, 'SERVICE_UNAVAILABLE', 'Notifications need the latest database update. Ask an Owner to apply it in Settings > Updates.', { reason: 'database_update_needed', migration });

export interface UpsertNotificationInput {
  userId: string;
  title: string;
  message: string | null;
  link: string | null;
  entityType: string | null;
  entityId: string | null;
  /** What kind of notice; left out, the database works it out from the entity type and title. */
  category?: string | null;
  projectId?: string | null;
  actorId?: string | null;
}

/**
 * Raises a notice through pm.upsert_notification: with a category (and
 * where and who) when given, falling back to the 6 argument form on a
 * database before the migration.
 */
export async function upsertNotification(db: SupabaseClient, input: UpsertNotificationInput): Promise<void> {
  // Only a path in this app is kept as a link: a notice never sends anyone to another site.
  const base = {
    p_user_id: input.userId, p_title: input.title, p_message: input.message, p_link: safeNotificationLink(input.link),
    p_entity_type: input.entityType, p_entity_id: input.entityId,
  };
  // A category the column would refuse is left for the database to work out.
  const category = input.category && CATEGORY_FORMAT.test(input.category) ? input.category : null;
  if (category || input.projectId || input.actorId) {
    const { error } = await db.rpc('upsert_notification', {
      ...base, p_category: category, p_project_id: input.projectId ?? null, p_actor_id: input.actorId ?? null,
    });
    if (!error) return;
    if (!missingFoundation(error)) throw error;
  }
  const { error } = await db.rpc('upsert_notification', base);
  if (error) throw error;
}

export const FEED_PAGE_SIZE = 30;

export interface FeedOptions {
  view?: NotificationFeedView;
  limit?: number;
  before?: string | null;
}

function cursorOf(rows: NotificationView[], view: NotificationFeedView, limit: number): string | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  const at = view === 'done' ? last.done_at : last.created_at;
  return at ? encodeCursor(at, last.id) : null;
}

/** The legacy read: no done, no snoozes, no question lookups (so only the findings nudge is left out). */
async function legacyFeed(db: SupabaseClient, memberId: string, view: NotificationFeedView, limit: number, before: { at: string; id: string } | null) {
  if (view === 'done') return [];
  let query = db.from('team_member_notifications').select('*').eq('user_id', memberId).is('cleared_at', null);
  if (view === 'unread') query = query.eq('is_read', false);
  if (before) query = query.lt('created_at', before.at);
  // A few more than a page, since receipts are dropped after the read.
  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit * 2);
  if (error) throw error;
  return ((data ?? []) as Notification[]).map(withCategory).filter((row) => !isReceiptCategory(row.category)).slice(0, limit);
}

/** One page of a member's Updates, newest first. */
export async function notificationFeed(db: SupabaseClient, memberId: string, options: FeedOptions = {}): Promise<NotificationView[]> {
  const view = options.view ?? 'updates';
  const limit = Math.min(100, Math.max(1, options.limit ?? FEED_PAGE_SIZE));
  const before = decodeCursor(options.before);
  const { data, error } = await db.rpc('notification_feed', {
    p_member_id: memberId, p_view: view, p_limit: limit, p_before_at: before?.at ?? null, p_before_id: before?.id ?? null,
  });
  if (error) {
    if (missingFoundation(error)) return legacyFeed(db, memberId, view, limit, before);
    throw error;
  }
  return ((data ?? []) as Notification[]).map(withCategory);
}

/** How many of a member's Updates are unread: the Notifications count (receipts, done and snoozed left out). */
export async function notificationUnreadCount(db: SupabaseClient, memberId: string): Promise<number> {
  const { data, error } = await db.rpc('notification_unread_count', { p_member_id: memberId });
  if (!error) return Number(data ?? 0);
  if (!missingFoundation(error)) throw error;
  const { data: rows, error: legacyError } = await db.from('team_member_notifications')
    .select('id, title, entity_type').eq('user_id', memberId).eq('is_read', false).is('cleared_at', null).limit(1000);
  if (legacyError) throw legacyError;
  return ((rows ?? []) as Pick<Notification, 'title' | 'entity_type'>[])
    .filter((row) => !isReceiptCategory(withCategory(row as Notification).category)).length;
}

/**
 * Each notification with who sent it (name, picture, role), so the page can
 * say "From Casey Brooks (guest)" and a member's notice never passes for the
 * app's own. Links are kept only when they are paths in this app.
 */
export async function withActors(db: SupabaseClient, items: NotificationView[]): Promise<NotificationView[]> {
  const ids = [...new Set(items.map((item) => item.actor_id).filter((id): id is string => !!id))];
  let byId = new Map<string, NotificationActor>();
  if (ids.length) {
    const { data, error } = await db.from('team_members').select('id, name, avatar, role').in('id', ids);
    if (error) throw error;
    byId = new Map(((data ?? []) as NotificationActor[]).map((row) => [row.id, { id: row.id, name: row.name, avatar: row.avatar || null, role: row.role }]));
  }
  return items.map((item) => ({
    ...item,
    link: safeNotificationLink(item.link),
    actor: item.actor_id ? byId.get(item.actor_id) ?? null : null,
  }));
}

/** A page of Updates and the unread count together, as the Notifications page reads them. */
export async function notificationPage(db: SupabaseClient, memberId: string, options: FeedOptions = {}): Promise<NotificationPage> {
  const view = options.view ?? 'updates';
  const limit = Math.min(100, Math.max(1, options.limit ?? FEED_PAGE_SIZE));
  const [items, unread, total] = await Promise.all([
    notificationFeed(db, memberId, { ...options, view, limit }),
    notificationUnreadCount(db, memberId),
    notificationViewCount(db, memberId, view),
  ]);
  return { items: await withActors(db, items), unread, total, next_cursor: cursorOf(items, view, limit) };
}

/** How many Updates a view holds in all; null before 20261127002700. */
export async function notificationViewCount(db: SupabaseClient, memberId: string, view: NotificationFeedView): Promise<number | null> {
  const { data, error } = await db.rpc('notification_view_count', { p_member_id: memberId, p_view: view });
  if (!error) return Number(data ?? 0);
  if (missingFoundation(error)) return null;
  throw error;
}

type GroupRow = Omit<Notification, 'user_id'> & { group_key: string; group_count: number; unread_count: number };

/** A member's Updates grouped by what they are about, newest group first: from agents only, or some projects only, when asked. */
export async function notificationGroups(
  db: SupabaseClient,
  memberId: string,
  options: { limit?: number; before?: string | null; filters?: Partial<UpdateFilters> } = {},
): Promise<NotificationGroupPage> {
  const limit = Math.min(100, Math.max(1, options.limit ?? FEED_PAGE_SIZE));
  const before = decodeCursor(options.before);
  const fromAgents = options.filters?.fromAgents ?? false;
  const projectIds = options.filters?.projectIds?.length ? options.filters.projectIds : null;
  const page = { p_member_id: memberId, p_limit: limit, p_before_at: before?.at ?? null, p_before_id: before?.id ?? null };
  const filters = { p_from_agents: fromAgents, p_project_ids: projectIds };
  const [grouped, total] = await Promise.all([
    db.rpc('notification_update_groups', { ...page, ...filters }),
    db.rpc('notification_group_total', { p_member_id: memberId, ...filters }),
  ]);
  let data = grouped.data as GroupRow[] | null;
  if (grouped.error) {
    if (!missingFoundation(grouped.error)) throw grouped.error;
    // Before 20261127003300 there are no filters: refuse them rather than answer unfiltered.
    if (fromAgents || projectIds) throw notificationsNotReady('20261127003300_notifications_groups.sql');
    const older = await db.rpc('notification_groups', page);
    if (older.error) {
      if (!missingFoundation(older.error)) throw older.error;
      // Before 20261127000700: each row is its own group.
      const rows = await legacyFeed(db, memberId, 'updates', limit, before);
      return {
        groups: rows.map((row) => ({ latest: row, group_key: `notification:${row.id}`, group_count: 1, unread_count: row.is_read ? 0 : 1 })),
        total: null,
        next_cursor: cursorOf(rows, 'updates', limit),
      };
    }
    data = older.data as GroupRow[] | null;
  }
  const groups = (data ?? []).map(({ group_key, group_count, unread_count, ...row }) => ({
    latest: withCategory({ ...row, user_id: memberId } as Notification),
    group_key, group_count: Number(group_count), unread_count: Number(unread_count),
  }));
  const withSenders = await withActors(db, groups.map((g) => g.latest));
  const last = groups[groups.length - 1];
  return {
    groups: groups.map((g, i) => ({ ...g, latest: withSenders[i] ?? g.latest })),
    total: total.error ? null : Number(total.data ?? 0),
    next_cursor: groups.length === limit && last ? encodeCursor(last.latest.created_at, last.latest.id) : null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Updates filters a request asks for: from=agents (notices an agent
 * sent), project_id (repeatable, or comma separated; up to 50). Anything
 * else is a 400 naming what to send.
 */
export function updateFiltersFrom(params: URLSearchParams): UpdateFilters {
  const from = params.get('from');
  if (from !== null && from !== 'agents' && from !== 'anyone') throw new ApiError(400, 'BAD_REQUEST', 'from must be agents or anyone', { reason: 'invalid_from' });
  const projectIds = [...new Set(params.getAll('project_id').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean))];
  if (projectIds.length > 50 || projectIds.some((value) => !UUID_RE.test(value))) {
    throw new ApiError(400, 'BAD_REQUEST', 'project_id must be up to 50 project ids', { reason: 'invalid_project_id' });
  }
  return { fromAgents: from === 'agents', projectIds };
}

/** One group's open Updates, newest first, keyset paged. */
export async function notificationGroupRows(
  db: SupabaseClient,
  memberId: string,
  groupKey: string,
  options: { limit?: number; before?: string | null } = {},
): Promise<{ items: NotificationView[]; next_cursor: string | null }> {
  if (!parseGroupKey(groupKey)) throw new ApiError(400, 'BAD_REQUEST', 'group_key must be a group_key from a list of groups', { reason: 'invalid_group_key' });
  const limit = Math.min(100, Math.max(1, options.limit ?? FEED_PAGE_SIZE));
  const before = decodeCursor(options.before);
  const { data, error } = await db.rpc('notification_group_rows', {
    p_member_id: memberId, p_group_key: groupKey, p_limit: limit, p_before_at: before?.at ?? null, p_before_id: before?.id ?? null,
  });
  if (error) {
    if (missingFoundation(error)) throw notificationsNotReady('20261127003300_notifications_groups.sql');
    throw error;
  }
  const items = ((data ?? []) as Notification[]).map(withCategory);
  return { items: await withActors(db, items), next_cursor: cursorOf(items, 'updates', limit) };
}

export const groupReadSchema = z.object({ group_key: z.string().regex(GROUP_KEY, 'group_key must be a group_key from a list of groups') }).strict();

/** Marks every unread notification in one group read: opening a group reads it. Answers { marked_read }. */
export async function markGroupRead(db: SupabaseClient, memberId: string, groupKey: string): Promise<{ marked_read: number }> {
  const parts = parseGroupKey(groupKey);
  if (!parts) throw new ApiError(400, 'BAD_REQUEST', 'group_key must be a group_key from a list of groups', { reason: 'invalid_group_key' });
  let query = db.from('team_member_notifications').update({ is_read: true }).eq('user_id', memberId).eq('is_read', false);
  query = parts.entityType === 'notification' ? query.eq('id', parts.entityId) : query.eq('entity_type', parts.entityType).eq('entity_id', parts.entityId);
  const { data, error } = await query.select('id');
  if (error) throw error;
  return { marked_read: (data ?? []).length };
}

export const doneSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(200), done: z.boolean().default(true) }).strict(),
  z.object({ all: z.literal(true), done: z.literal(true).default(true) }).strict(),
  z.object({ group_key: z.string().regex(GROUP_KEY, 'group_key must be a group_key from a list of groups'), done: z.literal(true).default(true) }).strict(),
]);

/**
 * Marks a member's notifications done (read too), or not done again. `all`
 * marks every open Update done, `group_key` every open Update in one group;
 * receipts are left as they are, since Needs you owns what they announce.
 */
export async function setNotificationsDone(db: SupabaseClient, memberId: string, input: z.infer<typeof doneSchema>): Promise<{ updated: number }> {
  const now = new Date().toISOString();
  let query = db.from('team_member_notifications')
    .update(input.done ? { done_at: now, is_read: true } : { done_at: null })
    .eq('user_id', memberId);
  if ('ids' in input) {
    query = query.in('id', input.ids);
    if (!input.done) query = query.not('done_at', 'is', null);
  } else if ('group_key' in input) {
    // Every open Update in one group: what Done on a grouped row does.
    const parts = parseGroupKey(input.group_key);
    if (!parts) throw new ApiError(400, 'BAD_REQUEST', 'group_key must be a group_key from a list of groups', { reason: 'invalid_group_key' });
    query = parts.entityType === 'notification'
      ? query.eq('id', parts.entityId)
      : query.eq('entity_type', parts.entityType).eq('entity_id', parts.entityId);
    query = query.is('done_at', null).is('cleared_at', null).not('category', 'in', `(${RECEIPT_CATEGORIES.join(',')})`);
  } else {
    query = query.is('done_at', null).is('cleared_at', null).not('category', 'in', `(${RECEIPT_CATEGORIES.join(',')})`);
  }
  const { data, error } = await query.select('id');
  if (error) {
    if (missingFoundation(error)) throw notificationsNotReady();
    throw error;
  }
  return { updated: (data ?? []).length };
}

export const snoozeSchema = z.object({
  item_kind: z.enum(SNOOZE_KINDS),
  item_id: z.string().uuid(),
  until: z.string().datetime({ offset: true }),
}).strict();

export const unsnoozeSchema = snoozeSchema.omit({ until: true });

/** Hides one item from the member until `until` (in the future, at most SNOOZE_MAX_DAYS away). Snoozing again moves it. */
export async function snoozeItem(db: SupabaseClient, memberId: string, input: z.infer<typeof snoozeSchema>, now = Date.now()): Promise<Snooze> {
  const until = Date.parse(input.until);
  if (until <= now) throw new ApiError(422, 'VALIDATION_ERROR', 'until must be in the future', { reason: 'until_past', fields: { until: 'Must be in the future' } });
  if (until > now + SNOOZE_MAX_DAYS * 86_400_000) {
    throw new ApiError(422, 'VALIDATION_ERROR', `A snooze lasts at most ${SNOOZE_MAX_DAYS} days`, { reason: 'until_too_far', fields: { until: `At most ${SNOOZE_MAX_DAYS} days away` } });
  }
  const row = { member_id: memberId, item_kind: input.item_kind, item_id: input.item_id, until: new Date(until).toISOString() };
  const { data, error } = await db.from('member_snoozes').upsert(row, { onConflict: 'member_id,item_kind,item_id' }).select('item_kind, item_id, until').single();
  if (error) {
    if (missingFoundation(error)) throw notificationsNotReady();
    throw error;
  }
  return data as Snooze;
}

/** Brings a snoozed item back now. Answers whether there was one. */
export async function unsnoozeItem(db: SupabaseClient, memberId: string, input: z.infer<typeof unsnoozeSchema>): Promise<{ removed: boolean }> {
  const { data, error } = await db.from('member_snoozes').delete()
    .eq('member_id', memberId).eq('item_kind', input.item_kind).eq('item_id', input.item_id).select('item_id');
  if (error) {
    if (missingFoundation(error)) throw notificationsNotReady();
    throw error;
  }
  return { removed: (data ?? []).length > 0 };
}

/** The member's snoozes still in force (none on a database before the migration). */
export async function listSnoozes(db: SupabaseClient, memberId: string): Promise<Snooze[]> {
  const { data, error } = await db.from('member_snoozes').select('item_kind, item_id, until')
    .eq('member_id', memberId).gt('until', new Date().toISOString()).order('until');
  if (error) {
    if (missingFoundation(error)) return [];
    throw error;
  }
  return (data ?? []) as Snooze[];
}
