import type { EndpointDoc } from '../docs-data';

const OWN = ['notifications.manage_own (the key\'s own member; closed to a company agent acting for someone)'];
const WEBHOOKS = ['webhooks.manage'];
const SNOOZE_KINDS_TEXT = 'question, task, suggestion or notification';

/** Notifications and webhooks. */
export const NOTIFICATIONS_ENDPOINTS: EndpointDoc[] = [
  // Notifications
  {
    method: 'POST', path: '/api/v1/notifications/done', group: 'Notifications', scopes: OWN,
    description: 'Marks the key\'s own member\'s notifications done (done implies read), not done again, or every open Update done, as the Notifications page does. { all: true } leaves receipts (notices for a question or approval waiting in Needs you) as they are. Answers { updated }. 503 database_update_needed before 20261127000700. MCP: mark_notifications_done.',
    body: [
      { name: 'ids', type: 'uuid[]', required: false, description: '1-200 of your notification ids (or all)' },
      { name: 'done', type: 'boolean', required: false, description: 'With ids: true (default) marks done, false not done again' },
      { name: 'all', type: 'boolean', required: false, description: 'true: every open Update done (instead of ids)' },
    ],
  },
  {
    method: 'GET', path: '/api/v1/notifications/groups', group: 'Notifications', scopes: OWN,
    description: 'The key\'s own member\'s Updates grouped by what they are about (entity type and id), as the Notifications page groups them: { groups: [{ latest, group_key, group_count, unread_count }], next_cursor }, newest group first; done, receipts and snoozed notifications left out. MCP: list_notification_groups.',
    queryParams: [
      { name: 'limit', type: 'number', description: '1-100, default 30' },
      { name: 'before', type: 'string', description: 'The previous page\'s next_cursor' },
    ],
  },
  {
    method: 'GET', path: '/api/v1/notifications/snoozes', group: 'Notifications', scopes: OWN,
    description: 'The key\'s own member\'s snoozes still in force, soonest to wake first: [{ item_kind, item_id, until }]. MCP: list_snoozes.',
  },
  {
    method: 'POST', path: '/api/v1/notifications/snoozes', group: 'Notifications', scopes: OWN,
    description: `Snoozes one item for the key's own member (${SNOOZE_KINDS_TEXT}), as Snooze in Needs you and Updates: it is hidden from them until until. Snoozing it again moves the time. 422 until_past or until_too_far (at most 90 days). Answers { item_kind, item_id, until }. MCP: snooze_item.`,
    body: [
      { name: 'item_kind', type: 'string', required: true, description: SNOOZE_KINDS_TEXT },
      { name: 'item_id', type: 'uuid', required: true, description: 'The item' },
      { name: 'until', type: 'string', required: true, description: 'ISO time with offset, in the future, at most 90 days away' },
    ],
  },
  {
    method: 'DELETE', path: '/api/v1/notifications/snoozes/:kind/:itemId', group: 'Notifications', scopes: OWN,
    description: 'Brings one of the key\'s own member\'s snoozed items back now. Answers { removed }: false when it was not snoozed. MCP: unsnooze_item.',
    params: [
      { name: 'kind', type: 'string', required: true, description: SNOOZE_KINDS_TEXT },
      { name: 'itemId', type: 'uuid', required: true, description: 'The item' },
    ],
  },
  // Webhooks
  {
    method: 'GET', path: '/api/v1/webhook-endpoints/:id/deliveries', group: 'Webhook Endpoints', scopes: WEBHOOKS,
    description: 'One endpoint\'s deliveries, newest first, as Recent deliveries in Settings > Developers: id, webhook_event_id, status (pending, delivering, succeeded, failed), attempts, last_attempt_at, last_status_code, last_error, last_response, delivered_at, next_attempt_at, lease_expires_at, created_at, updated_at and webhook_events { event_id, event_type, created_at }. Never a signing secret. 404 for an unknown endpoint. MCP: list_webhook_deliveries.',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The endpoint' }],
    queryParams: [
      { name: 'status', type: 'string', description: 'pending, delivering, succeeded or failed' },
      { name: 'limit', type: 'number', description: '1-100, default 25' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/webhook-endpoints/:id/deliveries/:deliveryId/requeue', group: 'Webhook Endpoints', scopes: WEBHOOKS,
    description: 'Resends a failed delivery, as Resend in Settings > Developers: back to pending with a fresh attempt budget, sent right after the answer. 404 when the delivery is not this endpoint\'s; 409 not_failed (with its status) when it is waiting, sending or delivered. Answers the delivery as it is now. MCP: requeue_webhook_delivery.',
    params: [
      { name: 'id', type: 'uuid', required: true, description: 'The endpoint' },
      { name: 'deliveryId', type: 'uuid', required: true, description: 'The delivery' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/webhook-endpoints/:id/secret', group: 'Webhook Endpoints', scopes: WEBHOOKS,
    description: 'A new signing secret for the endpoint (New signing secret in Settings > Developers), for when the old one may have leaked: the endpoint keeps its id, filters and delivery history, and the old secret stops at once. Answers { secret } (whsec_...), shown only in this answer, as on create, so the Idempotency-Key header is refused (400 idempotency_not_supported). An existing secret is never read over the API. MCP: rotate_webhook_secret (it answers a new secret once, as create_webhook_endpoint does).',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The endpoint' }],
  },
];
