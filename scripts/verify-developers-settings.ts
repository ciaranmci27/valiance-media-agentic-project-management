/**
 * Settings > Developers, its rules on their own: who sees the Webhooks
 * section (and whether it offers to turn the module on), a person's keys
 * sorted into theirs, other people's, agents' and ended, the expiry line a
 * key row shows, rotation choices, the plain-words scope groups, and the
 * webhook endpoint form's steps, checks, saved columns, health and event
 * summary. Pure; no database, no network.
 *
 *   npm run -s test:developers-settings
 */
import {
  agentKeyLifetimeSettingOptions, agentKeyRow, ownKeysInSettings, keysInScope, seesDevelopers, deliveryDetailLine, endpointHealth, eventSummary, firstWebhookProblem, groupApiKeys, groupEventsFor, keyEnded, keyExpiry, keyPauseAction, keyScopeGroups,
  parseAgentEventTypes, replacedKeyIds, rotateOverlapOptions, rotatedKeyExpiryLine, rotationLifetimeNote, webhookEventGroups, webhookFields,
  webhookSaveError, webhooksSectionState, webhookStepProblem, ENDPOINT_HEALTH_DELIVERIES, ROTATE_OVERLAP_DEFAULT_HOURS,
  WEBHOOK_EVENT_GROUPS, WEBHOOK_EVENT_LABELS, type WebhookDraft,
} from '@/lib/developers-settings';
import {
  accessChannelsFor, permissionLabel, permissionLabels, permissionOffered, API_ENDPOINT_PERMISSIONS, APP_CHANNEL_PERMISSIONS, KEY_ONLY_PERMISSIONS, UNOFFERED_PERMISSIONS,
  PERMISSION_GROUPS, PERMISSIONS,
} from '@/lib/access-control';
import { NEVER_AGENT_SCOPES } from '@/lib/agents-ui';
import { capKeyLifetime, rotatedKeyLifetimeDays } from '@/lib/api/key-lifetime';
import { keyTreeOf, type LineageKey } from '@/lib/api/key-revoke';
import { DATA_RETENTION_RUN_UTC, nextDailyRun, retentionConfirmMessage, rowsInWords, shortenedRetention } from '@/lib/data-retention';
import { auditCsv } from '@/lib/audit-log';
import { WEBHOOK_EVENT_TYPES, type ApiKey, type WebhookDelivery } from '@/lib/types';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const NOW = new Date('2026-11-24T12:00:00Z');
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

// ── Webhooks section ────────────────────────────────────────────────────
{
  const base = { isDemoMode: false, moduleOn: true, holdsPermission: true, isOwner: false };
  check('module on and allowed: manage', webhooksSectionState(base) === 'manage');
  check('module on, not allowed: hidden', webhooksSectionState({ ...base, holdsPermission: false }) === 'hidden');
  check('module off, Owner: offers to turn it on', webhooksSectionState({ ...base, moduleOn: false, isOwner: true }) === 'turn-on');
  check('module off, allowed but not an Owner: ask an Owner', webhooksSectionState({ ...base, moduleOn: false }) === 'ask-owner');
  check('module off, no webhook access: hidden', webhooksSectionState({ ...base, moduleOn: false, holdsPermission: false }) === 'hidden');
  check('demo workspace: hidden either way', webhooksSectionState({ ...base, isDemoMode: true }) === 'hidden'
    && webhooksSectionState({ ...base, isDemoMode: true, moduleOn: false, isOwner: true }) === 'hidden');
}

// ── Keys ────────────────────────────────────────────────────────────────
function key(id: string, fields: Partial<ApiKey> = {}): ApiKey {
  return {
    id, name: id, key_prefix: `pk_${id}`, permissions: 'scoped', scopes: ['tasks.read'], expires_at: null, disabled_at: null,
    last_used_at: null, revoked_at: null, created_by: 'me', team_member_id: 'me', created_at: hoursFromNow(-100), updated_at: hoursFromNow(-100), ...fields,
  };
}
{
  const agents = new Set(['nova']);
  const keys = [
    key('mine'),
    key('mate', { team_member_id: 'mate' }),
    key('nova-key', { team_member_id: 'nova' }),
    key('revoked', { revoked_at: hoursFromNow(-2) }),
    key('expired', { expires_at: hoursFromNow(-1) }),
    key('overlapping', { expires_at: hoursFromNow(5) }),
    key('nova-old', { team_member_id: 'nova', revoked_at: hoursFromNow(-50) }),
  ];
  const groups = groupApiKeys(keys, 'me', agents, NOW);
  check('your working keys, including one still in its rotation overlap', groups.mine.map((k) => k.id).join() === 'mine,overlapping', groups.mine.map((k) => k.id));
  check('other people\'s keys stay apart', groups.people.map((k) => k.id).join() === 'mate');
  check('agent keys point to their profile, never mixed into yours', groups.agents.map((k) => k.id).join() === 'nova-key');
  check('revoked and expired keys end up together, newest first', groups.ended.map((k) => k.id).join() === 'expired,revoked,nova-old', groups.ended.map((k) => k.id));
  check('a key past its end has ended', keyEnded(key('x', { expires_at: hoursFromNow(-0.01) }), NOW) && !keyEnded(key('y', { expires_at: hoursFromNow(1) }), NOW));
  const signedOut = groupApiKeys([key('a')], null, agents, NOW);
  check('with no member id nothing counts as yours', signedOut.mine.length === 0 && signedOut.people.length === 1);
}
{
  check('an agent key can always be revoked here, agents module on or off', agentKeyRow({ agentsOn: false, canManageAgents: false, canManageAllKeys: false }).revoke
    && agentKeyRow({ agentsOn: true, canManageAgents: true, canManageAllKeys: true }).revoke);
  check('Open Connect only with agents on, agents.manage and api_keys.manage_all held', agentKeyRow({ agentsOn: true, canManageAgents: true, canManageAllKeys: true }).openConnect
    && !agentKeyRow({ agentsOn: false, canManageAgents: true, canManageAllKeys: true }).openConnect && !agentKeyRow({ agentsOn: true, canManageAgents: false, canManageAllKeys: true }).openConnect);
  check('an Admin with agents.manage but not api_keys.manage_all is not sent to a Connect tab that shows no keys',
    !agentKeyRow({ agentsOn: true, canManageAgents: true, canManageAllKeys: false }).openConnect);
  const offGroups = groupApiKeys([key('nova-key', { team_member_id: 'nova' })], 'me', new Set(['nova']), NOW);
  check('a working key offers Pause, a paused one Resume', keyPauseAction(key('w'), NOW) === 'pause'
    && keyPauseAction(key('p', { paused_at: hoursFromNow(-1) }), NOW) === 'resume');
  check('an ended key offers neither (ending wins over a pause)', keyPauseAction(key('r', { revoked_at: hoursFromNow(-1), paused_at: hoursFromNow(-2) }), NOW) === null
    && keyPauseAction(key('e', { expires_at: hoursFromNow(-1) }), NOW) === null && keyPauseAction(key('d', { disabled_at: hoursFromNow(-1) }), NOW) === null);
  check('a one-hour AI setup key is never paused or resumed', keyPauseAction(key('s', { key_prefix: 'pk_setup_ab12' }), NOW) === null);
  check('working agent keys are listed whether or not agents are on', offGroups.agents.length === 1 && agentKeyRow({ agentsOn: false, canManageAgents: false, canManageAllKeys: false }).listed);
}
{
  check('no expiry says so quietly', keyExpiry(null, NOW).label === 'No expiry' && keyExpiry(null, NOW).tone === 'muted');
  check('past its end reads Expired', keyExpiry(hoursFromNow(-1), NOW).label === 'Expired' && keyExpiry(hoursFromNow(-1), NOW).tone === 'danger');
  check('a rotation overlap counts down in hours', keyExpiry(hoursFromNow(23.6), NOW).label === 'Ends in 24 hours' && keyExpiry(hoursFromNow(5), NOW).tone === 'warning');
  check('one hour is singular', keyExpiry(hoursFromNow(1.2), NOW).label === 'Ends in 1 hour');
  check('under an hour counts minutes', keyExpiry(hoursFromNow(0.5), NOW).label === 'Ends in 30 minutes');
  check('far off shows the date', keyExpiry('2027-03-03T00:00:00Z', NOW, () => 'Mar 3, 2027').label === 'Expires Mar 3, 2027');
}
{
  const options = rotateOverlapOptions();
  check('rotation offers stop now up to the API\'s 7 days', options.map((o) => o.value).join() === '0,1,24,72,168', options);
  check('the default is marked and is 24 hours', options.find((o) => o.value === String(ROTATE_OVERLAP_DEFAULT_HOURS))?.label === '24 hours (default)');
  check('days read as days', options.find((o) => o.value === '168')?.label === '7 days' && options.find((o) => o.value === '0')?.label === 'Stop it now');
}
{
  const groups = keyScopeGroups(['tasks.read', 'webhooks.manage', 'agent_events.export']);
  const all = groups.flatMap((g) => g.scopes.map((s) => s.key));
  check('a person may give a scope an agent never gets', all.includes('agent_events.export'), all);
  check('only what the person holds is offered', all.length === 3, all);
  check('sensitive powers say so', groups.flatMap((g) => g.scopes).find((s) => s.key === 'webhooks.manage')?.sensitive === true);
  check('scopes use plain labels, not keys', groups.flatMap((g) => g.scopes).find((s) => s.key === 'tasks.read')?.label !== 'tasks.read');
  const everything = keyScopeGroups(API_ENDPOINT_PERMISSIONS);
  const offered = new Set(everything.flatMap((g) => g.scopes.map((s) => s.key)));
  check('every API scope can be offered', API_ENDPOINT_PERMISSIONS.every((scope) => offered.has(scope)), API_ENDPOINT_PERMISSIONS.filter((scope) => !offered.has(scope)));
  check('no scope is offered twice', offered.size === everything.flatMap((g) => g.scopes).length);
  check('nothing held, nothing offered', keyScopeGroups([]).length === 0);
}

// ── Webhook endpoint form ───────────────────────────────────────────────
const draft = (fields: Partial<WebhookDraft> = {}): WebhookDraft => ({
  name: 'Finance', url: 'https://example.com/hook', description: '', events: ['invoice.paid'], amountBasis: 'gross',
  projectIds: [], memberId: '', agentEventTypes: '', ...fields,
});
{
  // An older name (assistant.message) still belongs to its group, as a legacy event the group box never adds.
  const grouped = WEBHOOK_EVENT_GROUPS.flatMap((g) => [...g.events, ...(g.legacyEvents ?? [])]);
  check('every webhook event sits in exactly one group', WEBHOOK_EVENT_TYPES.every((e) => grouped.filter((g) => g === e).length === 1) && grouped.length === WEBHOOK_EVENT_TYPES.length);
  const chatGroup = WEBHOOK_EVENT_GROUPS.find((g) => g.id === 'assistant')!;
  check('the Chat group ticks chat.message only; assistant.message shows only while an endpoint has it',
    chatGroup.events.join() === 'chat.message' && groupEventsFor(chatGroup, []).join() === 'chat.message'
      && groupEventsFor(chatGroup, ['assistant.message']).join() === 'chat.message,assistant.message', groupEventsFor(chatGroup, []));
  check('an endpoint with only the old chat name still says Chat', eventSummary(['assistant.message']).join() === 'Chat (old name)', eventSummary(['assistant.message']));
  check('every event has a plain label', WEBHOOK_EVENT_TYPES.every((e) => !!WEBHOOK_EVENT_LABELS[e]));
  check('groups read work, questions, runs, invoices, agent events, assistant chat', WEBHOOK_EVENT_GROUPS.map((g) => g.id).join() === 'work,questions,runs,invoices,agent_events,assistant');
  check('invoices are offered only with Client invoicing', !webhookEventGroups(false).some((g) => g.id === 'invoices') && webhookEventGroups(true).some((g) => g.id === 'invoices'));
}
{
  check('a name is needed', webhookStepProblem(draft({ name: '  ' }), 'endpoint') === 'Give the endpoint a name.');
  check('plain http is refused off localhost', webhookStepProblem(draft({ url: 'http://example.com' }), 'endpoint') === 'Endpoint URL must use HTTPS.');
  check('localhost is refused: webhooks go to public addresses', /public address/.test(webhookStepProblem(draft({ url: 'https://localhost:3000/hook' }), 'endpoint') ?? '')
    && webhookStepProblem(draft({ url: 'http://localhost:3000/hook' }), 'endpoint') === 'Endpoint URL must use HTTPS.');
  check('a private address is refused', /public address/.test(webhookStepProblem(draft({ url: 'https://192.168.1.20/hook' }), 'endpoint') ?? ''));
  process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS = 'true';
  check('plain http on localhost is fine where private targets are allowed', webhookStepProblem(draft({ url: 'http://localhost:3000/hook' }), 'endpoint') === null);
  delete process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS;
  check('at least one event', webhookStepProblem(draft({ events: [] }), 'events') === 'Choose at least one event.');
  check('a bad agent event type is named', webhookStepProblem(draft({ events: ['agent_event.created'], agentEventTypes: 'work.done, Bad Type' }), 'filters') === 'Bad Type is not an agent event type.');
  check('agent event types only matter with agent events', webhookStepProblem(draft({ agentEventTypes: 'Bad Type' }), 'filters') === null);
  check('Save lands on the first step with a problem', firstWebhookProblem(draft({ name: '', events: [] }))?.step === 'endpoint'
    && firstWebhookProblem(draft({ events: [] }))?.step === 'events' && firstWebhookProblem(draft()) === null);
  check('types are trimmed and deduped', parseAgentEventTypes(' work.done, usage.recorded ,work.done,, ').join() === 'work.done,usage.recorded');
}
{
  const plain = webhookFields(draft({ name: ' Finance ', url: ' https://example.com/hook ' }), false);
  check('a save trims and writes nulls for no filter', plain.name === 'Finance' && plain.url === 'https://example.com/hook' && plain.project_ids === null && plain.member_id === null);
  check('no agent events: the type column is left alone (older databases lack it)', !('agent_event_types' in plain));
  const typed = webhookFields(draft({ events: ['agent_event.created'], agentEventTypes: 'work.done', memberId: 'nova', projectIds: ['p1'] }), false);
  check('agent event types and filters are written', JSON.stringify(typed.agent_event_types) === '["work.done"]' && typed.member_id === 'nova' && typed.project_ids?.[0] === 'p1');
  check('blank types mean every type', webhookFields(draft({ events: ['agent_event.created'] }), false).agent_event_types === null);
  const cleared = webhookFields(draft(), true);
  check('dropping agent events clears types it had', 'agent_event_types' in cleared && cleared.agent_event_types === null);
}
{
  const delivery = (id: string, fields: Partial<WebhookDelivery>): WebhookDelivery => ({
    id, webhook_event_id: 'e', endpoint_id: 'ep', status: 'succeeded', attempts: 1, last_attempt_at: null, last_status_code: 200, last_error: null,
    last_response: null, delivered_at: null, next_attempt_at: NOW.toISOString(), attempt_token: null, lease_expires_at: null,
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...fields,
  });
  const ep = { id: 'ep', is_active: true, last_delivery_at: null };
  check('nothing sent yet reads idle', endpointHealth(ep, []).state === 'idle');
  check('only its own deliveries count', endpointHealth(ep, [delivery('1', { endpoint_id: 'other', status: 'failed' })]).failed === 0);
  const mixed = [delivery('1', { status: 'failed' }), delivery('2', { status: 'failed' }), delivery('3', { status: 'pending', attempts: 2 }), delivery('4', { status: 'pending', attempts: 0 })];
  const health = endpointHealth(ep, mixed);
  check('failures and retries are counted apart (queued is not retrying)', health.failed === 2 && health.retrying === 1 && health.state === 'failing', health);
  check('retrying without failures', endpointHealth(ep, [delivery('3', { status: 'pending', attempts: 2 })]).state === 'retrying');
  check('paused wins', endpointHealth({ ...ep, is_active: false }, mixed).state === 'paused');
  check('a delivered endpoint is ok', endpointHealth({ ...ep, last_delivery_at: NOW.toISOString() }, []).state === 'ok');

  // Per endpoint: health comes from the endpoint's own newest deliveries, and failing means its newest finished one failed.
  const at = (h: number) => hoursFromNow(h);
  const recovered = [
    delivery('old-fail', { status: 'failed', created_at: at(-10), last_attempt_at: at(-10) }),
    ...Array.from({ length: 10 }, (_, i) => delivery(`ok-${i}`, { status: 'succeeded', created_at: at(-9 + i * 0.5), last_attempt_at: at(-9 + i * 0.5) })),
  ];
  const healed = endpointHealth({ ...ep, last_delivery_at: at(-4) }, recovered);
  check('per endpoint: one failure then ten successes is healthy, the failure kept as a count', healed.state === 'ok' && healed.failed === 1, healed);
  const broke = [
    delivery('was-ok', { status: 'succeeded', created_at: at(-3), last_attempt_at: at(-3) }),
    delivery('now-fails', { status: 'failed', created_at: at(-2), last_attempt_at: at(-1) }),
  ];
  check('per endpoint: failing when its newest finished delivery failed', endpointHealth(ep, broke).state === 'failing');
  // A busy endpoint B fills the newest 25 across all endpoints; A's own failures are older than all of them.
  const busyB = Array.from({ length: 25 }, (_, i) => delivery(`b-${i}`, { endpoint_id: 'b', status: 'succeeded', created_at: at(-1 + i * 0.01) }));
  const aOwn = [delivery('a-fail', { status: 'failed', created_at: at(-30), last_attempt_at: at(-30) })];
  check('per endpoint: read from the newest across endpoints, a failing A looks fine', endpointHealth({ ...ep, last_delivery_at: at(-30) }, busyB).state === 'ok');
  check('per endpoint: read from its own newest, A shows failing', endpointHealth({ ...ep, last_delivery_at: at(-30) }, aOwn).state === 'failing');
  check('per endpoint: the panel reads a handful per endpoint', ENDPOINT_HEALTH_DELIVERIES >= 5 && ENDPOINT_HEALTH_DELIVERIES <= 50);

  const fmt = (iso: string | null) => (iso ? 'Nov 24, 13:00' : 'not yet');
  const waiting = delivery('w', { status: 'pending', attempts: 2, last_error: 'HTTP 500' });
  check('retries on: a waiting retry says when it goes', deliveryDetailLine(waiting, true, fmt) === 'HTTP 500, next try Nov 24, 13:00');
  check('retries off: a waiting retry says nothing sends it on its own', /retries are off/.test(deliveryDetailLine(waiting, false, fmt)) && !/next try/.test(deliveryDetailLine(waiting, false, fmt)));
}

// ── Webhook chat rules, checked before a save ─────────────────────────────
{
  const kinds: Record<string, 'person' | 'agent' | 'personal_agent'> = { olivia: 'person', nova: 'agent', ana_bot: 'personal_agent' };
  const ctx = { memberKind: (id: string) => kinds[id] ?? null };
  const chat = (fields: Partial<WebhookDraft> = {}) => draft({ events: ['chat.message'], ...fields });
  check('chat with Everyone is refused before save, naming the fix', /Chat needs one agent under Member/.test(webhookStepProblem(chat(), 'filters', ctx) ?? ''));
  check('chat to a person is refused', /Chat needs one agent/.test(webhookStepProblem(chat({ memberId: 'olivia' }), 'filters', ctx) ?? ''));
  check('chat to a company agent is fine', webhookStepProblem(chat({ memberId: 'nova' }), 'filters', ctx) === null);
  check('chat to a personal assistant is fine', webhookStepProblem(chat({ memberId: 'ana_bot' }), 'filters', ctx) === null);
  check('the old assistant.message needs a personal assistant, not a company agent',
    /person's own assistant/.test(webhookStepProblem(draft({ events: ['chat.message', 'assistant.message'], memberId: 'nova' }), 'filters', ctx) ?? '')
      && webhookStepProblem(draft({ events: ['chat.message', 'assistant.message'], memberId: 'ana_bot' }), 'filters', ctx) === null);
  check('chat with a project filter is refused (it would never send)', /never tied to a project/.test(webhookStepProblem(chat({ memberId: 'nova', projectIds: ['p1'] }), 'filters', ctx) ?? ''));
  check('a setup-scoped endpoint sends chat without a member', webhookStepProblem(chat(), 'filters', { ...ctx, setupScoped: true }) === null);
  check('a setup-scoped endpoint cannot also take a member', /cannot also be limited to one member/.test(webhookStepProblem(chat({ memberId: 'nova' }), 'filters', { ...ctx, setupScoped: true }) ?? ''));
  check('Save lands on Filters for a chat problem', firstWebhookProblem(chat(), ctx)?.step === 'filters');
  check('work events are untouched by the chat rules', webhookStepProblem(draft({ events: ['task.created'], projectIds: ['p1'] }), 'filters', ctx) === null);

  // What the database refuses, mapped to words a person can act on (never "Try again" for a rule).
  const pg = (code: string, message: string) => ({ code, message });
  check('refusal: chat.message without an agent', webhookSaveError(pg('23514', 'chat.message goes only to an endpoint filtered to an agent (member_id) or scoped to an assistant setup (assistant_setup_id)'), false).startsWith('Chat needs one agent'));
  check('refusal: assistant.message without a personal agent', /person's own assistant/.test(webhookSaveError(pg('23514', 'assistant.message goes only to an endpoint filtered to a personal agent (member_id) or scoped to an assistant setup (assistant_setup_id)'), true)));
  check('refusal: member and setup together', /cannot also be limited to one member/.test(webhookSaveError(pg('23514', 'new row for relation "webhook_endpoints" violates check constraint "webhook_endpoints_one_scope"'), true)));
  check('refusal: a setup scope by a non-Owner', /Only an Owner/.test(webhookSaveError(pg('42501', 'Only an Owner scopes an endpoint to an assistant setup'), false)));
  check('refusal: row security says permission', /permission to manage webhooks/.test(webhookSaveError(pg('42501', 'new row violates row-level security policy'), false)));
  check('refusal: another check passes its own reason through', webhookSaveError(pg('23514', 'url must be https'), false) === 'The endpoint was refused: url must be https');
  check('anything else still asks to try again', webhookSaveError(new Error('fetch failed'), false) === 'Could not create the endpoint. Try again.'
    && webhookSaveError(null, true) === 'Could not save the endpoint. Try again.');
}

// ── Rotating a person's key keeps it within the lifetime ─────────────────
{
  const made = (days: number | null) => ({ created_at: hoursFromNow(-24 * 3), expires_at: days === null ? null : hoursFromNow(-24 * 3 + days * 24) });
  const person = (old: ReturnType<typeof made>, personal: number | null, role = 'member') =>
    rotatedKeyLifetimeDays({ agent: false, old, agentLifetimeDays: 7, personalLifetimeDays: personal, granterRole: role });
  check('rotation: a 1-day key a Member rotates under a 30-day cap lasts 1 day, never no expiry', person(made(1), 30) === 1, person(made(1), 30));
  check('rotation: a 30-day key stays 30 days', person(made(30), 30) === 30);
  check('rotation: a key with no expiry made before the cap gets the cap for a Member', person(made(null), 30) === 30);
  check('rotation: a 365-day key is held to a cap set since', person(made(365), 90) === 90);
  check('rotation: no cap keeps the old key\'s length (none stays none)', person(made(null), null) === null && person(made(90), null) === 90);
  check('rotation: an Owner\'s own choice stands', person(made(null), 30, 'owner') === null && person(made(365), 30, 'owner') === 365);
  check('rotation: an agent\'s key gets the agent lifetime, whatever it had', rotatedKeyLifetimeDays({ agent: true, old: made(null), agentLifetimeDays: 7, personalLifetimeDays: 30, granterRole: 'owner' }) === 7);
  check('rotation: a key that lasted minutes gets at least an hour', (person({ created_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 60_000).toISOString() }, null) ?? 0) >= 1 / 24);
  check('capKeyLifetime: as at creation', capKeyLifetime(null, 30, 'member') === 30 && capKeyLifetime(400, 30, 'admin') === 30 && capKeyLifetime(10, 30, 'member') === 10 && capKeyLifetime(null, 30, 'owner') === null);
  check('rotation dialog: says when the new key ends', rotatedKeyExpiryLine('2026-12-24T12:00:00Z', () => 'Dec 24') === 'The new key expires Dec 24.' && rotatedKeyExpiryLine(null) === 'The new key has no expiry.');
  check('rotation dialog: before, says how long the new key lasts', /30 days/.test(rotationLifetimeNote({ created_at: hoursFromNow(-24), expires_at: hoursFromNow(24 * 29) })));
}

// ── Keys: replaced, disabled, and what a revoke takes down ───────────────
{
  const replacedIds = replacedKeyIds([key('new', { rotated_from: 'old' }), key('old'), key('gone', { rotated_from: 'older', revoked_at: hoursFromNow(-1) })]);
  check('a key a live rotation replaced is marked; one whose successor is revoked is not', replacedIds.has('old') && !replacedIds.has('older') && replacedIds.size === 1);
  check('a disabled key has ended', keyEnded({ revoked_at: null, expires_at: null, disabled_at: hoursFromNow(-1) }, NOW)
    && groupApiKeys([key('off', { disabled_at: hoursFromNow(-1) })], 'me', new Set(), NOW).ended.length === 1);
  const lk = (id: string, fields: Partial<LineageKey> = {}): LineageKey => ({ id, name: id, team_member_id: 'm', created_by_key_id: null, rotated_from: null, revoked_at: null, ...fields });
  const lineage = [
    lk('owner'), lk('jeff', { created_by_key_id: 'owner' }), lk('jeff-child', { created_by_key_id: 'jeff' }),
    lk('dead', { created_by_key_id: 'owner', revoked_at: hoursFromNow(-1) }), lk('dead-child', { created_by_key_id: 'dead' }),
    lk('owner-v2', { rotated_from: 'owner' }), lk('other'),
  ];
  const tree = keyTreeOf(lineage, 'owner').map((k) => k.id);
  check('revoke preview: every live key it made, however deep, and under a revoked one too', tree.join() === 'jeff,jeff-child,dead-child', tree);
  check('revoke preview: revoking a rotated key reaches the key it replaced and what that made', keyTreeOf(lineage, 'owner-v2').map((k) => k.id).join() === 'owner,jeff,jeff-child,dead-child');
  check('revoke preview: nothing else', keyTreeOf(lineage, 'other').length === 0);
}

// ── Keeping data: shortening a period asks, with a count and a time ──────
{
  const saved = { webhook_retention_days: 30, agent_run_retention_days: null, chat_retention_days: 90 } as Record<string, number | null>;
  const keys = ['webhook_retention_days', 'agent_run_retention_days', 'chat_retention_days'];
  check('retention: forever to 30 days and 90 to 30 are shorter; 30 to 90 is not', shortenedRetention(saved, { agent_run_retention_days: 30, chat_retention_days: 30, webhook_retention_days: 90 }, keys).join() === 'agent_run_retention_days,chat_retention_days');
  check('retention: to forever is never shorter', shortenedRetention(saved, { webhook_retention_days: null }, keys).length === 0);
  check('retention: unchanged settings never ask', shortenedRetention(saved, {}, keys).length === 0);
  const message = retentionConfirmMessage([
    { label: 'Agent runs', days: 30, rows: 1240 },
    { label: 'Chat message text', days: 30, rows: 1, unit: 'texts' },
  ], 'Thu 8:47 PM');
  check('retention confirm: names each setting with about how many rows', /Agent runs: removes about 1,240 rows older than 30 days\./.test(message)
    && /Chat message text: blanks about 1 message text older than 30 days\./.test(message), message);
  check('retention confirm: says when and that it cannot be undone', /next daily cleanup, Thu 8:47 PM, and cannot be undone\./.test(message));
  check('retention confirm: without a count it still warns', /removes older rows older than 90 days/.test(retentionConfirmMessage([{ label: 'Audit log', days: 90, rows: null }], 'soon')));
  check('retention confirm: no rows yet says so', rowsInWords(0) === 'no rows yet');
  const next = nextDailyRun(DATA_RETENTION_RUN_UTC, new Date('2026-11-24T03:50:00Z'));
  check('retention: the next cleanup is the next 03:47 UTC', next.toISOString() === '2026-11-25T03:47:00.000Z' && nextDailyRun(DATA_RETENTION_RUN_UTC, new Date('2026-11-24T01:00:00Z')).toISOString() === '2026-11-24T03:47:00.000Z');
}

// ── Roles & permissions: only what the server honours ────────────────────
{
  const offered = (channel: 'app' | 'api', role: 'admin' | 'member' | 'agent') =>
    PERMISSIONS.filter((key) => permissionOffered(key, channel, role, NEVER_AGENT_SCOPES));
  const appAdmin = offered('app', 'admin');
  check('App hides key-only permissions', !appAdmin.includes('chat.notify') && !appAdmin.includes('context.memory') && !appAdmin.includes('agents.act_for')
    && !appAdmin.includes('assistants.provision') && !appAdmin.includes('identities.link') && !appAdmin.includes('identities.read') && !appAdmin.includes('approvals.decide'), appAdmin.filter((k) => KEY_ONLY_PERMISSIONS.has(k)));
  check('App still offers what the app checks', ['tasks.read', 'webhooks.manage', 'audit.read', 'invoices.record_payments'].every((k) => appAdmin.includes(k as never)));
  // Manage access is enforced (the access route honours it), so an Owner can give it on App; it is never a key scope.
  check('Manage access is offered on App only', appAdmin.includes('access.manage') && !offered('api', 'admin').includes('access.manage'));
  check('Send notifications is a key scope: not on App', !appAdmin.includes('notifications.send') && offered('api', 'admin').includes('notifications.send'));
  check('the Agent role has no App tab', accessChannelsFor('agent').join() === 'api' && offered('app', 'agent').length === 0 && accessChannelsFor('member').join() === 'app,api');
  const apiAgent = offered('api', 'agent');
  check('the Agent role is never offered what agents cannot use', !apiAgent.includes('context.memory') && NEVER_AGENT_SCOPES.every((k) => !apiAgent.includes(k)) && apiAgent.includes('tasks.read'));
  check('people still get memory on API', offered('api', 'member').includes('context.memory'));
  check('every key-only permission is an API scope (so it shows somewhere)', [...KEY_ONLY_PERMISSIONS].every((k) => API_ENDPOINT_PERMISSIONS.includes(k as never)));
  check('the App channel set leaves out exactly the key-only and unoffered ones', APP_CHANNEL_PERMISSIONS.size === PERMISSIONS.length - KEY_ONLY_PERMISSIONS.size - UNOFFERED_PERMISSIONS.size);
  check('scope labels read in plain words', permissionLabel('approvals.decide') === 'Decide approvals over the API' && permissionLabel('custom.unknown') === 'custom.unknown'
    && permissionLabels(['webhooks.manage', 'tasks.create']) === 'Manage webhooks, Create tasks');
  const words = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.description));
  check('descriptions never name endpoints or headers', words.every((d) => !/\/api\/|X-Act-For|GET |cursor/.test(d)), words.filter((d) => /\/api\/|X-Act-For|GET |cursor/.test(d)));
}

// ── Audit log export ─────────────────────────────────────────────────────
{
  const entry = { id: '1', timestamp: '2026-11-24T12:00:00Z', method: 'PATCH', endpoint: '/api/v1/tasks/1', entity_type: 'task', entity_id: 't1', team_member_id: 'o', principal_id: null,
    api_key_id: null, via: 'app' as const, status_code: 200, error: null, request_body: { title: 'Say "hi", then =SUM(A1)' }, before_snapshot: null, after_snapshot: null };
  const csv = auditCsv([entry, { ...entry, id: '2', error: '=cmd' }], { o: 'Olivia' });
  const lines = csv.trim().split('\r\n');
  check('audit CSV: a header and one line per row, with names', lines.length === 3 && lines[0].startsWith('timestamp,who,') && lines[1].includes(',Olivia,'));
  check('audit CSV: JSON cells are quoted and their quotes doubled', lines[1].includes(',"{""title"":""Say '), lines[1]);
  check('audit CSV: a cell that starts like a formula is neutralised', lines[2].includes(",'=cmd,"), lines[2]);
  const tabbed = auditCsv([{ ...entry, id: '3', error: '\t=cmd' }], { o: 'Olivia' }).trim().split('\r\n')[1];
  check('audit CSV: a cell that starts with a tab is neutralised too', tabbed.includes(",'\t=cmd,"), tabbed);
}
{
  check('a whole group reads as its name', eventSummary(['question.asked', 'question.answered', 'question.cancelled', 'question.expired']).join() === 'Questions');
  check('part of a group says how much', eventSummary(['task.created', 'task.updated']).join() === 'Work: 2 of 13');
  check('groups read in order', eventSummary(['invoice.paid', 'run.started', 'run.updated', 'run.finished', 'agent.offline', 'agent.online', 'agent.paused', 'agent.resumed', 'budget.exceeded']).join('|') === 'Agents|Invoices: 1 of 5');
  check('an unknown event still shows by name', eventSummary(['task.created', 'custom.thing']).join('|') === 'Work: 1 of 13|custom.thing');
}

{
  const unset = agentKeyLifetimeSettingOptions(null);
  check('agent key lifetime: nothing set reads as the 90-day default, never "No expiry"', unset[0].label === '90 days (default)' && !unset.some((o) => /no expiry/i.test(o.label)), unset);
  check('agent key lifetime: 90 days is not offered twice', unset.filter((o) => o.label.startsWith('90 days')).length === 1, unset);
  check('agent key lifetime: a saved odd lifetime stays choosable', agentKeyLifetimeSettingOptions(45).some((o) => o.value === '45'));
}

{
  // P1: your own keys in your own area, everyone else's in Developers, which is for Owners, key managers and webhook managers.
  const keys = [key('mine'), key('mate', { team_member_id: 'mate' }), key('nova-key', { team_member_id: 'nova' }), key('old', { revoked_at: hoursFromNow(-2) })];
  check('your own area lists only your keys, ended ones too', keysInScope(keys, 'mine', 'me').map((k) => k.id).join() === 'mine,old', keysInScope(keys, 'mine', 'me').map((k) => k.id));
  check('Developers lists everyone else\'s, people and agents', keysInScope(keys, 'workspace', 'me').map((k) => k.id).join() === 'mate,nova-key');
  check('signed out, nothing is yours', keysInScope(keys, 'mine', null).length === 0);
  const member = { isOwner: false, isGuest: false, canManageAllKeys: false, holdsWebhooks: false };
  check('a member without key or webhook management does not see Developers', !seesDevelopers(member));
  check('an Owner, a key manager and a webhook manager see Developers', seesDevelopers({ ...member, isOwner: true })
    && seesDevelopers({ ...member, canManageAllKeys: true }) && seesDevelopers({ ...member, holdsWebhooks: true }));
  check('a guest never sees Developers', !seesDevelopers({ ...member, isGuest: true, canManageAllKeys: true }));
}

{
  check('own keys: in the AI area while AI agents is on', !ownKeysInSettings({ agentsOn: true, isGuest: false, isDemoMode: false }));
  check('own keys: in Settings > Developers for every member while AI agents is off (the AI area is closed)', ownKeysInSettings({ agentsOn: false, isGuest: false, isDemoMode: false }));
  check('own keys: never for a guest or in the demo', !ownKeysInSettings({ agentsOn: false, isGuest: true, isDemoMode: false }) && !ownKeysInSettings({ agentsOn: false, isGuest: false, isDemoMode: true }));
}

if (failures.length) {
  console.error(`developers-settings: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`developers-settings: ${passed} checks passed`);
