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
  agentKeyRow, endpointHealth, eventSummary, firstWebhookProblem, groupApiKeys, keyEnded, keyExpiry, keyScopeGroups, parseAgentEventTypes,
  rotateOverlapOptions, webhookEventGroups, webhookFields, webhooksSectionState, webhookStepProblem, ROTATE_OVERLAP_DEFAULT_HOURS,
  WEBHOOK_EVENT_GROUPS, WEBHOOK_EVENT_LABELS, type WebhookDraft,
} from '@/lib/developers-settings';
import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
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
  check('an agent key can always be revoked here, agents module on or off', agentKeyRow({ agentsOn: false, canManageAgents: false }).revoke
    && agentKeyRow({ agentsOn: true, canManageAgents: true }).revoke);
  check('Open Connect only with agents on and agents.manage held', agentKeyRow({ agentsOn: true, canManageAgents: true }).openConnect
    && !agentKeyRow({ agentsOn: false, canManageAgents: true }).openConnect && !agentKeyRow({ agentsOn: true, canManageAgents: false }).openConnect);
  const offGroups = groupApiKeys([key('nova-key', { team_member_id: 'nova' })], 'me', new Set(['nova']), NOW);
  check('working agent keys are listed whether or not agents are on', offGroups.agents.length === 1 && agentKeyRow({ agentsOn: false, canManageAgents: false }).listed);
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
  const grouped = WEBHOOK_EVENT_GROUPS.flatMap((g) => g.events);
  check('every webhook event sits in exactly one group', WEBHOOK_EVENT_TYPES.every((e) => grouped.filter((g) => g === e).length === 1) && grouped.length === WEBHOOK_EVENT_TYPES.length);
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
}
{
  check('a whole group reads as its name', eventSummary(['question.asked', 'question.answered', 'question.cancelled', 'question.expired']).join() === 'Questions');
  check('part of a group says how much', eventSummary(['task.created', 'task.updated']).join() === 'Work: 2 of 13');
  check('groups read in order', eventSummary(['invoice.paid', 'run.started', 'run.updated', 'run.finished', 'agent.offline', 'agent.online', 'agent.paused', 'agent.resumed', 'budget.exceeded']).join('|') === 'Agents|Invoices: 1 of 5');
  check('an unknown event still shows by name', eventSummary(['task.created', 'custom.thing']).join('|') === 'Work: 1 of 13|custom.thing');
}

if (failures.length) {
  console.error(`developers-settings: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`developers-settings: ${passed} checks passed`);
