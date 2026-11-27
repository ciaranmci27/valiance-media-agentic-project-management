import { randomUUID } from 'crypto';
import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { parsePagination, readPage } from '@/lib/api/pagination';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { badRequest } from '@/lib/api/errors';
import { memberInboxIds } from '@/lib/communications/agent-access';
import { comms } from '@/lib/communications/db';
import { inboxDecisionRecipients } from '@/lib/communications/inbox-handlers';
import { createNotificationSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { logAudit } from '@/lib/api/audit';
import { z } from 'zod';
import { NextResponse } from 'next/server';
import { RECEIPT_CATEGORIES, agentNoticeCategory, decodeCursor, encodeCursor, type NotificationFeedView, type NotificationView } from '@/lib/notifications';
import { missingFoundation, notificationFeed, notificationGroupRows, notificationsNotReady, upsertNotification } from '@/lib/api/notifications';
import { isRelativeAppPath } from '@/lib/security/safe-url';

export const GET = withApi(async ({ supabase, searchParams, teamMemberId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to access notifications');

  const isRead = searchParams.get('is_read');
  const entityType = searchParams.get('entity_type');
  // view: all (every notification, as before), updates (what the app lists
  // as Updates: not done, receipts left out), unread (those not read yet)
  // or done.
  const view = searchParams.get('view') ?? 'all';
  if (!['all', 'updates', 'unread', 'done'].includes(view)) throw badRequest('view must be all, updates, unread or done');
  const category = searchParams.get('category');
  if (category !== null && !/^[a-z][a-z0-9_]{0,59}$/.test(category)) throw badRequest('category must be a category key such as task_comments');

  // One group's rows (group_key from list_notification_groups), keyset paged.
  const groupKey = searchParams.get('group_key');
  if (groupKey !== null) {
    if (isRead !== null || entityType || category || (view !== 'all' && view !== 'updates')) throw badRequest('group_key cannot be combined with is_read, entity_type, category or a view other than updates');
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit')) || 25));
    const rows = await notificationGroupRows(supabase, teamMemberId, groupKey, { limit, before: searchParams.get('before') });
    return NextResponse.json({ success: true, data: rows.items, meta: { limit, next_cursor: rows.next_cursor } });
  }

  // Keyset paging (before: the previous page's meta.next_cursor), as the app
  // pages Updates: the same rows pm.notification_feed lists, snoozed left out.
  const before = searchParams.get('before');
  if (before !== null) {
    if (view === 'all') throw badRequest('before pages view updates, unread or done; send view too');
    if (isRead !== null || entityType || category) throw badRequest('before cannot be combined with is_read, entity_type or category');
    if (!decodeCursor(before)) throw badRequest('before must be a next_cursor from a previous page');
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit')) || 25));
    const items = await notificationFeed(supabase, teamMemberId, { view: view as NotificationFeedView, limit, before });
    return keysetPage(items, view as NotificationFeedView, limit);
  }

  const { page, limit, offset } = parsePagination(searchParams);
  let query = supabase
    .from('team_member_notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', teamMemberId)
    .is('cleared_at', null);

  if (isRead === 'true') query = query.eq('is_read', true);
  else if (isRead === 'false' || view === 'unread') query = query.eq('is_read', false);

  if (entityType) query = query.eq('entity_type', entityType);
  if (category) query = query.eq('category', category);
  if (view === 'updates' || view === 'unread') query = query.is('done_at', null).not('category', 'in', `(${RECEIPT_CATEGORIES.join(',')})`);
  if (view === 'done') query = query.not('done_at', 'is', null);

  const { data, count, error } = await readPage(view === 'all'
    ? query.order('created_at', { ascending: false }).order('id')
    // The keyset order, so meta.next_cursor carries on from this page.
    : query.order(view === 'done' ? 'done_at' : 'created_at', { ascending: false }).order('id', { ascending: false }), { offset, limit });

  if (error) {
    if ((view !== 'all' || category) && missingFoundation(error)) throw notificationsNotReady();
    throw error;
  }
  const rows = (data || []) as NotificationView[];
  const response = paginated(rows, { page, limit, total: count || 0 });
  if (view === 'all') return response;
  const body = await response.json() as { meta: Record<string, unknown> };
  return NextResponse.json({ ...body, meta: { ...body.meta, next_cursor: rows.length === limit ? cursorAt(rows[rows.length - 1], view as NotificationFeedView) : null } });
}, { permission: 'notifications.manage_own' });

function cursorAt(row: NotificationView, view: NotificationFeedView): string | null {
  const at = view === 'done' ? row.done_at : row.created_at;
  return at ? encodeCursor(at, row.id) : null;
}

/** A keyset page: { data, meta: { limit, next_cursor } }. */
function keysetPage(items: NotificationView[], view: NotificationFeedView, limit: number) {
  const last = items[items.length - 1];
  return NextResponse.json({ success: true, data: items, meta: { limit, next_cursor: items.length === limit && last ? cursorAt(last, view) : null } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid string as given, else null (these keys were ignored before, so any other value still is). */
function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * The inbox a notification is about (inbox_id, else message_id, else
 * conversation_id), when the key reads it; otherwise null, and the
 * notification goes where it always did. Nothing here is refused: callers
 * that sent these keys before they meant anything keep their answer.
 */
async function namedInbox(supabase: SupabaseClient, memberId: string | null, access: AccessContext, notification: z.infer<typeof createNotificationSchema>): Promise<string | null> {
  const [inboxId, messageId, conversationId] = [notification.inbox_id, notification.message_id, notification.conversation_id].map(uuidOrNull);
  if (!memberId || (!inboxId && !messageId && !conversationId)) return null;
  let target: string | null = inboxId;
  if (!target && messageId) {
    const { data, error } = await comms(supabase).from('messages').select('inbox_id, status').eq('id', messageId).maybeSingle();
    if (error) throw error;
    const row = data as { inbox_id: string; status: string } | null;
    target = row && row.status !== 'receiving' ? row.inbox_id : null;
  }
  if (!target && conversationId) {
    const { data, error } = await comms(supabase).from('conversations').select('inbox_id').eq('id', conversationId).maybeSingle();
    if (error) throw error;
    target = (data as { inbox_id: string } | null)?.inbox_id ?? null;
  }
  if (!target) return null;
  return (await memberInboxIds(supabase, memberId, access)).includes(target) ? target : null;
}

// Agent-to-owner channel: blocking questions and escalations land in the
// in-app inbox. Recipients are resolved server-side by role; the caller can
// never target an arbitrary member. About one inbox, "owner" means that
// inbox's decision recipient when it has one.
export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId, access }) => {
  // The agent-to-owner channel belongs to the AI agents module.
  requireAgentsEnabled(access);
  const notification = body as z.infer<typeof createNotificationSchema>;
  const roles = notification.audience === 'owner_and_admins' ? ['owner', 'admin'] : ['owner'];

  const inboxId = notification.audience === 'owner' ? await namedInbox(supabase, teamMemberId, access, notification) : null;
  const deciders = inboxId ? await inboxDecisionRecipients(supabase, inboxId) : null;
  const { data: recipients, error: recipientsError } = deciders
    ? { data: deciders.map((id) => ({ id })), error: null }
    : await supabase
      .from('team_members')
      .select('id')
      .in('role', roles)
      .eq('status', 'active');
  if (recipientsError) throw recipientsError;

  // A fresh UUID per call keeps the unread-dedup index from collapsing
  // distinct questions; passing entity_id (e.g. a comment id) opts into dedup.
  const entityId = notification.entity_id || randomUUID();

  // Named here, never worked out from the free-text title: an agent's
  // escalation is an update the person reads (agent_message), not a receipt
  // for a question nobody asked. Only the findings nudge convention is one.
  const category = agentNoticeCategory(notification.entity_type, notification.title);
  // A link stays inside the app (a path, never another site or //host): any other is dropped, so a key never puts
  // someone else's address behind a notice.
  const link = notification.link && isRelativeAppPath(notification.link.trim()) ? notification.link.trim() : null;
  for (const recipient of recipients || []) {
    await upsertNotification(supabase, {
      userId: recipient.id,
      title: notification.title,
      message: notification.message,
      link,
      entityType: notification.entity_type,
      entityId,
      category,
      actorId: teamMemberId ?? null,
    });
  }

  const result = { notified: (recipients || []).length, entity_id: entityId };
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/notifications', entityType: notification.entity_type, entityId, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result, statusCode: 201 });
  return created(result);
}, { schema: createNotificationSchema, permission: 'notifications.send' });
