import type { Handler, Harness } from './harness';

/** A route module whose handlers type their params (the harness passes them as a plain record). */
const routes = <M extends object>(module: M) => module as unknown as Record<keyof M, Handler>;

/**
 * Notifications and webhooks: a key reads and clears only its own member's
 * bell (done, snoozes, groups, read), an agent's key its own; webhook
 * deliveries list and resend, and a signing secret rotates, only with
 * webhooks.manage (an Owner's key by default), never answering an existing
 * secret. MCP calls the same routes.
 */
export async function notificationsArea(h: Harness) {
  const { q, key, call, tool, toolNames, check, members } = h;
  const done = await import('../../src/app/api/v1/notifications/done/route');
  const groups = await import('../../src/app/api/v1/notifications/groups/route');
  const snoozes = await import('../../src/app/api/v1/notifications/snoozes/route');
  const snooze = routes(await import('../../src/app/api/v1/notifications/snoozes/[kind]/[itemId]/route'));
  const deliveries = routes(await import('../../src/app/api/v1/webhook-endpoints/[id]/deliveries/route'));
  const requeue = routes(await import('../../src/app/api/v1/webhook-endpoints/[id]/deliveries/[deliveryId]/requeue/route'));
  const secret = routes(await import('../../src/app/api/v1/webhook-endpoints/[id]/secret/route'));

  // Notifications: the member's and the agent's own, on distinct entities.
  // One unread row per entity (idx_team_member_notifications_dedup): the older one on a shared entity is read.
  const notify = async (userId: string, title: string, entityId: string, read = false) => (await q<{ id: string }>(
    "INSERT INTO pm.team_member_notifications (user_id, title, message, entity_type, entity_id, is_read, created_at) VALUES ($1, $2, 'Parity notice', 'task', $3, $4, now() - interval '1 minute' * $5) RETURNING id",
    [userId, title, entityId, read, read ? 5 : 0]))[0].id;
  const thread = '6f1c0000-0000-4000-8000-00000000a001';
  const M1 = await notify(members.member, 'Parity bell: first comment', thread, true);
  const M2 = await notify(members.member, 'Parity bell: second comment', thread);
  const M3 = await notify(members.member, 'Parity bell: other task', '6f1c0000-0000-4000-8000-00000000a002');
  const A1 = await notify(members.agent, 'Parity bell: agent task', '6f1c0000-0000-4000-8000-00000000a003');
  const doneAt = async (id: string) => (await q<{ done_at: string | null; is_read: boolean }>('SELECT done_at, is_read FROM pm.team_member_notifications WHERE id = $1', [id]))[0];

  const memberKey = await key(members.member, ['notifications.manage_own']);
  const memberNoScope = await key(members.member, ['tasks.read']);
  const agentKey = await key(members.agent, ['notifications.manage_own']);

  // Done over REST.
  const marked = await call(done.POST, memberKey, 'POST', '/api/v1/notifications/done', {}, { ids: [M1] });
  const m1 = await doneAt(M1);
  check('notifications: the member marks their own notification done (done and read in the database)', marked.status === 200 && marked.json.data?.updated === 1 && !!m1.done_at && m1.is_read, { marked: marked.json, m1 });
  const noScope = await call(done.POST, memberNoScope, 'POST', '/api/v1/notifications/done', {}, { ids: [M3] });
  check('notifications: a key without notifications.manage_own is refused (403)', noScope.status === 403 && !(await doneAt(M3)).done_at, noScope.json);
  const notTheirs = await call(done.POST, agentKey, 'POST', '/api/v1/notifications/done', {}, { ids: [M3] });
  check('notifications: an agent key cannot mark the member\'s notification done (updated 0)', notTheirs.status === 200 && notTheirs.json.data?.updated === 0 && !(await doneAt(M3)).done_at, notTheirs.json);
  const undone = await call(done.POST, memberKey, 'POST', '/api/v1/notifications/done', {}, { ids: [M1], done: false });
  check('notifications: not done again clears done_at', undone.status === 200 && undone.json.data?.updated === 1 && !(await doneAt(M1)).done_at, undone.json);
  const badBody = await call(done.POST, memberKey, 'POST', '/api/v1/notifications/done', {}, { ids: [M1], all: true });
  check('notifications: ids with all is a 422', badBody.status === 422, badBody.json);

  // Done over MCP: the agent's own.
  const agentTools = await toolNames(agentKey);
  check('notifications mcp: an agent key with notifications.manage_own sees the bell tools', ['mark_notifications_done', 'mark_notification_read', 'mark_all_notifications_read', 'list_notification_groups', 'list_snoozes', 'snooze_item', 'unsnooze_item'].every((n) => agentTools.includes(n))
    && !agentTools.includes('list_webhook_deliveries') && !agentTools.includes('rotate_webhook_secret'), agentTools);
  const doneOver = await tool(agentKey, 'mark_notifications_done', { ids: [A1] });
  check('notifications mcp: mark_notifications_done marks the agent\'s own done', doneOver.result.ok === true && doneOver.result.data?.updated === 1 && !!(await doneAt(A1)).done_at, doneOver.result);
  const readOther = await tool(agentKey, 'mark_notification_read', { notification_id: M3 });
  check('notifications mcp: mark_notification_read on someone else\'s is 403', readOther.result.ok !== true && readOther.result.status === 403 && !(await doneAt(M3)).is_read, readOther.result);
  const readOwn = await tool(memberKey, 'mark_notification_read', { notification_id: M3 });
  check('notifications mcp: mark_notification_read marks the member\'s own read', readOwn.result.ok === true && (await doneAt(M3)).is_read === true, readOwn.result);
  const allRead = await tool(memberKey, 'mark_all_notifications_read', {});
  check('notifications mcp: mark_all_notifications_read marks the rest read', allRead.result.ok === true && allRead.result.data?.marked_read >= 1 && (await doneAt(M2)).is_read === true, allRead.result);

  // Grouped feed.
  const grouped = await call(groups.GET, memberKey, 'GET', '/api/v1/notifications/groups?limit=50');
  const threadGroup = (grouped.json.data?.groups ?? []).find((g: { group_key: string }) => g.group_key === `task:${thread}`);
  check('notifications: the grouped feed puts both comments on one task in one group, latest first', grouped.status === 200 && Array.isArray(grouped.json.data?.groups)
    && 'next_cursor' in grouped.json.data && threadGroup?.group_count === 2 && threadGroup?.latest?.id === M2, grouped.json);
  const groupedNoScope = await call(groups.GET, memberNoScope, 'GET', '/api/v1/notifications/groups');
  check('notifications: the grouped feed is refused without notifications.manage_own', groupedNoScope.status === 403, groupedNoScope.json);
  const groupedOver = await tool(agentKey, 'list_notification_groups', {});
  check('notifications mcp: list_notification_groups answers the agent\'s own groups only', groupedOver.result.ok === true
    && !(groupedOver.result.data?.groups ?? []).some((g: { latest: { id: string } }) => [M1, M2, M3].includes(g.latest.id)), groupedOver.result);

  // Snoozes: snooze, list, unsnooze, over REST and MCP.
  const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const snoozed = await call(snoozes.POST, memberKey, 'POST', '/api/v1/notifications/snoozes', {}, { item_kind: 'notification', item_id: M3, until });
  const snoozeRow = await q('SELECT until FROM pm.member_snoozes WHERE member_id = $1 AND item_kind = $2 AND item_id = $3', [members.member, 'notification', M3]);
  check('notifications: the member snoozes a notification (a row in member_snoozes)', snoozed.status === 200 && snoozed.json.data?.item_id === M3 && snoozeRow.length === 1, snoozed.json);
  const afterSnooze = await call(groups.GET, memberKey, 'GET', '/api/v1/notifications/groups?limit=50');
  check('notifications: a snoozed notification leaves the grouped feed', !(afterSnooze.json.data?.groups ?? []).some((g: { latest: { id: string } }) => g.latest.id === M3), afterSnooze.json);
  const tooFar = await call(snoozes.POST, memberKey, 'POST', '/api/v1/notifications/snoozes', {}, { item_kind: 'task', item_id: M3, until: new Date(Date.now() + 200 * 86_400_000).toISOString() });
  check('notifications: a snooze past 90 days is 422 until_too_far', tooFar.status === 422 && tooFar.json.error?.details?.reason === 'until_too_far', tooFar.json);
  const listed = await call(snoozes.GET, memberKey, 'GET', '/api/v1/notifications/snoozes');
  check('notifications: list snoozes answers it', listed.status === 200 && (listed.json.data ?? []).some((s: { item_id: string }) => s.item_id === M3), listed.json);
  const agentList = await tool(agentKey, 'list_snoozes', {});
  check('notifications mcp: the agent\'s list_snoozes never shows the member\'s', agentList.result.ok === true && !(agentList.result.data ?? []).some((s: { item_id: string }) => s.item_id === M3), agentList.result);
  const unsnoozed = await call(snooze.DELETE, memberKey, 'DELETE', `/api/v1/notifications/snoozes/notification/${M3}`, { kind: 'notification', itemId: M3 });
  check('notifications: unsnooze removes it', unsnoozed.status === 200 && unsnoozed.json.data?.removed === true
    && (await q('SELECT 1 FROM pm.member_snoozes WHERE member_id = $1 AND item_id = $2', [members.member, M3])).length === 0, unsnoozed.json);
  const badKind = await call(snooze.DELETE, memberKey, 'DELETE', `/api/v1/notifications/snoozes/email/${M3}`, { kind: 'email', itemId: M3 });
  check('notifications: unsnooze with an unknown kind is 400', badKind.status === 400, badKind.json);
  const snoozeOver = await tool(agentKey, 'snooze_item', { item_kind: 'task', item_id: thread, until });
  check('notifications mcp: snooze_item snoozes for the agent itself', snoozeOver.result.ok === true
    && (await q('SELECT 1 FROM pm.member_snoozes WHERE member_id = $1 AND item_id = $2', [members.agent, thread])).length === 1, snoozeOver.result);
  const unsnoozeOver = await tool(agentKey, 'unsnooze_item', { item_kind: 'task', item_id: thread });
  check('notifications mcp: unsnooze_item brings it back', unsnoozeOver.result.ok === true && unsnoozeOver.result.data?.removed === true
    && (await q('SELECT 1 FROM pm.member_snoozes WHERE member_id = $1 AND item_id = $2', [members.agent, thread])).length === 0, unsnoozeOver.result);

  // Webhooks: an endpoint that is off (so nothing dispatches during the checks) and its deliveries.
  const E = (await q<{ id: string }>("INSERT INTO pm.webhook_endpoints (name, url, secret, events, is_active) VALUES ('Parity hooks', 'https://hooks.example.invalid/parity', 'whsec_parity_original', ARRAY['task.updated'], false) RETURNING id"))[0].id;
  const E2 = (await q<{ id: string }>("INSERT INTO pm.webhook_endpoints (name, url, secret, events, is_active) VALUES ('Parity other hooks', 'https://hooks.example.invalid/other', 'whsec_parity_other', ARRAY['task.updated'], false) RETURNING id"))[0].id;
  const event = async (n: number) => (await q<{ id: string }>(
    "INSERT INTO pm.webhook_events (event_id, sequence, event_type, resource_type, payload) VALUES ($1, nextval('pm.webhook_event_seq'), 'task.updated', 'task', '{}'::jsonb) RETURNING id",
    [`evt_parity_${n}_${Date.now()}`]))[0].id;
  const delivery = async (endpointId: string, status: string) => (await q<{ id: string }>(
    "INSERT INTO pm.webhook_deliveries (webhook_event_id, endpoint_id, status, attempts, last_error, attempt_token) VALUES ($1, $2, $3, $4, $5, gen_random_uuid()) RETURNING id",
    [await event(Math.floor(Math.random() * 1e9)), endpointId, status, status === 'failed' ? 8 : 1, status === 'failed' ? 'HTTP 500' : null]))[0].id;
  const D1 = await delivery(E, 'failed');
  const D2 = await delivery(E, 'succeeded');
  const D3 = await delivery(E2, 'failed');

  const ownerHooks = await key(members.owner, ['webhooks.manage']);
  const ownerNoScope = await key(members.owner, ['notifications.manage_own']);
  const memberHooks = await key(members.member, ['webhooks.manage']);

  const list = await call(deliveries.GET, ownerHooks, 'GET', `/api/v1/webhook-endpoints/${E}/deliveries`, { id: E });
  const listedIds = (list.json.data ?? []).map((d: { id: string }) => d.id);
  check('webhooks: an Owner key with webhooks.manage lists the endpoint\'s deliveries, and only its', list.status === 200 && listedIds.includes(D1) && listedIds.includes(D2) && !listedIds.includes(D3)
    && list.json.data.find((d: { id: string }) => d.id === D1)?.webhook_events?.event_type === 'task.updated', list.json);
  check('webhooks: a delivery never carries a secret or the lease token', !/whsec_|"secret"|attempt_token/.test(JSON.stringify(list.json)), list.json);
  const failedOnly = await call(deliveries.GET, ownerHooks, 'GET', `/api/v1/webhook-endpoints/${E}/deliveries?status=failed`, { id: E });
  check('webhooks: status=failed narrows', failedOnly.status === 200 && failedOnly.json.data?.length === 1 && failedOnly.json.data[0].id === D1, failedOnly.json);
  const listNoScope = await call(deliveries.GET, ownerNoScope, 'GET', `/api/v1/webhook-endpoints/${E}/deliveries`, { id: E });
  check('webhooks: a key without webhooks.manage is refused (403)', listNoScope.status === 403, listNoScope.json);
  const listMember = await call(deliveries.GET, memberHooks, 'GET', `/api/v1/webhook-endpoints/${E}/deliveries`, { id: E });
  check('webhooks: a member whose role lacks webhooks.manage is refused even with the scope', listMember.status === 403, listMember.json);
  const unknown = await call(deliveries.GET, ownerHooks, 'GET', '/api/v1/webhook-endpoints/6f1c0000-0000-4000-8000-0000000000ee/deliveries', { id: '6f1c0000-0000-4000-8000-0000000000ee' });
  check('webhooks: an unknown endpoint is 404', unknown.status === 404, unknown.json);

  const wrongEndpoint = await call(requeue.POST, ownerHooks, 'POST', `/api/v1/webhook-endpoints/${E}/deliveries/${D3}/requeue`, { id: E, deliveryId: D3 });
  check('webhooks: requeue of another endpoint\'s delivery is 404', wrongEndpoint.status === 404, wrongEndpoint.json);
  const requeueNoScope = await call(requeue.POST, ownerNoScope, 'POST', `/api/v1/webhook-endpoints/${E}/deliveries/${D1}/requeue`, { id: E, deliveryId: D1 });
  check('webhooks: requeue without webhooks.manage is refused and changes nothing', requeueNoScope.status === 403
    && (await q<{ status: string }>('SELECT status FROM pm.webhook_deliveries WHERE id = $1', [D1]))[0].status === 'failed', requeueNoScope.json);
  const requeued = await call(requeue.POST, ownerHooks, 'POST', `/api/v1/webhook-endpoints/${E}/deliveries/${D1}/requeue`, { id: E, deliveryId: D1 });
  const d1 = (await q<{ status: string; attempts: number; last_error: string | null }>('SELECT status, attempts, last_error FROM pm.webhook_deliveries WHERE id = $1', [D1]))[0];
  check('webhooks: requeue puts a failed delivery back to pending with a fresh budget', requeued.status === 200 && requeued.json.data?.status === 'pending'
    && d1.status === 'pending' && d1.attempts === 0 && d1.last_error === null, { requeued: requeued.json, d1 });
  const notFailed = await call(requeue.POST, ownerHooks, 'POST', `/api/v1/webhook-endpoints/${E}/deliveries/${D2}/requeue`, { id: E, deliveryId: D2 });
  check('webhooks: requeue of a delivered one is 409 not_failed', notFailed.status === 409 && notFailed.json.error?.details?.reason === 'not_failed', notFailed.json);

  const ownerTools = await toolNames(ownerHooks);
  check('webhooks mcp: an Owner key with webhooks.manage sees the delivery and secret tools', ['list_webhook_deliveries', 'requeue_webhook_delivery', 'rotate_webhook_secret'].every((n) => ownerTools.includes(n)), ownerTools);
  const listOver = await tool(ownerHooks, 'list_webhook_deliveries', { endpoint_id: E2 });
  check('webhooks mcp: list_webhook_deliveries lists the endpoint\'s deliveries', listOver.result.ok === true && (listOver.result.data ?? []).some((d: { id: string }) => d.id === D3), listOver.result);
  const requeueOver = await tool(ownerHooks, 'requeue_webhook_delivery', { endpoint_id: E2, delivery_id: D3 });
  check('webhooks mcp: requeue_webhook_delivery resends it', requeueOver.result.ok === true
    && (await q<{ status: string }>('SELECT status FROM pm.webhook_deliveries WHERE id = $1', [D3]))[0].status === 'pending', requeueOver.result);
  const requeueOverRefused = await tool(memberHooks, 'requeue_webhook_delivery', { endpoint_id: E, delivery_id: D2 });
  check('webhooks mcp: requeue_webhook_delivery is not listed and refused for a member key', !requeueOverRefused.listed && requeueOverRefused.result.ok !== true, requeueOverRefused.result);

  // Rotate a signing secret: the new one once, the stored value changed, never the old one.
  const storedSecret = async (id: string) => (await q<{ secret: string }>('SELECT secret FROM pm.webhook_endpoints WHERE id = $1', [id]))[0].secret;
  const rotated = await call(secret.POST, ownerHooks, 'POST', `/api/v1/webhook-endpoints/${E}/secret`, { id: E });
  const afterRotate = await storedSecret(E);
  check('webhooks: rotate answers a new whsec_ secret, the stored value changes, the old one is never answered', rotated.status === 200 && /^whsec_/.test(rotated.json.data?.secret ?? '')
    && afterRotate !== 'whsec_parity_original' && (afterRotate === rotated.json.data.secret || !afterRotate.startsWith('whsec_'))
    && !JSON.stringify(rotated.json).includes('whsec_parity_original'), { rotated: rotated.json });
  const rotateNoScope = await call(secret.POST, ownerNoScope, 'POST', `/api/v1/webhook-endpoints/${E}/secret`, { id: E });
  check('webhooks: rotate without webhooks.manage is refused and the secret stays', rotateNoScope.status === 403 && (await storedSecret(E)) === afterRotate, rotateNoScope.json);
  const rotateMember = await call(secret.POST, memberHooks, 'POST', `/api/v1/webhook-endpoints/${E}/secret`, { id: E });
  check('webhooks: rotate by a member whose role lacks webhooks.manage is refused', rotateMember.status === 403 && (await storedSecret(E)) === afterRotate, rotateMember.json);
  const rotateUnknown = await call(secret.POST, ownerHooks, 'POST', '/api/v1/webhook-endpoints/6f1c0000-0000-4000-8000-0000000000ee/secret', { id: '6f1c0000-0000-4000-8000-0000000000ee' });
  check('webhooks: rotate of an unknown endpoint is 404', rotateUnknown.status === 404, rotateUnknown.json);
  const rotateOver = await tool(ownerHooks, 'rotate_webhook_secret', { endpoint_id: E2 });
  const e2 = await storedSecret(E2);
  check('webhooks mcp: rotate_webhook_secret answers the new secret once and changes the stored one', rotateOver.result.ok === true && /^whsec_/.test(rotateOver.result.data?.secret ?? '')
    && e2 !== 'whsec_parity_other' && !JSON.stringify(rotateOver.result).includes('whsec_parity_other'), rotateOver.result);
  const rotateOverRefused = await tool(ownerNoScope, 'rotate_webhook_secret', { endpoint_id: E2 });
  check('webhooks mcp: rotate_webhook_secret is refused without webhooks.manage', !rotateOverRefused.listed && rotateOverRefused.result.ok !== true && (await storedSecret(E2)) === e2, rotateOverRefused.result);

  await q('DELETE FROM pm.webhook_endpoints WHERE id IN ($1, $2)', [E, E2]);
}
