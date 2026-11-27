import { z } from 'zod';
import { describeRecurrence, type Recurrence } from '@/lib/schedules';
import { permissionLabel } from '@/lib/access-control';

/**
 * The audit log as Settings > Security reads it, and the settings around it.
 * Shared by the session routes and the screens.
 */

/** How long rows are kept: null keeps them forever (the default). */
export const AUDIT_RETENTION_MIN_DAYS = 30;
export const AUDIT_RETENTION_MAX_DAYS = 3650;
export const AUDIT_RETENTION_CHOICES: { value: number | null; label: string }[] = [
  { value: null, label: 'Keep forever' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' },
  { value: 2555, label: '7 years' },
];

const REDACT_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

export const auditSettingsSchema = z.object({
  retention_days: z.number().int().min(AUDIT_RETENTION_MIN_DAYS, `Keep rows at least ${AUDIT_RETENTION_MIN_DAYS} days`).max(AUDIT_RETENTION_MAX_DAYS).nullable().optional(),
  redact_keys: z.array(z.string().trim().regex(REDACT_KEY, 'A field name is letters, numbers, dots, dashes or underscores, 64 at most')).max(100).optional(),
}).strict().refine((body) => body.retention_days !== undefined || body.redact_keys !== undefined, 'Send retention_days or redact_keys');
export type AuditSettingsPatch = z.infer<typeof auditSettingsSchema>;

export interface AuditSettings {
  retention_days: number | null;
  redact_keys: string[];
}

export const agentsPauseSchema = z.object({ paused: z.boolean() }).strict();

export interface AgentsPauseState {
  paused_at: string | null;
  paused_by: { id: string; name: string } | null;
}

export const AUDIT_PAGE_SIZE = 50;

export interface AuditEntry {
  id: string;
  timestamp: string;
  method: string;
  endpoint: string;
  entity_type: string | null;
  entity_id: string | null;
  team_member_id: string | null;
  principal_id: string | null;
  api_key_id: string | null;
  via: 'rest' | 'mcp' | 'app' | 'mcp_oauth';
  status_code: number;
  error: string | null;
  request_body: unknown;
  before_snapshot: unknown;
  after_snapshot: unknown;
}

export interface AuditFilters {
  /** Who did it (team_member_id). */
  member: string | null;
  /** Who it was done for (principal_id). */
  actingFor: string | null;
  /** Text in the action (method, endpoint or entity type). */
  action: string;
  /** YYYY-MM-DD, inclusive. */
  from: string | null;
  to: string | null;
}

export const NO_AUDIT_FILTERS: AuditFilters = { member: null, actingFor: null, action: '', from: null, to: null };

/** How many filters are on, for the Filter button: each of who, acting for, action and the date range counts once. */
export function auditFilterCount(filters: AuditFilters): number {
  return [filters.member, filters.actingFor, filters.action.trim(), filters.from || filters.to].filter(Boolean).length;
}

/** The start of a local day (YYYY-MM-DD in this browser's time zone) as an ISO time. */
export function localDayStart(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toISOString();
}

/**
 * The query string for /api/workspace/audit-log. Days are the viewer's own:
 * from is the start of that local day, to the start of the local day after
 * (exclusive), sent as ISO times, so a row dated today in the list is in a
 * filter for today.
 */
export function auditQuery(filters: AuditFilters, page: number, before?: AuditEntry): string {
  const params = new URLSearchParams();
  if (filters.member) params.set('member', filters.member);
  if (filters.actingFor) params.set('acting_for', filters.actingFor);
  if (filters.action.trim()) params.set('action', filters.action.trim());
  if (filters.from) params.set('from', localDayStart(filters.from));
  if (filters.to) {
    const [year, month, date] = filters.to.split('-').map(Number);
    params.set('to', new Date(year, month - 1, date + 1).toISOString());
  }
  if (before) params.set('before', `${before.timestamp}|${before.id}`);
  else if (page > 0) params.set('page', String(page));
  return params.toString();
}

const CSV_COLUMNS = ['timestamp', 'who', 'acting_for', 'via', 'method', 'endpoint', 'entity_type', 'entity_id', 'status_code', 'error', 'request_body', 'before', 'after'] as const;

/** One CSV cell: quoted when it holds a comma, quote or line break; objects as JSON; a leading = + - @, tab or carriage return neutralised for spreadsheets. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Audit rows as CSV, with names for who did it and who it was for. */
export function auditCsv(entries: readonly AuditEntry[], names: Record<string, string>): string {
  const name = (id: string | null) => (id ? names[id] ?? id : '');
  const rows = entries.map((entry) => [
    entry.timestamp, name(entry.team_member_id), name(entry.principal_id), entry.via, entry.method, entry.endpoint, entry.entity_type,
    entry.entity_id, entry.status_code, entry.error, entry.request_body, entry.before_snapshot, entry.after_snapshot,
  ].map(csvCell).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

// ── Plain labels ────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The path after /api/v1 or /api/workspace, without a query, as segments. */
function pathOf(endpoint: string): string[] {
  return endpoint.split('?')[0].replace(/^\/api\/(v1|workspace)\//, '').split('/').filter(Boolean);
}

/**
 * Every id a row names that a person would know by name: the entity, ids in
 * the path, and ids in what was sent and the snapshots (one level deep, and
 * lists of ids). The server resolves these to names for the screen.
 */
export function auditReferencedIds(entry: Pick<AuditEntry, 'endpoint' | 'entity_id' | 'request_body' | 'before_snapshot' | 'after_snapshot'>): string[] {
  const ids = new Set<string>();
  if (isId(entry.entity_id)) ids.add(entry.entity_id);
  for (const segment of pathOf(entry.endpoint)) if (isId(segment)) ids.add(segment);
  for (const source of [entry.request_body, entry.before_snapshot, entry.after_snapshot]) {
    const record = asRecord(source);
    if (!record) continue;
    for (const [key, value] of Object.entries(record)) {
      if (key === 'id') continue;
      if (isId(value)) ids.add(value);
      else if (Array.isArray(value)) for (const item of value.slice(0, 50)) if (isId(item)) ids.add(item);
    }
  }
  return [...ids];
}

type LabelEntry = Pick<AuditEntry, 'method' | 'endpoint' | 'entity_type' | 'entity_id'> & Partial<Pick<AuditEntry, 'request_body' | 'before_snapshot' | 'after_snapshot'>>;

/** A row's names: what the server resolved, else what a snapshot of that record carries. */
function namer(entry: LabelEntry, names: Record<string, string>) {
  const fromSnapshots = new Map<string, string>();
  for (const source of [entry.before_snapshot, entry.after_snapshot]) {
    const record = asRecord(source);
    const label = record && (typeof record.name === 'string' ? record.name : typeof record.title === 'string' ? record.title : null);
    if (record && isId(record.id) && label) fromSnapshots.set(record.id, label);
  }
  return (id: unknown, fallback: string): string => {
    if (typeof id !== 'string') return fallback;
    return names[id] ?? fromSnapshots.get(id) ?? fallback;
  };
}

const joinNames = (list: string[]) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`);

/** Words for an entity type ("project_agent" reads "agent access"). */
const ENTITY_WORDS: Record<string, string> = {
  project_agent: 'agent access', team_member: 'member', api_key: 'key', task_template: 'template', webhook_endpoint: 'webhook',
  schedule: 'repeat', inbound_email: 'email', time_entry: 'time entry', task_suggestion: 'suggestion',
};
const entityWord = (type: string | null, fallback: string) => (type ? ENTITY_WORDS[type] ?? type.replace(/_/g, ' ') : fallback.replace(/[-_]/g, ' '));

/** A last path word that names the action ("/archive", "/revoke"). */
const ACTION_WORDS: Record<string, string> = {
  archive: 'Archived', approve: 'Approved', reject: 'Rejected', decline: 'Declined', answer: 'Answered', cancel: 'Cancelled',
  revoke: 'Revoked', rotate: 'Rotated', pause: 'Paused', resume: 'Resumed', stop: 'Stopped', convert: 'Converted', run: 'Ran',
  restore: 'Restored', move: 'Moved', reply: 'Replied to', finish: 'Finished', claim: 'Claimed', reveal: 'Revealed',
  reorder: 'Reordered', reflow: 'Moved the dates of', triage: 'Sorted', review: 'Reviewed', 'request-info': 'Asked for more on',
};

const VERBS: Record<string, string> = { POST: 'Created', PUT: 'Set', PATCH: 'Changed', DELETE: 'Removed', GET: 'Read' };

/** "Every Monday" from a recurrence-shaped value, else null. */
function recurrenceWords(value: unknown): string | null {
  const rule = asRecord(value);
  if (!rule || !['daily', 'weekly', 'monthly'].includes(String(rule.freq))) return null;
  try {
    return describeRecurrence(rule as unknown as Recurrence);
  } catch {
    return null;
  }
}

/**
 * The action in plain words, with the names a person knows ("Removed Sam
 * from Design", "Gave Alexa access to Website relaunch", "Delegated Fix the
 * login to Forge", "Set Weekly report to repeat every Monday"). Names come
 * from `names` (resolved by the server) or a snapshot; an id never shows.
 * Anything without its own wording reads "<verb> <what> <name>".
 */
export function auditActionLabel(entry: LabelEntry, names: Record<string, string> = {}): string {
  const name = namer(entry, names);
  const body = asRecord(entry.request_body) ?? {};
  const seg = pathOf(entry.endpoint);
  const [root, id, sub, subId, last] = [seg[0], seg[1], seg[2], seg[3], seg[seg.length - 1]];
  const m = entry.method;

  // A change made in the app, which the database audits itself: /app/<table>/<id>.
  if (root === 'app') {
    const app = appChangeLabel(entry, seg[1], name);
    if (app) return app;
  }

  if (root === 'groups' && sub === 'members') {
    const group = name(id, 'a group');
    if (m === 'POST') {
      const people = Array.isArray(body.member_ids) ? body.member_ids.map((x) => name(x, 'someone')) : [];
      return `Added ${people.length ? joinNames(people) : 'people'} to ${group}`;
    }
    if (m === 'DELETE') return `Removed ${name(subId, 'someone')} from ${group}`;
    if (m === 'PATCH') return `Changed ${name(subId, 'someone')}'s role in ${group}`;
  }
  if (root === 'projects' && sub === 'agents' && subId) {
    const agent = name(subId, 'an agent');
    const project = name(id, 'a project');
    if (m === 'PUT' || m === 'POST') return `Gave ${agent} access to ${project}`;
    if (m === 'DELETE') return `Removed ${agent} from ${project}`;
  }
  if (root === 'agents' && sub === 'projects' && (m === 'PUT' || m === 'POST')) {
    const projects = Array.isArray(body.project_ids) ? body.project_ids.map((x) => name(x, 'a project')) : [];
    return `Gave ${name(id, 'an agent')} access to ${projects.length ? joinNames(projects) : 'projects'}`;
  }
  if (root === 'tasks' && sub === 'delegate') {
    return `Delegated ${name(id, 'a task')} to ${name(body.agent_id, 'an agent')}`;
  }
  if (root === 'tasks' && sub === 'repeat') {
    const task = name(id, 'a task');
    if (m === 'DELETE') return `Stopped ${task} repeating`;
    const words = recurrenceWords(body.recurrence);
    return words ? `Set ${task} to repeat ${words.charAt(0).toLowerCase()}${words.slice(1)}` : `Set ${task} to repeat`;
  }
  if (root === 'agents' && sub === 'keys' && last === 'revoke') {
    return `Revoked ${name(id, 'an agent')}'s key ${name(subId, '')}`.trim();
  }
  if ((root === 'api-keys') && id && ACTION_WORDS[last] && last !== id) {
    return `${ACTION_WORDS[last]} key ${name(id, '')}`.trim();
  }
  if ((root === 'team-members' || root === 'members') && id && m === 'PATCH') {
    const person = name(id, 'a member');
    if (body.status === 'suspended') return `Suspended ${person}`;
    if (body.status === 'active') return `Reactivated ${person}`;
    if (typeof body.role === 'string') return `Made ${person} ${body.role === 'admin' ? 'an' : 'a'} ${body.role}`;
    return `Changed ${person}`;
  }

  // Generic: an action word at the end of the path, else the method's verb.
  const what = entityWord(entry.entity_type, root ?? 'item');
  const subject = name(entry.entity_id ?? id, '');
  const action = seg.length > 1 && !isId(last) ? ACTION_WORDS[last] : undefined;
  const verb = action ?? VERBS[m] ?? m;
  return [verb, what, subject].filter(Boolean).join(' ');
}

/** A change the database audited from the app (pm.audit_app_change), in words; null for the generic label. */
function appChangeLabel(entry: LabelEntry, table: string | undefined, name: (id: unknown, fallback: string) => string): string | null {
  const before = asRecord(entry.before_snapshot) ?? {};
  const after = asRecord(entry.after_snapshot) ?? {};
  const row = { ...before, ...after };
  const m = entry.method;
  const became = (key: string) => key in after && !(after[key] === null || after[key] === undefined) && (before[key] === null || before[key] === undefined);
  const cleared = (key: string) => key in after && (after[key] === null || after[key] === undefined) && before[key] !== null && before[key] !== undefined;
  switch (table) {
    case 'api_keys': {
      const key = `key ${typeof row.name === 'string' ? row.name : name(entry.entity_id, '')}`.trim();
      if (m === 'POST') return `Created ${key}`;
      if (m === 'DELETE') return `Removed ${key}`;
      if (became('revoked_at')) return `Revoked ${key}`;
      if (became('paused_at')) return `Paused ${key}`;
      if (cleared('paused_at')) return `Resumed ${key}`;
      if ('scopes' in after) return `Changed what ${key} may do`;
      if ('name' in after) return `Renamed key ${valueWords(before.name, name)} to ${valueWords(after.name, name)}`;
      return `Changed ${key}`;
    }
    case 'team_members': {
      const person = typeof row.name === 'string' ? row.name : name(entry.entity_id, 'a member');
      if (m === 'POST') return `Added ${person} to the team`;
      if (after.status === 'suspended') return `Suspended ${person}`;
      if (after.status === 'active' && before.status === 'suspended') return `Reactivated ${person}`;
      if (typeof after.role === 'string') return `Made ${person} ${after.role === 'admin' || after.role === 'owner' || after.role === 'agent' ? 'an' : 'a'} ${after.role}`;
      if (became('agent_paused_at')) return `Paused ${person}`;
      if (cleared('agent_paused_at')) return `Resumed ${person}`;
      return `Changed ${person}`;
    }
    case 'agent_owners': {
      const person = name(row.member_id, 'someone');
      const agent = name(row.agent_id, 'an agent');
      return m === 'DELETE' ? `Removed ${person} as an owner of ${agent}` : `Made ${person} an owner of ${agent}`;
    }
    case 'team_member_permissions': {
      const person = name(row.member_id, 'someone');
      const what = typeof row.permission_key === 'string' ? permissionLabel(row.permission_key) : 'a permission';
      if (m === 'DELETE') return `Reset ${person}'s permission: ${what}`;
      return row.effect === 'deny' ? `Took "${what}" away from ${person}` : `Gave ${person} "${what}"`;
    }
    case 'role_permissions': {
      const what = typeof row.permission_key === 'string' ? permissionLabel(row.permission_key) : 'a permission';
      return `Changed what ${typeof row.role === 'string' ? `${row.role}s` : 'a role'} may do: ${what}`;
    }
    case 'workspace_modules':
      return typeof after.enabled === 'boolean' ? `Turned ${after.enabled ? 'on' : 'off'} ${String(row.module_id ?? row.id ?? 'a module').replace(/_/g, ' ')}` : null;
    case 'business_settings': return 'Changed workspace settings';
    case 'agent_limits': return `Changed ${name(row.agent_id ?? entry.entity_id, 'an agent')}'s limits`;
    case 'webhook_endpoints': return `${VERBS[m] ?? 'Changed'} webhook ${typeof row.name === 'string' ? row.name : ''}`.trim();
    default: return null;
  }
}

/** Fields that say nothing to a person: never listed in a row's details. */
const QUIET_FIELDS = new Set(['id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'sort_order', 'search_vector']);

const fieldLabel = (key: string) => {
  const words = key.replace(/_ids$/, 's').replace(/_id$/, '').replace(/_at$/, '').replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** One value in plain words: names for ids, Yes or No, a recurrence in words, a short summary of anything else. */
function valueWords(value: unknown, name: (id: unknown, fallback: string) => string): string {
  if (value === null || value === undefined || value === '') return 'nothing';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (isId(value)) return name(value, 'a record no longer here');
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    const items = value.slice(0, 5).map((item) => valueWords(item, name));
    return value.length > 5 ? `${items.join(', ')} and ${value.length - 5} more` : items.join(', ');
  }
  const recurrence = recurrenceWords(value);
  if (recurrence) return recurrence;
  const record = asRecord(value);
  if (record && (typeof record.name === 'string' || typeof record.title === 'string')) return String(record.name ?? record.title);
  const keys = record ? Object.keys(record) : [];
  return keys.length ? `${keys.length} ${keys.length === 1 ? 'field' : 'fields'}` : 'nothing';
}

export interface AuditDetail {
  label: string;
  value: string;
}

/** The most detail lines a row shows. */
export const AUDIT_DETAILS_MAX = 12;

/**
 * What a row changed, as a short list of plain lines: a change reads
 * "Status: todo to done"; what was sent reads "Member: Sam"; a removal reads
 * "Removed: Sam". Ids become names, quiet fields (ids, timestamps) are left
 * out, and long values are cut short. The raw JSON stays behind Advanced.
 */
export function auditDetails(entry: LabelEntry, names: Record<string, string> = {}): AuditDetail[] {
  const name = namer(entry, names);
  const before = asRecord(entry.before_snapshot);
  const after = asRecord(entry.after_snapshot);
  const body = asRecord(entry.request_body);
  const out: AuditDetail[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (before && after) {
    for (const key of Object.keys({ ...before, ...after })) {
      if (QUIET_FIELDS.has(key) || same(before[key], after[key])) continue;
      out.push({ label: fieldLabel(key), value: `${valueWords(before[key], name)} to ${valueWords(after[key], name)}` });
    }
  } else {
    const source = body ?? after ?? before;
    if (source) {
      for (const [key, value] of Object.entries(source)) {
        if (QUIET_FIELDS.has(key)) continue;
        out.push({ label: fieldLabel(key), value: valueWords(value, name) });
      }
    }
  }
  return out.slice(0, AUDIT_DETAILS_MAX);
}

export const VIA_LABELS: Record<AuditEntry['via'], string> = { app: 'App', rest: 'API', mcp: 'MCP', mcp_oauth: 'Connected AI tool' };
