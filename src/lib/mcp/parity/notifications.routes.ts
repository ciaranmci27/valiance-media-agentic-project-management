import 'server-only';
import type { HttpMethod } from '../core';
import * as notification from '@/app/api/v1/notifications/[id]/route';
import * as notificationsMarkAllRead from '@/app/api/v1/notifications/mark-all-read/route';
import * as notificationsDone from '@/app/api/v1/notifications/done/route';
import * as notificationGroups from '@/app/api/v1/notifications/groups/route';
import * as notificationSnoozes from '@/app/api/v1/notifications/snoozes/route';
import * as notificationSnooze from '@/app/api/v1/notifications/snoozes/[kind]/[itemId]/route';
import * as webhookDeliveries from '@/app/api/v1/webhook-endpoints/[id]/deliveries/route';
import * as webhookDeliveryRequeue from '@/app/api/v1/webhook-endpoints/[id]/deliveries/[deliveryId]/requeue/route';
import * as webhookSecret from '@/app/api/v1/webhook-endpoints/[id]/secret/route';

/** Notifications and webhooks: the v1 route module behind each tool path (routes.ts merges these). */
export const NOTIFICATIONS_ROUTE_MODULES: Record<string, Partial<Record<HttpMethod, unknown>>> = {
  // Notifications
  '/api/v1/notifications/{id}': notification,
  '/api/v1/notifications/mark-all-read': notificationsMarkAllRead,
  '/api/v1/notifications/done': notificationsDone,
  '/api/v1/notifications/groups': notificationGroups,
  '/api/v1/notifications/snoozes': notificationSnoozes,
  '/api/v1/notifications/snoozes/{kind}/{itemId}': notificationSnooze,
  // Webhooks
  '/api/v1/webhook-endpoints/{id}/deliveries': webhookDeliveries,
  '/api/v1/webhook-endpoints/{id}/deliveries/{deliveryId}/requeue': webhookDeliveryRequeue,
  '/api/v1/webhook-endpoints/{id}/secret': webhookSecret,
};
