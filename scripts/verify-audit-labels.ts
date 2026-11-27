/**
 * Settings > Security > Audit log in plain words (src/lib/audit-log.ts):
 * each audited action reads as what happened, with names a person knows
 * ("Removed Sam from Design", "Gave Alexa access to Website relaunch"), never
 * a verb and an entity type; the details name what changed instead of
 * showing raw ids. Pure logic; nothing touches a database.
 *
 *   npm run -s test:audit-labels
 */
import { NO_AUDIT_FILTERS, auditActionLabel, auditDetails, auditFilterCount, auditReferencedIds, type AuditEntry } from '@/lib/audit-log';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const SAM = '11111111-1111-4111-8111-111111111111';
const DESIGN = '22222222-2222-4222-8222-222222222222';
const ALEXA = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';
const TASK = '55555555-5555-4555-8555-555555555555';
const KEY = '66666666-6666-4666-8666-666666666666';
const GONE = '77777777-7777-4777-8777-777777777777';
const names: Record<string, string> = {
  [SAM]: 'Sam', [DESIGN]: 'Design', [ALEXA]: 'Alexa', [SITE]: 'Website relaunch', [TASK]: 'Fix the login', [KEY]: 'Deploy key',
};

const row = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 'r', timestamp: '2026-11-26T12:00:00Z', method: 'POST', endpoint: '/api/v1/tasks', entity_type: null, entity_id: null,
  team_member_id: null, principal_id: null, api_key_id: null, via: 'rest', status_code: 200, error: null,
  request_body: null, before_snapshot: null, after_snapshot: null, ...over,
});
const label = (over: Partial<AuditEntry>) => auditActionLabel(row(over), names);

// The cases from the break-it report.
check('removing a member from a group', label({ method: 'DELETE', endpoint: `/api/v1/groups/${DESIGN}/members/${SAM}`, entity_type: 'group', entity_id: DESIGN, after_snapshot: { removed: SAM } }) === 'Removed Sam from Design');
check('adding members to a group', label({ method: 'POST', endpoint: `/api/v1/groups/${DESIGN}/members`, entity_type: 'group', entity_id: DESIGN, request_body: { member_ids: [SAM, ALEXA] } }) === 'Added Sam and Alexa to Design');
check('a member\'s role in a group', label({ method: 'PATCH', endpoint: `/api/v1/groups/${DESIGN}/members/${SAM}`, entity_type: 'group', entity_id: DESIGN, request_body: { role: 'lead' } }) === "Changed Sam's role in Design");
check('delegating a task', label({ method: 'POST', endpoint: `/api/v1/tasks/${TASK}/delegate`, entity_type: 'task', entity_id: TASK, request_body: { agent_id: ALEXA } }) === 'Delegated Fix the login to Alexa');
check('setting a task repeat names how often', label({ method: 'PUT', endpoint: `/api/v1/tasks/${TASK}/repeat`, entity_type: 'schedule', entity_id: GONE, request_body: { recurrence: { freq: 'weekly', interval: 1, weekdays: [1] } } }) === 'Set Fix the login to repeat every Monday',
  label({ method: 'PUT', endpoint: `/api/v1/tasks/${TASK}/repeat`, entity_type: 'schedule', entity_id: GONE, request_body: { recurrence: { freq: 'weekly', interval: 1, weekdays: [1] } } }));
check('stopping a repeat', label({ method: 'DELETE', endpoint: `/api/v1/tasks/${TASK}/repeat`, entity_type: 'schedule', entity_id: TASK }) === 'Stopped Fix the login repeating');
check('giving an agent a project', label({ method: 'PUT', endpoint: `/api/v1/projects/${SITE}/agents/${ALEXA}`, entity_type: 'project_agent', entity_id: ALEXA }) === 'Gave Alexa access to Website relaunch');
check('taking an agent off a project', label({ method: 'DELETE', endpoint: `/api/v1/projects/${SITE}/agents/${ALEXA}`, entity_type: 'project_agent', entity_id: ALEXA }) === 'Removed Alexa from Website relaunch');
check('pausing a key', label({ method: 'POST', endpoint: `/api/workspace/api-keys/${KEY}/pause`, entity_type: 'api_key', entity_id: KEY }) === 'Paused key Deploy key');

// Changes the database audits from the app (/app/<table>/<id>).
check('app: a key paused', label({ method: 'PATCH', endpoint: `/app/api_keys/${KEY}`, entity_type: 'api_key', entity_id: KEY, via: 'app', before_snapshot: { paused_at: null }, after_snapshot: { paused_at: '2026-11-26T12:00:00Z' } }) === 'Paused key Deploy key');
check('app: a key resumed', label({ method: 'PATCH', endpoint: `/app/api_keys/${KEY}`, entity_type: 'api_key', entity_id: KEY, via: 'app', before_snapshot: { paused_at: '2026-11-26T12:00:00Z' }, after_snapshot: { paused_at: null } }) === 'Resumed key Deploy key');
check('app: a member suspended', label({ method: 'PATCH', endpoint: `/app/team_members/${SAM}`, entity_type: 'team_member', entity_id: SAM, via: 'app', before_snapshot: { status: 'active' }, after_snapshot: { status: 'suspended' } }) === 'Suspended Sam');
check('app: an owner added to an agent', label({ method: 'POST', endpoint: `/app/agent_owners/${ALEXA}`, entity_type: 'agent_owner', entity_id: ALEXA, via: 'app', after_snapshot: { agent_id: ALEXA, member_id: SAM } }) === 'Made Sam an owner of Alexa');

// Anything without its own wording: a verb, what, and its name; never an id.
check('generic: a created task names it', label({ method: 'POST', endpoint: '/api/v1/tasks', entity_type: 'task', entity_id: TASK }) === 'Created task Fix the login');
check('generic: an action word at the end of the path', label({ method: 'POST', endpoint: `/api/v1/projects/${SITE}/archive`, entity_type: 'project', entity_id: SITE }) === 'Archived project Website relaunch');
check('generic: a name from the snapshot when the server had none', label({ method: 'PATCH', endpoint: `/api/v1/leads/${GONE}`, entity_type: 'lead', entity_id: GONE, before_snapshot: { id: GONE, name: 'Acme' }, after_snapshot: { id: GONE, name: 'Acme Inc' } }) === 'Changed lead Acme Inc');
const unknown = label({ method: 'DELETE', endpoint: `/api/v1/groups/${GONE}/members/${GONE}`, entity_type: 'group', entity_id: GONE });
check('an id nobody can name never shows', !unknown.includes(GONE) && unknown === 'Removed someone from a group', unknown);

// Details: names, not ids; changes as "from to"; quiet fields left out.
const removed = auditDetails(row({ method: 'DELETE', endpoint: `/api/v1/groups/${DESIGN}/members/${SAM}`, after_snapshot: { removed: SAM } }), names);
check('details: a removal names who', removed.length === 1 && removed[0].label === 'Removed' && removed[0].value === 'Sam', removed);
const change = auditDetails(row({ method: 'PATCH', before_snapshot: { id: TASK, status: 'todo', assignee_ids: [SAM], updated_at: 'a' }, after_snapshot: { id: TASK, status: 'done', assignee_ids: [ALEXA], updated_at: 'b' } }), names);
check('details: changed fields in plain words, ids as names, timestamps left out',
  JSON.stringify(change) === JSON.stringify([{ label: 'Status', value: 'todo to done' }, { label: 'Assignees', value: 'Sam to Alexa' }]), change);
const sent = auditDetails(row({ request_body: { recurrence: { freq: 'daily', interval: 2 }, notify: true, agent_id: GONE } }), names);
check('details: a recurrence in words, Yes or No, a record no longer here', JSON.stringify(sent) === JSON.stringify([
  { label: 'Recurrence', value: 'Every 2 days' }, { label: 'Notify', value: 'Yes' }, { label: 'Agent', value: 'a record no longer here' },
]), sent);
check('details: at most 12 lines', auditDetails(row({ request_body: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field_${i}`, i])) })).length === 12);

// The ids the server resolves to names.
const ids = auditReferencedIds(row({ endpoint: `/api/v1/groups/${DESIGN}/members/${SAM}`, entity_id: DESIGN, request_body: { member_ids: [ALEXA] }, after_snapshot: { id: KEY, project_id: SITE } }));
check('referenced ids: entity, path, body lists and snapshot fields (not the row\'s own id)', [DESIGN, SAM, ALEXA, SITE].every((id) => ids.includes(id)) && !ids.includes(KEY), ids);

// The Filter button's count: who, acting for, action and the date range, each once.
check('no filters count zero', auditFilterCount(NO_AUDIT_FILTERS) === 0);
check('a from and a to are one date range', auditFilterCount({ ...NO_AUDIT_FILTERS, from: '2026-11-01', to: '2026-11-27' }) === 1);
check('spaces alone are no action filter', auditFilterCount({ ...NO_AUDIT_FILTERS, action: '  ' }) === 0);
check('every filter on counts four', auditFilterCount({ member: 'a', actingFor: 'b', action: 'PATCH', from: '2026-11-01', to: null }) === 4);

if (failures.length) {
  console.error(`audit labels: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`audit labels: ${passed} checks passed`);
