import type { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled, type AccessContext } from '@/lib/access-control';
import {
  assistantLabel, assistantState, preferencesToContext, readSwitches, readTone, ASSISTANT_DEFAULT_LABEL, BROKEN_WORDS, DEFAULT_PREFERENCES, SWITCH_WORDS,
  type AssistantActivity, type AssistantActivityItem, type AssistantPreferences, type AssistantState, type AssistantStatusRow, type AssistantSwitch,
  type AssistantUndo, type BrokenReason, type ChatConnectionCard, type MyAssistantView, type UpdateMyAssistant,
} from '@/lib/assistant';
import { chatProviderLabel } from '@/lib/chat/types';
import { chatAdapter } from '@/lib/chat/providers';
import { TELEMETRY_EVENT_TYPES } from '@/lib/agent-events';
import { comms } from '@/lib/communications/db';
import { moveToTrash } from '@/lib/supabase/trash';
import { ApiError, forbidden, notFound } from './errors';
import { readAll } from './read-all';
import { trashApiError } from './trash';

/**
 * The personal Assistant on the server: the workspace switch and name, a
 * person's own assistant (its state, settings, what it did, undo), the
 * Owner's status list, and the guard that keeps an assistant to its person's
 * switches. lib/assistant.ts has the rules in plain words.
 *
 * Every read tolerates a database the migration (20261124001400) has not
 * reached: assistants read as off and preferences as the defaults, so new
 * code deployed before db:migrate behaves as the release before it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const missingAssistantSchema = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code ?? '')
    || /assistant_preferences|assistants_enabled|assistant_label|chat_connections|chat_messages|consume_chat_rate_limit|emit_assistant_message/.test(error.message ?? ''));

export const assistantPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'Assistants work once the database update 20261124001400_assistant_chat.sql is applied', {
  reason: 'migration_pending',
});

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingAssistantSchema(error)) throw assistantPending();
  throw error;
}

function requireOwner(access: AccessContext, what: string) {
  if (access.role !== 'owner' || access.status !== 'active') throw forbidden(`Only an Owner ${what}`, { reason: 'owner_only' });
}

// ── Workspace switch and name ───────────────────────────────────────────

export interface WorkspaceAssistantSettings {
  enabled: boolean;
  label: string;
  /** The stored name, null when the workspace uses the default. */
  custom_label: string | null;
}

export async function readAssistantSettings(service: SupabaseClient): Promise<WorkspaceAssistantSettings> {
  const { data, error } = await service.from('business_settings').select('assistants_enabled, assistant_label').limit(1).maybeSingle();
  if (error) {
    if (missingAssistantSchema(error)) return { enabled: false, label: ASSISTANT_DEFAULT_LABEL, custom_label: null };
    throw error;
  }
  const row = (data ?? {}) as Row;
  return { enabled: row.assistants_enabled === true, label: assistantLabel(row.assistant_label), custom_label: row.assistant_label ?? null };
}

/** Turns assistants on or off and names them. Owner only. */
export async function updateAssistantSettings(service: SupabaseClient, access: AccessContext, memberId: string, input: { enabled?: boolean; label?: string | null }): Promise<WorkspaceAssistantSettings> {
  requireOwner(access, 'turns assistants on or names them');
  const { data: settings, error } = await service.from('business_settings').select('id').limit(1).maybeSingle();
  if (error) fail(error);
  if (!settings) throw new ApiError(409, 'CONFLICT', 'Finish workspace setup first', { reason: 'no_business_settings' });
  const changes: Row = {};
  if (input.enabled !== undefined) changes.assistants_enabled = input.enabled;
  if (input.label !== undefined) changes.assistant_label = input.label?.trim() ? input.label.trim() : null;
  const { error: writeError } = await service.from('business_settings').update(changes).eq('id', (settings as Row).id);
  if (writeError) fail(writeError);
  const { error: auditError } = await service.from('api_audit_log').insert({
    method: 'PATCH', endpoint: '/api/workspace/assistants/settings', entity_type: 'business_settings', entity_id: (settings as Row).id,
    team_member_id: memberId, request_body: changes, status_code: 200, via: 'app',
  });
  if (auditError) console.error('[assistant] settings audit write failed', auditError);
  return readAssistantSettings(service);
}

// ── A person's assistant ────────────────────────────────────────────────

const AGENT_COLUMNS = 'id, name, status, suspended_by, delegate_of, delegate_paused_at, assistant_template, created_at';

/** The person's assistant: their personal agent (the personal-assistant one first, then the oldest), or null. */
export async function findPersonalAgent(service: SupabaseClient, personId: string): Promise<Row | null> {
  const { data, error } = await service.from('team_members').select(AGENT_COLUMNS).eq('delegate_of', personId).eq('role', 'agent')
    .order('created_at').order('id');
  if (error) {
    if (missingAssistantSchema(error) || /delegate_of/.test(error.message ?? '')) return null;
    throw error;
  }
  const rows = (data ?? []) as Row[];
  return rows.find((row) => row.assistant_template === 'personal-assistant') ?? rows[0] ?? null;
}

export async function readPreferences(service: SupabaseClient, agentId: string): Promise<AssistantPreferences> {
  const { data, error } = await service.from('assistant_preferences').select('tone, personality, avatar_tone, switches').eq('agent_id', agentId).maybeSingle();
  if (error) {
    if (missingAssistantSchema(error)) return { ...DEFAULT_PREFERENCES };
    throw error;
  }
  const row = data as Row | null;
  if (!row) return { ...DEFAULT_PREFERENCES };
  return { tone: readTone(row.tone), personality: row.personality ?? null, avatar_tone: row.avatar_tone ?? null, switches: readSwitches(row.switches) };
}

/** How many live, unexpired keys each agent holds. */
async function liveKeyCounts(service: SupabaseClient, agentIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (agentIds.length === 0) return counts;
  const keys = await readAll<Row>((from, to) => service.from('api_keys').select('id, team_member_id, expires_at').in('team_member_id', agentIds)
    .is('revoked_at', null).order('id').range(from, to));
  for (const key of keys) {
    if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) continue;
    counts.set(key.team_member_id, (counts.get(key.team_member_id) ?? 0) + 1);
  }
  return counts;
}

async function healthOf(service: SupabaseClient, agentIds: string[]): Promise<Map<string, { reportedAt: string; intervalSeconds: number }>> {
  const out = new Map<string, { reportedAt: string; intervalSeconds: number }>();
  if (agentIds.length === 0) return out;
  const { data, error } = await service.from('agent_health').select('member_id, reported_at, expected_interval_seconds').in('member_id', agentIds);
  if (error) return out;
  for (const row of (data ?? []) as Row[]) {
    if (row.reported_at) out.set(row.member_id, { reportedAt: row.reported_at, intervalSeconds: typeof row.expected_interval_seconds === 'number' ? row.expected_interval_seconds : 60 });
  }
  return out;
}

export async function statesOf(service: SupabaseClient, agents: Row[]): Promise<Map<string, { state: AssistantState; reason: BrokenReason | null }>> {
  const ids = agents.map((agent) => agent.id as string);
  const [keys, health] = await Promise.all([liveKeyCounts(service, ids), healthOf(service, ids)]);
  return new Map(agents.map((agent) => [agent.id as string, assistantState({
    status: agent.status ?? 'active',
    suspendedBy: agent.suspended_by ?? null,
    personId: agent.delegate_of,
    liveKeys: keys.get(agent.id) ?? 0,
    createdAt: agent.created_at,
    health: health.get(agent.id) ?? null,
  })]));
}

/** Who hears that an assistant is broken: its owners other than its person, else the workspace Owners. */
export async function assistantAdmins(service: SupabaseClient, agentId: string, personId: string): Promise<string[]> {
  const { data: owners } = await service.from('agent_owners').select('member_id').eq('agent_id', agentId);
  const ids = ((owners ?? []) as Row[]).map((row) => row.member_id as string).filter((id) => id !== personId);
  const query = ids.length
    ? service.from('team_members').select('id, role, status').in('id', ids)
    : service.from('team_members').select('id, role, status').eq('role', 'owner');
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Row[]).filter((row) => row.role !== 'agent' && (row.status ?? 'active') === 'active' && row.id !== personId).map((row) => row.id as string);
}

/** Once a day per admin per assistant: the bell says whose assistant is paused and why. Never fails the caller. */
export async function notifyAssistantBroken(service: SupabaseClient, agent: { id: string; name: string }, person: { id: string; name: string }, reason: BrokenReason): Promise<number> {
  try {
    const admins = await assistantAdmins(service, agent.id, person.id);
    if (admins.length === 0) return 0;
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data: recent } = await service.from('team_member_notifications').select('user_id').in('user_id', admins)
      .eq('entity_type', 'member').eq('entity_id', agent.id).gte('created_at', since);
    const told = new Set(((recent ?? []) as Row[]).map((row) => row.user_id as string));
    const rows = admins.filter((id) => !told.has(id)).map((id) => ({
      user_id: id,
      title: `${person.name}'s assistant is paused`,
      message: `${BROKEN_WORDS[reason]} ${person.name} sees that it is paused and that you were told.`,
      link: '/settings/assistants',
      entity_type: 'member',
      entity_id: agent.id,
    }));
    if (rows.length === 0) return 0;
    const { error } = await service.from('team_member_notifications').insert(rows);
    if (error) throw error;
    return rows.length;
  } catch (error) {
    console.error('[assistant] could not tell the admins', error);
    return 0;
  }
}

async function personalInboxIds(service: SupabaseClient, personId: string): Promise<string[]> {
  const { data, error } = await comms(service).from('inboxes').select('id').eq('owner_member_id', personId);
  if (error) {
    if (missingAssistantSchema(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).map((row) => row.id as string);
}

async function enabledConnections(service: SupabaseClient): Promise<ChatConnectionCard[]> {
  const { data, error } = await service.from('chat_connections').select('id, provider, display_name, bot_handle, external_workspace_id')
    .eq('enabled', true).order('created_at');
  if (error) {
    if (missingAssistantSchema(error)) return [];
    throw error;
  }
  return ((data ?? []) as Row[]).filter((row) => chatAdapter(row.provider)).map((row) => ({
    id: row.id,
    provider: row.provider,
    provider_label: chatProviderLabel(row.provider),
    display_name: row.display_name,
    bot_handle: row.bot_handle ?? null,
    open_url: chatAdapter(row.provider)?.openUrl({ botHandle: row.bot_handle ?? null, workspaceId: row.external_workspace_id ?? null }) ?? null,
  }));
}

/**
 * What My Assistant shows the signed-in person: the workspace switch and
 * name, their assistant (state, settings) and the chat connections they can
 * link. When it is broken, its admins are told (once a day).
 */
export async function myAssistantView(service: SupabaseClient, memberId: string, access: AccessContext): Promise<MyAssistantView> {
  const settings = await readAssistantSettings(service);
  const agentsOn = isModuleEnabled(access, 'agents');
  const base: MyAssistantView = { enabled: settings.enabled, label: settings.label, agents_on: agentsOn, assistant: null, connections: [] };
  if (!settings.enabled || !agentsOn || access.role === 'agent') return base;
  const agent = await findPersonalAgent(service, memberId);
  if (!agent) return base;
  const [states, preferences, inboxes, connections, person] = await Promise.all([
    statesOf(service, [agent]),
    readPreferences(service, agent.id),
    personalInboxIds(service, memberId),
    enabledConnections(service),
    service.from('team_members').select('id, name').eq('id', memberId).maybeSingle().then(({ data }) => data as Row | null),
  ]);
  const { state, reason } = states.get(agent.id)!;
  if (state === 'broken' && reason) await notifyAssistantBroken(service, { id: agent.id, name: agent.name }, { id: memberId, name: person?.name ?? 'Someone' }, reason);
  return {
    ...base,
    assistant: { id: agent.id, name: agent.name, avatar_tone: preferences.avatar_tone, state, reason, preferences, has_personal_inbox: inboxes.length > 0 },
    connections,
  };
}

async function requireMyAssistant(service: SupabaseClient, memberId: string, access: AccessContext): Promise<Row> {
  if (access.role === 'agent') throw forbidden('An agent has no assistant of its own', { reason: 'agent_has_no_assistant' });
  const settings = await readAssistantSettings(service);
  if (!settings.enabled || !isModuleEnabled(access, 'agents')) throw forbidden('Assistants are not turned on', { reason: 'assistants_off' });
  const agent = await findPersonalAgent(service, memberId);
  if (!agent) throw notFound('Assistant');
  return agent;
}

/**
 * "Sort my inbox": the assistant as a handler of each of the person's
 * personal inboxes, with access to them, as if they had shared the inbox
 * with a helper (on), or neither (off). Answers how many inboxes it covers.
 */
export async function setSortInbox(service: SupabaseClient, agentId: string, personId: string, on: boolean): Promise<number> {
  const inboxes = await personalInboxIds(service, personId);
  if (inboxes.length === 0) return 0;
  if (on) {
    const { data: granted, error: grantError } = await comms(service).from('inbox_access').select('inbox_id').in('inbox_id', inboxes).eq('member_id', agentId);
    if (grantError) throw grantError;
    const shared = new Set(((granted ?? []) as Row[]).map((row) => row.inbox_id as string));
    const toShare = inboxes.filter((id) => !shared.has(id));
    if (toShare.length) {
      const { error: accessError } = await comms(service).from('inbox_access').insert(toShare.map((inbox_id) => ({ inbox_id, member_id: agentId, created_by: personId })));
      if (accessError) throw accessError;
    }
    const { data: existing, error: readError } = await comms(service).from('inbox_handlers').select('inbox_id').in('inbox_id', inboxes).eq('handler_member_id', agentId);
    if (readError) throw readError;
    const have = new Set(((existing ?? []) as Row[]).map((row) => row.inbox_id as string));
    const missing = inboxes.filter((id) => !have.has(id));
    if (missing.length) {
      const { error } = await comms(service).from('inbox_handlers').insert(missing.map((inbox_id) => ({ inbox_id, handler_member_id: agentId, is_primary: false })));
      if (error) throw error;
    }
  } else {
    const { error } = await comms(service).from('inbox_handlers').delete().in('inbox_id', inboxes).eq('handler_member_id', agentId).eq('is_primary', false);
    if (error) throw error;
    const { error: accessError } = await comms(service).from('inbox_access').delete().in('inbox_id', inboxes).eq('member_id', agentId);
    if (accessError) throw accessError;
  }
  return inboxes.length;
}

/**
 * A person changes their own assistant: its name, tone, note, avatar tone,
 * switches, or pauses and resumes it. A pause by an admin is the admin's to
 * lift: resuming then is refused.
 */
export async function updateMyAssistant(service: SupabaseClient, memberId: string, access: AccessContext, input: UpdateMyAssistant): Promise<MyAssistantView> {
  const agent = await requireMyAssistant(service, memberId, access);
  if (input.name !== undefined && input.name !== agent.name) {
    const { error } = await service.from('team_members').update({ name: input.name }).eq('id', agent.id);
    if (error) throw error;
  }
  if (input.paused !== undefined) {
    const pausedByAdmin = agent.status === 'suspended' && agent.suspended_by !== memberId;
    if (!input.paused && pausedByAdmin) {
      throw forbidden('An admin paused your assistant. Ask them to resume it.', { reason: 'paused_by_admin' });
    }
    if (input.paused && agent.status !== 'suspended') {
      const { error } = await service.from('team_members').update({ status: 'suspended', suspended_at: new Date().toISOString(), suspended_by: memberId }).eq('id', agent.id);
      if (error) throw error;
    } else if (!input.paused && agent.status === 'suspended') {
      const { error } = await service.from('team_members').update({ status: 'active', suspended_at: null, suspended_by: null }).eq('id', agent.id);
      if (error) throw error;
    }
  }
  const touchesPreferences = input.tone !== undefined || input.personality !== undefined || input.avatar_tone !== undefined || input.switches !== undefined;
  if (touchesPreferences) {
    const current = await readPreferences(service, agent.id);
    const switches = { ...current.switches, ...Object.fromEntries(Object.entries(input.switches ?? {}).filter(([, value]) => typeof value === 'boolean')) };
    const { error } = await service.from('assistant_preferences').upsert({
      agent_id: agent.id,
      tone: input.tone ?? current.tone,
      personality: input.personality !== undefined ? (input.personality?.trim() || null) : current.personality,
      avatar_tone: input.avatar_tone !== undefined ? input.avatar_tone : current.avatar_tone,
      switches,
      updated_by: memberId,
    }, { onConflict: 'agent_id' });
    if (error) fail(error);
    if (input.switches?.sort_inbox !== undefined && input.switches.sort_inbox !== current.switches.sort_inbox) {
      await setSortInbox(service, agent.id, memberId, input.switches.sort_inbox);
    }
  }
  const { error: auditError } = await service.from('api_audit_log').insert({
    method: 'PATCH', endpoint: '/api/workspace/assistant', entity_type: 'team_member', entity_id: agent.id, team_member_id: memberId,
    request_body: input, status_code: 200, via: 'app',
  });
  if (auditError) console.error('[assistant] audit write failed', auditError);
  return myAssistantView(service, memberId, access);
}

// ── What it did ─────────────────────────────────────────────────────────

/** Two timestamps for the same moment (a transaction's now()), whatever their text. */
const sameInstant = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && new Date(a).getTime() === new Date(b).getTime();

const ACTIVITY_LIMIT = 30;

/**
 * The assistant's recent work in plain lines, newest first: tasks it created
 * (undo: to Trash) and finished (undo: reopen), inbox mail it sorted (undo:
 * the Inbox's own undo), its runs and its events (telemetry left out), and
 * its reply drafts ready for the person.
 */
export async function myAssistantActivity(service: SupabaseClient, memberId: string, access: AccessContext): Promise<AssistantActivity> {
  const agent = await requireMyAssistant(service, memberId, access);
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [created, finished, plans, runs, events, drafts] = await Promise.all([
    service.from('tasks').select('id, title, project_id, created_at, deleted_at').eq('created_by', agent.id).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(ACTIVITY_LIMIT),
    service.from('task_events').select('id, task_id, at').eq('member_id', agent.id).eq('kind', 'status').gte('at', since)
      .order('at', { ascending: false }).limit(ACTIVITY_LIMIT),
    comms(service).from('plans').select('id, conversation_id, summary, status, created_at').eq('member_id', agent.id).eq('mode', 'live').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(ACTIVITY_LIMIT),
    service.from('agent_runs').select('id, title, summary, status, started_at, task_id').eq('agent_id', agent.id).gte('started_at', since)
      .order('started_at', { ascending: false }).limit(ACTIVITY_LIMIT),
    service.from('agent_activities').select('id, title, activity_type, created_at, reference_type, reference_id').eq('agent_id', agent.id).gte('created_at', since)
      .not('activity_type', 'in', `(${TELEMETRY_EVENT_TYPES.join(',')})`).order('created_at', { ascending: false }).limit(ACTIVITY_LIMIT),
    comms(service).from('reply_drafts').select('id, thread_id, status, completed_at, copied_at').eq('drafted_by', agent.id).eq('status', 'ready').is('copied_at', null)
      .order('completed_at', { ascending: false }).limit(20),
  ]);
  const items: AssistantActivityItem[] = [];
  for (const row of (created.data ?? []) as Row[]) {
    items.push({
      id: `created:${row.id}`, kind: 'task_created', at: row.created_at, text: `Created a task: ${row.title}`,
      href: row.deleted_at ? null : `/projects/${row.project_id}?task=${row.id}`,
      undo: row.deleted_at ? null : { kind: 'task_created', id: row.id }, undone: !!row.deleted_at,
    });
  }
  const finishedIds = [...new Set(((finished.data ?? []) as Row[]).map((row) => row.task_id as string))];
  if (finishedIds.length) {
    const { data: tasks } = await service.from('tasks').select('id, title, status, project_id, completed_at, deleted_at').in('id', finishedIds).is('deleted_at', null);
    const byId = new Map(((tasks ?? []) as Row[]).map((task) => [task.id as string, task]));
    const seen = new Set<string>();
    for (const event of (finished.data ?? []) as Row[]) {
      const task = byId.get(event.task_id);
      if (!task || task.deleted_at || seen.has(task.id)) continue;
      // Only the change that moved it to done: the completion stamp and the
      // event share their transaction's time.
      if (task.status !== 'done' || !sameInstant(task.completed_at, event.at)) continue;
      seen.add(task.id);
      items.push({ id: `done:${event.id}`, kind: 'task_completed', at: event.at, text: `Finished a task: ${task.title}`, href: `/projects/${task.project_id}?task=${task.id}`, undo: { kind: 'task_completed', id: task.id } });
    }
  }
  for (const row of (plans.data ?? []) as Row[]) {
    const undone = row.status === 'undone';
    items.push({
      id: `plan:${row.id}`, kind: 'inbox_sorted', at: row.created_at, text: `Sorted an email: ${row.summary}`, href: `/inbox?thread=${row.conversation_id}`,
      undo: undone ? null : { kind: 'inbox_sorted', id: row.id }, undone,
    });
  }
  for (const row of (runs.data ?? []) as Row[]) {
    const what = row.title || row.summary;
    if (!what) continue;
    items.push({ id: `run:${row.id}`, kind: 'run', at: row.started_at, text: `${row.status === 'running' ? 'Working on' : 'Worked on'}: ${what}`, href: null, undo: null });
  }
  for (const row of (events.data ?? []) as Row[]) {
    if (!row.title) continue;
    items.push({ id: `event:${row.id}`, kind: 'event', at: row.created_at, text: row.title, href: null, undo: null });
  }
  items.sort((a, b) => b.at.localeCompare(a.at));

  const draftRows = (drafts.error ? [] : (drafts.data ?? [])) as Row[];
  const threadIds = [...new Set(draftRows.map((row) => row.thread_id as string))];
  const subjects = new Map<string, string | null>();
  if (threadIds.length) {
    const { data: threads } = await comms(service).from('conversations').select('id, subject').in('id', threadIds);
    for (const thread of (threads ?? []) as Row[]) subjects.set(thread.id, thread.subject ?? null);
  }
  return {
    items: items.slice(0, ACTIVITY_LIMIT),
    drafts: draftRows.map((row) => ({ id: row.id, thread_id: row.thread_id, subject: subjects.get(row.thread_id) ?? null, completed_at: row.completed_at ?? null })),
  };
}

/**
 * Takes back one thing the assistant did: a task it created goes to Trash,
 * a task it finished is reopened. Only the person's own assistant's work;
 * anything else reads as missing. Inbox sorts use the Inbox's own undo.
 */
export async function undoAssistantAction(service: SupabaseClient, memberId: string, access: AccessContext, input: AssistantUndo): Promise<{ undone: true }> {
  const agent = await requireMyAssistant(service, memberId, access);
  if (!UUID.test(input.id)) throw notFound('Task');
  if (input.kind === 'inbox_sorted') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Undo an inbox sort with POST /api/workspace/inbox/plans/{id}/undo', { reason: 'use_inbox_undo' });
  }
  const { data: task, error } = await service.from('tasks').select('id, created_by, status, completed_at, deleted_at').eq('id', input.id).maybeSingle();
  if (error) throw error;
  const row = task as Row | null;
  if (!row || row.deleted_at) throw notFound('Task');
  if (input.kind === 'task_created') {
    if (row.created_by !== agent.id) throw notFound('Task');
    try {
      await moveToTrash(service, 'tasks', row.id, memberId);
    } catch (failure) {
      throw trashApiError(failure, 'Task');
    }
    return { undone: true };
  }
  // The assistant itself moved it to done: its status change carries the completion's time.
  if (row.status !== 'done' || !row.completed_at) throw notFound('Task');
  const { data: finishedBy } = await service.from('task_events').select('id, at').eq('task_id', row.id).eq('member_id', agent.id).eq('kind', 'status');
  if (!((finishedBy ?? []) as Row[]).some((event) => sameInstant(event.at, row.completed_at))) throw notFound('Task');
  const { error: reopenError } = await service.from('tasks').update({ status: 'todo' }).eq('id', row.id).is('deleted_at', null);
  if (reopenError) throw reopenError;
  return { undone: true };
}

// ── Owner's status list ─────────────────────────────────────────────────

/** Every personal agent with its state, broken ones first. Owner only. */
export async function assistantStatusList(service: SupabaseClient, access: AccessContext): Promise<AssistantStatusRow[]> {
  requireOwner(access, 'sees everyone\'s assistants');
  const agents = await readAll<Row>((from, to) => service.from('team_members').select(AGENT_COLUMNS).not('delegate_of', 'is', null).eq('role', 'agent')
    .order('id').range(from, to)).catch((error) => fail(error));
  if (agents.length === 0) return [];
  const personIds = [...new Set(agents.map((agent) => agent.delegate_of as string))];
  const [states, people] = await Promise.all([
    statesOf(service, agents),
    readAll<Row>((from, to) => service.from('team_members').select('id, name').in('id', personIds).order('id').range(from, to)),
  ]);
  const names = new Map(people.map((person) => [person.id as string, person.name as string]));
  const order: Record<AssistantState, number> = { broken: 0, getting_ready: 1, paused: 2, working: 3 };
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    person: { id: agent.delegate_of, name: names.get(agent.delegate_of) ?? '' },
    state: states.get(agent.id)!.state,
    reason: states.get(agent.id)!.reason,
    created_at: agent.created_at,
  })).sort((a, b) => order[a.state] - order[b.state] || a.person.name.localeCompare(b.person.name));
}

// ── The guard ───────────────────────────────────────────────────────────

/**
 * Refuses a write a personal agent's person switched off (create_tasks,
 * draft_replies, remind_me). Only a personal agent acting for its person is
 * checked (an agent acting for someone through X-Act-For is not a personal
 * assistant), so every other key, the live fleet's included, never pays a
 * read. Before the migration it allows everything.
 */
export async function requireAssistantSwitch(service: SupabaseClient, memberId: string, access: AccessContext, sw: Exclude<AssistantSwitch, 'sort_inbox'>): Promise<void> {
  if (access.role !== 'agent' || !access.principal_id) return;
  const { data, error } = await service.from('assistant_preferences').select('switches').eq('agent_id', memberId).maybeSingle();
  if (error) {
    if (missingAssistantSchema(error)) return;
    throw error;
  }
  if (!data) return;
  if (!readSwitches((data as Row).switches)[sw]) {
    throw forbidden(`Your person turned off "${SWITCH_WORDS[sw].label}"`, {
      reason: 'assistant_switch_off',
      switch: sw,
      hint: 'Suggest it to them in chat or with ask_human instead.',
    });
  }
}

/**
 * The switches a personal agent's person turned off, for checks that run
 * over many items at once (a triage plan). Empty for anyone else, and before
 * the migration.
 */
export async function assistantSwitchesOff(service: SupabaseClient, memberId: string, access: AccessContext): Promise<Set<AssistantSwitch>> {
  if (access.role !== 'agent' || !access.principal_id) return new Set();
  const { data, error } = await service.from('assistant_preferences').select('switches').eq('agent_id', memberId).maybeSingle();
  if (error) {
    if (missingAssistantSchema(error)) return new Set();
    throw error;
  }
  if (!data) return new Set();
  const switches = readSwitches((data as Row).switches);
  return new Set((Object.keys(switches) as AssistantSwitch[]).filter((key) => !switches[key]));
}

/** For the context pack: the person's settings, in words, or null when they kept every default. */
export async function preferenceLinesFor(service: SupabaseClient, agentId: string, personName: string): Promise<{ preferences: AssistantPreferences; says: string[] }> {
  const preferences = await readPreferences(service, agentId);
  return { preferences, says: preferencesToContext(preferences, personName) };
}
