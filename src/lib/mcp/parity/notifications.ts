import { z } from 'zod';
import { routeTool, type PmTool } from '../core';
import { SNOOZE_KINDS, SNOOZE_MAX_DAYS } from '@/lib/notifications';
import { WEBHOOK_DELIVERY_STATUSES } from '@/lib/types';
import { id } from './shared';

/** Notifications and webhooks. */
export const NOTIFICATIONS_TOOLS: PmTool[] = [
  // Notifications: your own bell, as the Notifications page reads and clears it.
  routeTool({
    name: 'mark_notification_read',
    lead: 'Mark one of your notifications read or unread.',
    detail: 'notification_id is one of your own (from list_notifications or list_notification_groups); is_read defaults to true, false marks it unread again. Someone else\'s is 403. Answers the notification.',
    input: z.object({ notification_id: id('notification_id'), is_read: z.boolean().default(true) }).strict(),
    permission: 'notifications.manage_own',
    method: 'PATCH',
    path: '/api/v1/notifications/{id}',
    destructive: false,
    request: ({ notification_id, is_read }) => ({ params: { id: notification_id }, body: { is_read } }),
  }),
  routeTool({
    name: 'mark_all_notifications_read',
    lead: 'Mark all your unread notifications read.',
    detail: 'Every unread notification of yours becomes read, or only one group\'s with group_key (from list_notification_groups), as opening a grouped row in the app; done and snoozes are left as they are. Answers { marked_read }.',
    input: z.object({ group_key: z.string().min(3).max(240).optional().describe('One group only') }).strict(),
    permission: 'notifications.manage_own',
    method: 'POST',
    path: '/api/v1/notifications/mark-all-read',
    idempotent: true,
    request: ({ group_key }) => (group_key ? { body: { group_key } } : {}),
  }),
  routeTool({
    name: 'mark_notifications_done',
    lead: 'Mark your notifications done, or not done again.',
    detail: 'Done takes a notification off your Updates (and marks it read), as in the app. ids with done true (the default) or false; all true for every open Update (receipts for a question or approval waiting on you stay, since Needs you owns those); or group_key for every open Update in one group (Done on a grouped row). Answers { updated }.',
    input: z.object({
      ids: z.array(id('ids')).min(1).max(200).optional().describe('Your notification ids'),
      all: z.literal(true).optional().describe('Every open Update'),
      group_key: z.string().min(3).max(240).optional().describe('Every open Update in one group'),
      done: z.boolean().optional().describe('true (default) marks done, false not done again; ids only'),
    }).strict().refine((value) => [value.ids, value.all, value.group_key].filter((v) => v !== undefined).length === 1, 'Send one of ids, all or group_key')
      .refine((value) => !((value.all || value.group_key) && value.done === false), 'all and group_key only mark done: send ids to mark not done'),
    permission: 'notifications.manage_own',
    method: 'POST',
    path: '/api/v1/notifications/done',
    idempotent: true,
    request: ({ ids, done, group_key }) => ({ body: ids ? { ids, done: done ?? true } : group_key ? { group_key } : { all: true } }),
  }),
  routeTool({
    name: 'list_notification_groups',
    lead: 'List your Updates grouped by what they are about.',
    detail: 'As the Notifications page groups them: each group\'s latest notification (latest) with group_key, group_count and unread_count, newest group first, and total (how many groups); done, receipts and snoozed left out. from_agents keeps notices an agent sent; project_ids keeps some projects. Page with before set to the last answer\'s next_cursor (null at the end). limit 1-100, default 30. A group\'s rows: list_notifications with group_key; mark_all_notifications_read and mark_notifications_done take group_key too.',
    input: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      before: z.string().min(1).max(200).optional().describe('next_cursor from the previous page'),
      from_agents: z.boolean().optional().describe('Only notices an agent sent'),
      project_ids: z.array(id('project_ids')).min(1).max(50).optional().describe('Only these projects'),
    }).strict(),
    permission: 'notifications.manage_own',
    method: 'GET',
    path: '/api/v1/notifications/groups',
    request: ({ from_agents, project_ids, ...rest }) => ({ query: { ...rest, ...(from_agents ? { from: 'agents' } : {}), ...(project_ids ? { project_id: project_ids.join(',') } : {}) } }),
  }),

  // Snoozes: hide a question, task, suggestion or notification from yourself until a time.
  routeTool({
    name: 'list_snoozes',
    lead: 'List what you have snoozed and when it comes back.',
    detail: 'Your snoozes still in force, soonest to wake first: item_kind, item_id and until. Bring one back early with unsnooze_item.',
    input: z.object({}).strict(),
    permission: 'notifications.manage_own',
    method: 'GET',
    path: '/api/v1/notifications/snoozes',
    request: () => ({}),
  }),
  routeTool({
    name: 'snooze_item',
    lead: 'Hide a question, task or notification until a time.',
    detail: `For you only, as Snooze in Needs you and Updates: item_kind question, task, suggestion or notification, item_id, and until (an ISO time with offset, in the future, at most ${SNOOZE_MAX_DAYS} days away). Snoozing it again moves the time. Answers the snooze.`,
    input: z.object({
      item_kind: z.enum(SNOOZE_KINDS),
      item_id: id('item_id'),
      until: z.string().datetime({ offset: true }).describe('When it comes back, such as 2026-12-01T09:00:00-07:00'),
    }).strict(),
    permission: 'notifications.manage_own',
    method: 'POST',
    path: '/api/v1/notifications/snoozes',
    idempotent: true,
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'unsnooze_item',
    lead: 'Bring a snoozed item back now.',
    detail: 'item_kind and item_id as you snoozed them (list_snoozes). Answers { removed }: false when it was not snoozed.',
    input: z.object({ item_kind: z.enum(SNOOZE_KINDS), item_id: id('item_id') }).strict(),
    permission: 'notifications.manage_own',
    method: 'DELETE',
    path: '/api/v1/notifications/snoozes/{kind}/{itemId}',
    destructive: false,
    request: ({ item_kind, item_id }) => ({ params: { kind: item_kind, itemId: item_id } }),
  }),

  // Webhooks: what was sent to an endpoint, resending, and a new signing secret.
  routeTool({
    name: 'list_webhook_deliveries',
    lead: 'List what was sent to a webhook endpoint.',
    detail: 'Needs webhooks.manage. Newest first, as Recent deliveries in Settings > Developers: status (pending, delivering, succeeded, failed), attempts, next_attempt_at, last_status_code, last_error, last_response, delivered_at and the event (webhook_events: event_id, event_type). Use it to see why a harness was not woken. status narrows; limit 1-100, default 25. Resend a failed one with requeue_webhook_delivery.',
    input: z.object({
      endpoint_id: id('endpoint_id'),
      status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }).strict(),
    permission: 'webhooks.manage',
    method: 'GET',
    path: '/api/v1/webhook-endpoints/{id}/deliveries',
    request: ({ endpoint_id, ...query }) => ({ params: { id: endpoint_id }, query }),
  }),
  routeTool({
    name: 'requeue_webhook_delivery',
    lead: 'Resend a failed webhook delivery.',
    detail: 'Needs webhooks.manage. As Resend in Settings > Developers: a failed delivery starts over with a fresh attempt budget and is sent right away. 409 not_failed when it is waiting, sending or already delivered. Answers the delivery as it is now.',
    input: z.object({ endpoint_id: id('endpoint_id'), delivery_id: id('delivery_id') }).strict(),
    permission: 'webhooks.manage',
    method: 'POST',
    path: '/api/v1/webhook-endpoints/{id}/deliveries/{deliveryId}/requeue',
    idempotent: true,
    request: ({ endpoint_id, delivery_id }) => ({ params: { id: endpoint_id, deliveryId: delivery_id } }),
  }),
  routeTool({
    name: 'rotate_webhook_secret',
    lead: 'Give a webhook endpoint a new signing secret.',
    detail: "Needs webhooks.manage. For when the old secret may have leaked: the endpoint keeps its id, filters and history, and the old secret stops at once. The answer's secret signs every delivery from now on and is the only copy: put it in the receiver now. An existing secret is never shown. No idempotency_key: on a timeout, rotate again.",
    input: z.object({ endpoint_id: id('endpoint_id') }).strict(),
    permission: 'webhooks.manage',
    method: 'POST',
    path: '/api/v1/webhook-endpoints/{id}/secret',
    destructive: true,
    request: ({ endpoint_id }) => ({ params: { id: endpoint_id } }),
  }),
];
