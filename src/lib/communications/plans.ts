/**
 * Triage plans: an agent's plan for one message, decided item by item by the
 * policy (triage-policy.ts), stored, and applied.
 *
 * - submitPlan: validates every item (a bad one rejects the whole plan,
 *   nothing written), decides each, stores the plan and its items, and in
 *   live mode applies what may apply, records the triage the Inbox and the
 *   summary feed read, and notifies the people who can act when something
 *   waits on them. Shadow plans store the decisions and apply nothing.
 *   Idempotent on (message, mode, key): the same body replays (resuming an
 *   interrupted live plan), a different one conflicts.
 * - acceptItem / dismissItem: a person resolves a proposal; accepting applies
 *   it as theirs.
 * - undoItem / undoPlan: puts back what applied items did.
 *
 * Every write goes through the same helpers as the rest of the app
 * (createTaskAs, createReminder, addTaskFile, link_message_task,
 * file_message_project), so scope, access and soft delete hold here too.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { ApiError, notFound } from '@/lib/api/errors';
import { createTaskAs } from '@/lib/api/create-task';
import { createReminder } from '@/lib/api/reminders';
import { insertComment, patchTask } from '@/lib/supabase/queries';
import { moveToTrash } from '@/lib/supabase/trash';
import { addTaskFile, type TaskFilesContext } from '@/lib/task-files/service';
import { comms } from './db';
import { normalizeAddress, isHostname } from './email/addresses';
import { messageFacts, type MessageFacts } from './speaker';
import { decideItem, type Decision, type PolicyItem } from './triage-policy';
import type { PlanItemRequest, PlanRequest } from './plan-schemas';

type Row = Record<string, unknown>;

/** Who applies items: the agent (its key), or a person resolving a proposal. */
export interface PlanActor {
  db: SupabaseClient;
  memberId: string;
  access: AccessContext;
  channel: 'api' | 'app';
  /** API only: the key's scopes. */
  scopes?: string[];
  /** A person did it: their filing is theirs (source person), whatever the message's scope. */
  asPerson: boolean;
}

export interface PlanMessage {
  id: string;
  thread_id: string;
  inbox_id: string;
  subject: string | null;
}

export class PlanError extends ApiError {}

function unprocessable(message: string, details?: unknown) {
  return new PlanError(422, 'VALIDATION_ERROR', message, details);
}

const STATE_OF: Record<Decision, string> = { apply: 'applying', apply_unsure: 'applying', propose: 'pending', reject: 'skipped' };

/** The inbox link a notification and a summary point at. */
export function inboxLink(message: PlanMessage): string {
  return `/inbox?thread=${message.thread_id}&message=${message.id}`;
}

/** The same plan, however its optional fields are spelled, hashes the same. */
export function planHash(body: PlanRequest): string {
  return createHash('sha256').update(JSON.stringify([
    body.mode, body.summary, body.thread_summary ?? null, body.urgent, body.suspicious, [...body.flags].sort(), body.items,
  ])).digest('hex');
}

/** The workspace owner: whose tasks and reminders the agent's are, as its configuration has it today. */
async function ownerId(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db.from('team_members').select('id').eq('role', 'owner').eq('status', 'active').order('created_at').limit(1);
  if (error) throw error;
  return ((data ?? []) as { id: string }[])[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Facts for the policy
// ---------------------------------------------------------------------------

interface TaskFacts { id: string; project_id: string; parent_task_id: string | null; status: string; due_date: string | null; priority: string; description: string; agentMade: boolean; personTouched: boolean; assignees: string[] }

async function loadTasks(db: SupabaseClient, ids: string[]): Promise<Map<string, TaskFacts>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const [{ data: tasks, error }, { data: events, error: eventError }, { data: assignees, error: assigneeError }] = await Promise.all([
    db.from('tasks').select('id, project_id, parent_task_id, status, due_date, priority, description, created_by').in('id', unique).is('deleted_at', null),
    db.from('task_events').select('task_id, member_id').in('task_id', unique).not('member_id', 'is', null),
    db.from('task_assignees').select('task_id, member_id').in('task_id', unique),
  ]);
  if (error) throw error;
  if (eventError) throw eventError;
  if (assigneeError) throw assigneeError;
  const memberIds = [...new Set([
    ...((tasks ?? []) as Row[]).map((task) => task.created_by as string | null),
    ...((events ?? []) as { member_id: string }[]).map((event) => event.member_id),
  ].filter((id): id is string => !!id))];
  const { data: members, error: memberError } = memberIds.length
    ? await db.from('team_members').select('id, role').in('id', memberIds)
    : { data: [], error: null };
  if (memberError) throw memberError;
  const roleOf = new Map(((members ?? []) as { id: string; role: string }[]).map((m) => [m.id, m.role]));
  const touched = new Set(((events ?? []) as { task_id: string; member_id: string }[])
    .filter((event) => roleOf.get(event.member_id) !== 'agent').map((event) => event.task_id));
  return new Map(((tasks ?? []) as Row[]).map((task) => [task.id as string, {
    id: task.id as string,
    project_id: task.project_id as string,
    parent_task_id: (task.parent_task_id as string | null) ?? null,
    status: task.status as string,
    due_date: (task.due_date as string | null) ?? null,
    priority: task.priority as string,
    description: (task.description as string) ?? '',
    agentMade: roleOf.get(task.created_by as string) === 'agent',
    personTouched: touched.has(task.id as string),
    assignees: ((assignees ?? []) as { task_id: string; member_id: string }[]).filter((a) => a.task_id === task.id).map((a) => a.member_id),
  }]));
}

/** The project an item acts on: named, or its task's. */
function itemProject(item: PlanItemRequest, tasks: Map<string, TaskFacts>): string | null {
  switch (item.type) {
    case 'create_task': case 'file_project': case 'add_context': case 'propose_mapping': return item.project_id;
    case 'reply_owed': return item.project_id ?? null;
    case 'update_task': return item.changes.project_id ?? tasks.get(item.task_id)?.project_id ?? null;
    case 'comment': case 'attach_file': case 'link_task': return tasks.get(item.task_id)?.project_id ?? null;
    case 'add_reminder': return item.task_id ? tasks.get(item.task_id)?.project_id ?? null : item.project_id ?? null;
    default: return null;
  }
}

function itemTaskId(item: PlanItemRequest): string | null {
  return 'task_id' in item && typeof item.task_id === 'string' ? item.task_id : null;
}

interface Prepared {
  item: PlanItemRequest;
  projectId: string | null;
  taskId: string | null;
  decision: Decision;
  reason: string;
}

/** Checks every item and decides it. Any invalid item rejects the plan (422 with each problem). */
async function prepare(actor: PlanActor, message: PlanMessage, facts: MessageFacts, body: PlanRequest): Promise<Prepared[]> {
  const { db, access, channel } = actor;
  const items = body.items;
  const problems: { index: number; reason: string }[] = [];

  // Earlier items a revert names: on this inbox, with the task each touched.
  const revertIds = items.flatMap((item) => (item.type === 'revert_item' ? [item.plan_item_id] : []));
  const { data: revertRows, error: revertError } = revertIds.length
    ? await comms(db).from('plan_items').select('id, type, state, task_id, conversation_id').in('id', revertIds)
    : { data: [], error: null };
  if (revertError) throw revertError;
  const revertConversations = [...new Set(((revertRows ?? []) as Row[]).map((row) => row.conversation_id as string))];
  const { data: revertInboxRows, error: revertInboxError } = revertConversations.length
    ? await comms(db).from('conversations').select('id, inbox_id').in('id', revertConversations)
    : { data: [], error: null };
  if (revertInboxError) throw revertInboxError;
  const inboxOf = new Map(((revertInboxRows ?? []) as { id: string; inbox_id: string }[]).map((row) => [row.id, row.inbox_id]));
  const reverts = new Map<string, Row & { inbox_id?: string }>(((revertRows ?? []) as Row[]).map((row) => [row.id as string, { ...row, inbox_id: inboxOf.get(row.conversation_id as string) }]));

  const taskIds = [
    ...items.flatMap((item) => (itemTaskId(item) ? [itemTaskId(item)!] : [])),
    ...items.flatMap((item) => (item.type === 'create_task' && item.parent_task_id ? [item.parent_task_id] : [])),
    ...((revertRows ?? []) as Row[]).map((row) => row.task_id as string | null).filter((id): id is string => !!id),
  ];
  const tasks = await loadTasks(db, taskIds);

  const projectIds = [...new Set(items.flatMap((item) => {
    const named = [item.type === 'update_task' ? item.changes.project_id : undefined, 'project_id' in item ? item.project_id : undefined];
    return named.filter((id): id is string => typeof id === 'string');
  }).concat([...tasks.values()].map((task) => task.project_id)))];
  const { data: projectRows, error: projectError } = projectIds.length
    ? await db.from('projects').select('id, status, archived_at').in('id', projectIds).is('deleted_at', null)
    : { data: [], error: null };
  if (projectError) throw projectError;
  const projects = new Map(((projectRows ?? []) as { id: string; status: string; archived_at: string | null }[]).map((p) => [p.id, p]));

  // The message's scope for each project, as the database decides it.
  const sources = new Map<string, string | null>();
  for (const projectId of projects.keys()) {
    const { data, error } = await comms(db).rpc('scope_source', { p_message_id: message.id, p_project_id: projectId });
    if (error) throw error;
    sources.set(projectId, (data as string | null) ?? null);
  }

  // Attachments must be this message's.
  const attachmentIds = items.flatMap((item) => ('attachment_ids' in item && item.attachment_ids ? item.attachment_ids : []));
  const { data: attachmentRows, error: attachmentError } = attachmentIds.length
    ? await comms(db).from('attachments').select('id').eq('message_id', message.id).in('id', attachmentIds)
    : { data: [], error: null };
  if (attachmentError) throw attachmentError;
  const ownAttachments = new Set(((attachmentRows ?? []) as { id: string }[]).map((row) => row.id));

  // Reminders an item edits, leads it logs on, points it amends.
  const reminderIds = items.flatMap((item) => ('reminder_id' in item ? [item.reminder_id] : []));
  const { data: reminderRows, error: reminderError } = reminderIds.length
    ? await db.from('reminders').select('id, source_message_id').in('id', reminderIds).is('deleted_at', null)
    : { data: [], error: null };
  if (reminderError) throw reminderError;
  // Only a reminder an email of this conversation set: a message never edits anyone else's.
  const { data: threadRows, error: threadError } = reminderIds.length
    ? await comms(db).from('messages').select('id').eq('thread_id', message.thread_id)
    : { data: [], error: null };
  if (threadError) throw threadError;
  const threadMessages = new Set(((threadRows ?? []) as { id: string }[]).map((row) => row.id));
  const reminders = new Set(((reminderRows ?? []) as { id: string; source_message_id: string | null }[])
    .filter((row) => !!row.source_message_id && threadMessages.has(row.source_message_id)).map((row) => row.id));
  const leadIds = items.flatMap((item) => (item.type === 'log_interaction' ? [item.lead_id] : []));
  const { data: leadRows, error: leadError } = leadIds.length
    ? await db.from('leads').select('id').in('id', leadIds).is('deleted_at', null)
    : { data: [], error: null };
  if (leadError) throw leadError;
  const leads = new Set(((leadRows ?? []) as { id: string }[]).map((row) => row.id));
  const pointIds = items.flatMap((item) => (item.type === 'reply_owed' && item.point_id ? [item.point_id] : []));
  const { data: pointRows, error: pointError } = pointIds.length
    ? await comms(db).from('reply_points').select('id').eq('conversation_id', message.thread_id).in('id', pointIds)
    : { data: [], error: null };
  if (pointError) throw pointError;
  const points = new Set(((pointRows ?? []) as { id: string }[]).map((row) => row.id));

  const prepared: Prepared[] = [];
  items.forEach((item, index) => {
    const problem = (reason: string) => problems.push({ index, reason });
    const taskId = itemTaskId(item);
    if (taskId && !tasks.has(taskId)) problem('task_not_found');
    const projectId = itemProject(item, tasks);
    if (projectId && !projects.has(projectId)) problem('project_not_found');
    if (projectId && projects.has(projectId) && !accessAllowsProject(access, projectId, channel)) problem('project_scope_denied');
    if ('attachment_ids' in item && item.attachment_ids?.some((id) => !ownAttachments.has(id))) problem('attachment_not_on_this_message');
    if ('reminder_id' in item && !reminders.has(item.reminder_id)) problem('reminder_not_on_this_conversation');
    if (item.type === 'log_interaction' && !leads.has(item.lead_id)) problem('lead_not_found');
    if (item.type === 'reply_owed' && item.point_id && !points.has(item.point_id)) problem('reply_point_not_on_this_conversation');
    if (item.type === 'revert_item') {
      const target = reverts.get(item.plan_item_id);
      if (!target || target.inbox_id !== message.inbox_id) problem('plan_item_not_found');
    }
    if (item.type === 'propose_mapping') {
      if (item.address && !normalizeAddress(item.address)) problem('address_invalid');
      if (item.domain && !isHostname(item.domain)) problem('domain_invalid');
    }
    if (item.type === 'add_reminder' && item.task_id && item.project_id && tasks.get(item.task_id)?.project_id !== item.project_id) {
      problem('project_does_not_match_task');
    }
    // A subtask goes under an open, top-level task of the same project.
    if (item.type === 'create_task' && item.parent_task_id) {
      const parent = tasks.get(item.parent_task_id);
      if (!parent) problem('parent_task_not_found');
      else if (parent.project_id !== item.project_id) problem('project_does_not_match_parent_task');
      else if (parent.parent_task_id) problem('parent_task_is_a_subtask');
      else if (parent.status === 'done') problem('parent_task_done');
    }

    const task = taskId ? tasks.get(taskId) : undefined;
    const project = projectId ? projects.get(projectId) : undefined;
    // Moving a task: its current project must be in reach and in scope too.
    const moveFrom = item.type === 'update_task' && item.changes.project_id && task && item.changes.project_id !== task.project_id ? task.project_id : null;
    if (moveFrom && !accessAllowsProject(access, moveFrom, channel)) problem('project_scope_denied');
    const changes = item.type === 'update_task' ? Object.keys(item.changes).filter((key) => (item.changes as Row)[key] !== undefined) : undefined;
    const revertTarget = item.type === 'revert_item' ? reverts.get(item.plan_item_id) : undefined;
    const revertTask = revertTarget?.task_id ? tasks.get(revertTarget.task_id as string) : undefined;
    const policyItem: PolicyItem = {
      type: item.type,
      intent: item.intent,
      addressee: item.addressee,
      confidence: item.confidence,
      hasProject: !!projectId,
      projectSource: projectId && !(moveFrom && !sources.get(moveFrom)) ? sources.get(projectId) ?? null : null,
      projectStatus: project ? (project.archived_at ? 'archived' : project.status as 'active' | 'completed' | 'archived') : null,
      changes,
      changesPersonSet: task ? !task.agentMade || task.personTouched : undefined,
      // A revert of something a person approved, or worked on since, waits for them.
      targetUntouched: item.type === 'revert_item'
        ? (revertTarget?.state === 'accepted' ? false : revertTask ? revertTask.agentMade && !revertTask.personTouched : true)
        : task ? task.agentMade && !task.personTouched : undefined,
      teammateOwnReview: !!task && facts.speaker === 'teammate' && !!facts.senderMemberId && task.assignees.includes(facts.senderMemberId),
    };
    const { decision, reason } = decideItem({ ...facts, suspicious: body.suspicious }, policyItem);
    prepared.push({ item, projectId, taskId, decision, reason });
  });
  if (problems.length) {
    throw unprocessable('Some items cannot be used as they are: nothing was recorded.', { reason: 'invalid_items', items: problems });
  }
  return prepared;
}

// ---------------------------------------------------------------------------
// Applying one item
// ---------------------------------------------------------------------------

function filesContext(actor: PlanActor): TaskFilesContext {
  return { db: actor.db, access: actor.access, memberId: actor.memberId, channel: actor.channel, scopes: actor.scopes };
}

async function link(actor: PlanActor, message: PlanMessage, taskId: string, relation: 'created' | 'updated' | 'related') {
  const { data, error } = await comms(actor.db).rpc('link_message_task', {
    p_message_id: message.id, p_task_id: taskId, p_relation: relation, p_member_id: actor.memberId, p_as_person: actor.asPerson,
  });
  if (error) throw error;
  return data as Row;
}

/** Applies one item; returns what it did (ids created, values replaced) for undo. */
export async function applyItem(actor: PlanActor, message: PlanMessage, item: PlanItemRequest, existing: Row = {}): Promise<Row> {
  const { db, memberId, access } = actor;
  const owner = await ownerId(db);
  // A retry of this item: what an earlier try already did, and since when to look.
  const prior = (existing.result ?? {}) as Row;
  const since = (existing.created_at as string | undefined) ?? new Date(0).toISOString();
  const save = async (partial: Row) => {
    if (!existing.id) return;
    const { error } = await comms(db).from('plan_items').update({ result: partial, task_id: (partial.task_id as string | undefined) ?? null }).eq('id', existing.id as string);
    if (error) throw error;
  };
  switch (item.type) {
    case 'create_task': {
      // A retry never makes a second task: the id is saved the moment the task exists.
      let taskId = (prior.task_id as string | undefined) ?? null;
      if (!taskId) {
        const canAssignOthers = accessAllows(access, 'tasks.manage_all', actor.channel);
        const assignee = owner && canAssignOthers ? [owner] : undefined;
        const created = await createTaskAs({ supabase: db, memberId, access, canAssignOthers, channel: actor.channel }, {
          project_id: item.project_id,
          ...(item.parent_task_id ? { parent_task_id: item.parent_task_id } : {}),
          title: item.title,
          description: item.description ?? '',
          ...(item.due_date !== undefined ? { due_date: item.due_date } : {}),
          ...(item.priority ? { priority: item.priority } : {}),
          ...(assignee ? { assignee_ids: assignee } : {}),
          source_note: message.subject ? `From the email "${message.subject}"` : 'From an email',
        });
        taskId = created.id as string;
        await save({ task_id: taskId });
      }
      const task = { id: taskId };
      await link(actor, message, task.id, 'created');
      const files: string[] = [];
      for (const attachmentId of item.attachment_ids ?? []) {
        const { file } = await addTaskFile(filesContext(actor), task.id, { email_attachment_id: attachmentId });
        files.push(file.id);
      }
      return { task_id: task.id, task_file_ids: files, suggested_assignee_id: item.suggested_assignee_id ?? null };
    }
    case 'update_task': {
      const { data: before, error } = await db.from('tasks').select('id, project_id, due_date, priority, description, status').eq('id', item.task_id).is('deleted_at', null).single();
      if (error) throw error;
      const changes = Object.fromEntries(Object.entries(item.changes).filter(([, value]) => value !== undefined));
      if (changes.project_id && changes.project_id !== before.project_id) {
        const { count } = await db.from('task_dependencies').select('task_id', { count: 'exact', head: true }).eq('task_id', item.task_id);
        if (count) throw unprocessable('This task has blockers in its project, so it is moved by hand.', { reason: 'task_has_blockers' });
      }
      const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, (before as Row)[key] ?? null]));
      await patchTask(db, item.task_id, changes);
      await link(actor, message, item.task_id, 'updated');
      return { task_id: item.task_id, before: previous, after: changes };
    }
    case 'comment': {
      const { data: same } = existing.id
        ? await db.from('task_comments').select('id').eq('task_id', item.task_id).eq('user_id', memberId).eq('text', item.text)
          .is('deleted_at', null).gte('created_at', since).limit(1)
        : { data: [] };
      const comment = ((same ?? []) as { id: string }[])[0] ?? await insertComment(db, item.task_id, memberId, item.text);
      await link(actor, message, item.task_id, 'updated');
      return { comment_id: comment.id, task_id: item.task_id };
    }
    case 'attach_file': {
      const files: string[] = [];
      for (const attachmentId of item.attachment_ids) {
        const { file } = await addTaskFile(filesContext(actor), item.task_id, { email_attachment_id: attachmentId });
        files.push(file.id);
      }
      await link(actor, message, item.task_id, 'updated');
      return { task_id: item.task_id, task_file_ids: files };
    }
    case 'add_reminder': {
      const { data: earlier } = await db.from('reminders').select('id').eq('source_message_id', message.id).eq('title', item.title).is('deleted_at', null).limit(1);
      const found = ((earlier ?? []) as { id: string }[])[0];
      const reminder = found ?? await createReminder(db, access, memberId, {
        title: item.title,
        notes: item.notes,
        remind_on: item.remind_on ?? null,
        remind_at: item.remind_at ?? null,
        task_id: item.task_id ?? null,
        project_id: item.task_id ? null : item.project_id ?? null,
        ...(owner && owner !== memberId && access.role === 'agent' ? { owner_id: owner } : {}),
        source_message_id: message.id,
      }, actor.channel);
      return { reminder_id: (reminder as { id: string }).id };
    }
    case 'update_reminder':
    case 'complete_reminder': {
      const { data: before, error } = await db.from('reminders').select('id, title, notes, remind_on, remind_at, status').eq('id', item.reminder_id).is('deleted_at', null).single();
      if (error) throw error;
      const patch: Row = item.type === 'complete_reminder'
        ? { status: 'done', completed_by: memberId }
        : Object.fromEntries(Object.entries({ title: item.title, notes: item.notes, remind_on: item.remind_on, remind_at: item.remind_at }).filter(([, v]) => v !== undefined));
      if (patch.remind_on === null) patch.remind_at = null;
      const { error: updateError } = await db.from('reminders').update(patch).eq('id', item.reminder_id).is('deleted_at', null);
      if (updateError) throw updateError;
      return { reminder_id: item.reminder_id, before: Object.fromEntries(Object.keys(patch).filter((k) => k !== 'completed_by').map((k) => [k, (before as Row)[k] ?? null])) };
    }
    case 'link_task':
      await link(actor, message, item.task_id, item.relation);
      return { task_id: item.task_id, relation: item.relation };
    case 'file_project': {
      const { data, error } = await comms(db).rpc('file_message_project', {
        p_message_id: message.id, p_project_id: item.project_id, p_member_id: memberId, p_as_person: actor.asPerson,
      });
      if (error) throw error;
      return { project_id: item.project_id, source: data };
    }
    case 'reply_owed': {
      const fields = {
        conversation_id: message.thread_id,
        message_id: message.id,
        plan_item_id: (existing.id as string | undefined) ?? null,
        project_id: item.project_id ?? null,
        who: item.who,
        what: item.what,
        kind: item.kind,
        to_agent: item.to_agent ?? false,
        note: item.note ?? null,
        by_when: item.by_when ?? null,
        urgent: item.urgent ?? false,
      };
      if (item.point_id) {
        const { data: before, error } = await comms(db).from('reply_points').select('*').eq('id', item.point_id).single();
        if (error) throw error;
        const { error: updateError } = await comms(db).from('reply_points').update({ ...fields, state: 'open', resolved_at: null, resolved_by: null }).eq('id', item.point_id);
        if (updateError) throw updateError;
        return { point_id: item.point_id, before };
      }
      const { data: same } = existing.id
        ? await comms(db).from('reply_points').select('id').eq('plan_item_id', existing.id as string).limit(1)
        : { data: [] };
      const found = ((same ?? []) as { id: string }[])[0];
      if (found) return { point_id: found.id };
      const { data, error } = await comms(db).from('reply_points').insert(fields).select('id').single();
      if (error) throw error;
      return { point_id: (data as { id: string }).id };
    }
    case 'revert_item':
      return { reverted: item.plan_item_id, undone: await undoItem(actor, item.plan_item_id) };
    case 'mute_conversation': {
      const { error } = await comms(db).from('conversations').update({ muted_at: new Date().toISOString(), muted_by: memberId }).eq('id', message.thread_id);
      if (error) throw error;
      return { conversation_id: message.thread_id };
    }
    case 'add_context': {
      const { data: same } = await db.from('project_context').select('id').eq('project_id', item.project_id).eq('content', item.content).eq('is_active', true).limit(1);
      const found = ((same ?? []) as { id: string }[])[0];
      if (found) return { context_id: found.id };
      const { data, error } = await db.from('project_context')
        .insert({ project_id: item.project_id, category: item.category, content: item.content, source: 'agent', is_active: true })
        .select('id').single();
      if (error) throw error;
      return { context_id: (data as { id: string }).id };
    }
    case 'propose_mapping': {
      const table = item.address ? 'client_addresses' : 'client_domains';
      const value = item.address ? { address: normalizeAddress(item.address) } : { domain: item.domain };
      // trash-checked: client addresses and client domains have no Trash.
      const { data, error } = await comms(db).from(table).upsert({ project_id: item.project_id, ...value, created_by: memberId }, {
        onConflict: item.address ? 'project_id,address' : 'domain,project_id', ignoreDuplicates: true,
      }).select('id');
      if (error) throw error;
      return { table, id: ((data ?? []) as { id: string }[])[0]?.id ?? null };
    }
    case 'create_lead': {
      const { data: same } = existing.id
        ? await db.from('leads').select('id').eq('name', item.name).eq('created_by', memberId).is('deleted_at', null).gte('created_at', since).limit(1)
        : { data: [] };
      const found = ((same ?? []) as { id: string }[])[0];
      if (found) return { lead_id: found.id };
      const { data, error } = await db.from('leads').insert({
        name: item.name, email: item.email ?? '', company: item.company ?? '', notes: item.notes ?? '',
        source: item.source ?? 'other', created_by: memberId,
      }).select('id').single();
      if (error) throw error;
      return { lead_id: (data as { id: string }).id };
    }
    case 'log_interaction': {
      const { data: same } = existing.id
        ? await db.from('lead_interactions').select('id').eq('lead_id', item.lead_id).eq('title', item.title).eq('created_by', memberId)
          .is('deleted_at', null).gte('created_at', since).limit(1)
        : { data: [] };
      const found = ((same ?? []) as { id: string }[])[0];
      if (found) return { interaction_id: found.id };
      const { data, error } = await db.from('lead_interactions').insert({
        lead_id: item.lead_id, type: item.kind, title: item.title, description: item.description ?? '',
        scheduled_at: item.scheduled_at ?? null, created_by: memberId,
      }).select('id').single();
      if (error) throw error;
      return { interaction_id: (data as { id: string }).id };
    }
    case 'ask':
      return {};
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** Puts back what an applied item did. Returns what it could not (a task a person changed since). */
export async function undoItem(actor: PlanActor, itemId: string): Promise<Row> {
  const { db, memberId } = actor;
  const { data: row, error } = await comms(db).from('plan_items').select('*, plan:plans!inner(message_id)').eq('id', itemId).single();
  if (error) throw error;
  const item = row as unknown as Row & { type: string; state: string; result: Row; payload: Row; plan: { message_id: string } };
  if (!['done', 'accepted'].includes(item.state)) return { skipped: `not applied (${item.state})` };
  const result = item.result ?? {};
  const notes: Row = {};
  switch (item.type) {
    case 'create_task': {
      if (!actor.asPerson) {
        const facts = (await loadTasks(db, [result.task_id as string])).get(result.task_id as string);
        if (facts?.personTouched) {
          notes.changed_since = true;
          break;
        }
      }
      await moveToTrash(db, 'tasks', result.task_id as string, memberId);
      break;
    }
    case 'comment':
      await moveToTrash(db, 'task_comments', result.comment_id as string, memberId);
      break;
    case 'attach_file':
      for (const fileId of (result.task_file_ids as string[] | undefined) ?? []) await moveToTrash(db, 'task_files', fileId, memberId);
      break;
    case 'add_reminder':
      await moveToTrash(db, 'reminders', result.reminder_id as string, memberId);
      break;
    case 'update_reminder':
    case 'complete_reminder': {
      const { error: updateError } = await db.from('reminders').update(result.before as Row).eq('id', result.reminder_id as string).is('deleted_at', null);
      if (updateError) throw updateError;
      break;
    }
    case 'update_task': {
      const after = (result.after ?? {}) as Row;
      const { data: now, error: nowError } = await db.from('tasks').select('*').eq('id', result.task_id as string).is('deleted_at', null).maybeSingle();
      if (nowError) throw nowError;
      // A task in Trash is left there: a person put it there since.
      if (!now) {
        notes.changed_since = true;
        break;
      }
      const unchanged = Object.entries(after).every(([key, value]) => ((now as Row)[key] ?? null) === (value ?? null));
      if (!unchanged) {
        notes.changed_since = true;
        break;
      }
      await patchTask(db, result.task_id as string, result.before as Row);
      break;
    }
    case 'link_task': {
      const { error: deleteError } = await comms(db).from('task_links').delete()
        .eq('task_id', result.task_id as string).eq('relation', result.relation as string).eq('message_id', item.plan.message_id);
      if (deleteError) throw deleteError;
      break;
    }
    case 'reply_owed': {
      // An amended point goes back to what it was; a new one is resolved.
      const before = result.before as Row | undefined;
      const patch = before
        ? Object.fromEntries(['message_id', 'plan_item_id', 'project_id', 'who', 'what', 'kind', 'to_agent', 'note', 'by_when', 'urgent', 'state', 'resolved_by', 'resolved_at']
          .map((key) => [key, before[key] ?? null]))
        : { state: 'resolved', resolved_by: memberId, resolved_at: new Date().toISOString() };
      const { error: updateError } = await comms(db).from('reply_points').update(patch).eq('id', result.point_id as string);
      if (updateError) throw updateError;
      break;
    }
    case 'mute_conversation': {
      const { error: updateError } = await comms(db).from('conversations').update({ muted_at: null, muted_by: null }).eq('id', result.conversation_id as string);
      if (updateError) throw updateError;
      break;
    }
    case 'add_context': {
      const { error: updateError } = await db.from('project_context').update({ is_active: false }).eq('id', result.context_id as string);
      if (updateError) throw updateError;
      break;
    }
    case 'create_lead':
      await moveToTrash(db, 'leads', result.lead_id as string, memberId);
      break;
    case 'log_interaction':
      await moveToTrash(db, 'lead_interactions', result.interaction_id as string, memberId);
      break;
    default:
      // Filing, mappings, questions and reverts are not undone here: a person removes a project or mapping themselves.
      return { skipped: `${item.type} is not undone` };
  }
  if (notes.changed_since) return notes;
  const { error: stateError } = await comms(db).from('plan_items').update({ state: 'undone', resolved_by: memberId, resolved_at: new Date().toISOString() }).eq('id', itemId);
  if (stateError) throw stateError;
  return { undone: true };
}

// ---------------------------------------------------------------------------
// Submitting a plan
// ---------------------------------------------------------------------------

export interface SubmittedPlan {
  plan: Row;
  items: Row[];
  replayed: boolean;
}

async function readPlan(db: SupabaseClient, planId: string): Promise<SubmittedPlan> {
  const [{ data: plan, error }, { data: items, error: itemError }] = await Promise.all([
    comms(db).from('plans').select('*').eq('id', planId).single(),
    comms(db).from('plan_items').select('*').eq('plan_id', planId).order('position'),
  ]);
  if (error) throw error;
  if (itemError) throw itemError;
  const visible = { ...(plan as Row) };
  delete visible.request_hash;
  return { plan: visible, items: (items ?? []) as Row[], replayed: false };
}

/** What a live plan's triage row says, for the Inbox and the summary feed. */
function triageOf(body: PlanRequest, items: Row[]) {
  const live = (state: string) => items.some((i) => i.state === state);
  const ask = items.find((i) => i.type === 'ask' && i.state === 'pending');
  const question = ask ? `${(ask.payload as Row).question}${(ask.payload as Row).default ? ` Default: ${(ask.payload as Row).default}` : ''}` : null;
  const proposals = items.some((i) => i.state === 'pending' && i.type !== 'ask');
  const owed = items.some((i) => i.type === 'reply_owed' && ['done', 'applying'].includes(i.state as string));
  const outcome = ask || proposals ? 'needs_human' : owed ? 'needs_reply' : items.some((i) => i.type === 'create_task' && live('done')) ? 'task' : 'no_action';
  return {
    outcome,
    status: ask || proposals ? 'needs_human' : 'handled',
    question: question ?? (proposals ? 'Some of this waits for you: see the proposals.' : null),
    triage: { outcome, urgent: body.urgent, summary: body.summary, question_for_human: question ?? (proposals ? 'Some of this waits for you: see the proposals.' : null), suggested_reply: null, thread_summary: body.thread_summary ?? null },
  };
}

/** Everyone who can act on the inbox: the owner and the people granted it. */
async function inboxPeople(db: SupabaseClient, inboxId: string): Promise<string[]> {
  const { data: granted, error: grantError } = await comms(db).from('inbox_access').select('member_id').eq('inbox_id', inboxId);
  if (grantError) throw grantError;
  const grantedIds = ((granted ?? []) as { member_id: string }[]).map((row) => row.member_id);
  const { data: people, error } = await db.from('team_members').select('id, role, status')
    .or(grantedIds.length ? `role.eq.owner,id.in.(${grantedIds.join(',')})` : 'role.eq.owner');
  if (error) throw error;
  return ((people ?? []) as { id: string; role: string; status: string }[])
    .filter((member) => member.role !== 'agent' && member.status === 'active').map((member) => member.id);
}

/** The first name of the agent that handles an inbox, for what people read. */
export async function inboxAgentName(db: SupabaseClient, inboxId: string): Promise<string> {
  const { data: inbox } = await comms(db).from('inboxes').select('handler_member_id').eq('id', inboxId).maybeSingle();
  const handler = (inbox as { handler_member_id: string | null } | null)?.handler_member_id;
  if (!handler) return '';
  const { data: member } = await db.from('team_members').select('name').eq('id', handler).maybeSingle();
  return ((member as { name?: string } | null)?.name ?? '').split(/\s+/)[0];
}

/** How long a proposal waits before it lapses quietly, and a question or a reply owed. */
export const PROPOSAL_DAYS = 14;
export const WAITING_DAYS = 30;

/**
 * Lapses what has waited too long: proposals after PROPOSAL_DAYS, questions
 * and replies owed after WAITING_DAYS. Their messages' notifications follow.
 * Run daily with retention.
 */
export async function expireWaiting(db: SupabaseClient): Promise<{ proposals: number; questions: number; replies: number }> {
  const before = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const [proposals, questions, replies] = await Promise.all([
    comms(db).from('plan_items').update({ state: 'expired', resolved_at: now }).eq('state', 'pending').neq('type', 'ask').lt('created_at', before(PROPOSAL_DAYS)).select('plan_id'),
    comms(db).from('plan_items').update({ state: 'expired', resolved_at: now }).eq('state', 'pending').eq('type', 'ask').lt('created_at', before(WAITING_DAYS)).select('plan_id'),
    comms(db).from('reply_points').update({ state: 'expired', resolved_at: now }).eq('state', 'open').lt('updated_at', before(WAITING_DAYS)).select('message_id'),
  ]);
  for (const result of [proposals, questions, replies]) if (result.error) throw result.error;
  const planIds = [...new Set([...(proposals.data ?? []), ...(questions.data ?? [])].map((row) => (row as { plan_id: string }).plan_id))];
  const { data: planRows, error } = planIds.length ? await comms(db).from('plans').select('message_id').in('id', planIds) : { data: [], error: null };
  if (error) throw error;
  const messageIds = [...new Set([
    ...((planRows ?? []) as { message_id: string }[]).map((row) => row.message_id),
    ...((replies.data ?? []) as { message_id: string | null }[]).map((row) => row.message_id).filter((id): id is string => !!id),
  ])];
  if (messageIds.length) {
    const { data: messages, error: messageError } = await comms(db).from('messages').select('id, thread_id, inbox_id, subject').in('id', messageIds);
    if (messageError) throw messageError;
    for (const message of (messages ?? []) as PlanMessage[]) await syncWaitingNotification(db, message, await inboxAgentName(db, message.inbox_id));
  }
  return { proposals: (proposals.data ?? []).length, questions: (questions.data ?? []).length, replies: (replies.data ?? []).length };
}

/** One unread notification per message while something on it waits on a person; read once nothing does. */
export async function syncWaitingNotification(db: SupabaseClient, message: PlanMessage, agentName: string): Promise<void> {
  const { data: plans, error } = await comms(db).from('plans').select('id').eq('message_id', message.id).eq('mode', 'live');
  if (error) throw error;
  const planIds = ((plans ?? []) as { id: string }[]).map((p) => p.id);
  // A message no plan handled is the older triage's: its notifications are not ours to touch.
  if (!planIds.length) return;
  const [{ data: pending, error: pendingError }, { data: owed, error: owedError }] = await Promise.all([
    planIds.length ? comms(db).from('plan_items').select('type, payload').in('plan_id', planIds).eq('state', 'pending') : Promise.resolve({ data: [], error: null }),
    comms(db).from('reply_points').select('what').eq('message_id', message.id).eq('state', 'open').eq('to_agent', false),
  ]);
  if (pendingError) throw pendingError;
  if (owedError) throw owedError;
  const waiting = ((pending ?? []) as { type: string }[]).length + ((owed ?? []) as unknown[]).length;
  if (!waiting) {
    const { error: readError } = await db.from('team_member_notifications').update({ is_read: true })
      .eq('entity_type', 'question').eq('entity_id', message.id).eq('is_read', false);
    if (readError) throw readError;
    return;
  }
  const asks = ((pending ?? []) as { type: string; payload: Row }[]).filter((p) => p.type === 'ask');
  const proposals = ((pending ?? []) as { type: string }[]).length - asks.length;
  const parts = [
    asks.length ? (asks[0].payload.question as string) : null,
    proposals ? `${proposals} proposal${proposals === 1 ? '' : 's'} to approve` : null,
    (owed ?? []).length ? `${(owed ?? []).length} repl${(owed ?? []).length === 1 ? 'y' : 'ies'} owed` : null,
  ].filter(Boolean);
  for (const person of await inboxPeople(db, message.inbox_id)) {
    const { error: notifyError } = await db.rpc('upsert_notification', {
      p_user_id: person,
      p_title: `${agentName || 'Your agent'} needs you on "${(message.subject ?? 'an email').slice(0, 80)}"`,
      p_message: parts.join(' · ').slice(0, 300),
      p_link: inboxLink(message),
      p_entity_type: 'question',
      p_entity_id: message.id,
    });
    if (notifyError) throw notifyError;
  }
}

async function applyPending(actor: PlanActor, message: PlanMessage, planId: string): Promise<void> {
  const { data: rows, error } = await comms(actor.db).from('plan_items').select('*').eq('plan_id', planId).in('state', ['applying', 'failed']).order('position');
  if (error) throw error;
  for (const row of (rows ?? []) as Row[]) {
    try {
      const result = await applyItem(actor, message, row.payload as PlanItemRequest, row);
      const taskId = (result.task_id as string | undefined) ?? (row.task_id as string | null);
      const { error: updateError } = await comms(actor.db).from('plan_items').update({ state: 'done', result, error: null, task_id: taskId ?? null }).eq('id', row.id as string);
      if (updateError) throw updateError;
    } catch (applyError) {
      const text = applyError instanceof Error ? applyError.message : (applyError as { message?: string })?.message ?? String(applyError);
      const { error: updateError } = await comms(actor.db).from('plan_items').update({ state: 'failed', error: text.slice(0, 1000) }).eq('id', row.id as string);
      if (updateError) throw updateError;
    }
  }
}

/** A live plan still being applied, by another request, if one started in the last few minutes. */
const APPLYING_GRACE_MS = 5 * 60_000;

export async function submitPlan(actor: PlanActor, message: PlanMessage, body: PlanRequest, agentName: string): Promise<SubmittedPlan> {
  const { db } = actor;
  // The inbox decides: only an inbox switched to plans applies a plan. Anything
  // else (the older triage's inboxes, a shadow inbox) records it as shadow.
  const { data: inbox, error: inboxError } = await comms(db).from('inboxes').select('triage_mode').eq('id', message.inbox_id).single();
  if (inboxError) throw inboxError;
  const mode: 'live' | 'shadow' = body.mode === 'live' && (inbox as { triage_mode: string }).triage_mode === 'plans' ? 'live' : 'shadow';
  const key = body.idempotency_key ?? null;
  const hash = planHash(body);
  if (key) {
    const { data: prior, error } = await comms(db).from('plans').select('id, status, request_hash, created_at').eq('message_id', message.id).eq('mode', mode).eq('idempotency_key', key).maybeSingle();
    if (error) throw error;
    if (prior) {
      const row = prior as Row;
      if (row.request_hash !== hash) {
        throw new PlanError(409, 'CONFLICT', 'This idempotency_key was already used for a different plan of this message', { reason: 'idempotency_conflict', plan_id: row.id });
      }
      // Finish an interrupted plan; one another request is still applying is left to it.
      const stale = Date.now() - Date.parse(row.created_at as string) > APPLYING_GRACE_MS;
      if (mode === 'live' && (row.status === 'partial' || (row.status === 'applying' && stale))) {
        await finishLive(actor, message, row.id as string, body, agentName);
      }
      return { ...(await readPlan(db, row.id as string)), replayed: true };
    }
  }
  if (mode === 'live') {
    const { data: running, error: runningError } = await comms(db).from('plans').select('id').eq('message_id', message.id).eq('mode', 'live')
      .eq('status', 'applying').gte('created_at', new Date(Date.now() - APPLYING_GRACE_MS).toISOString()).limit(1);
    if (runningError) throw runningError;
    if ((running ?? []).length) {
      throw new PlanError(409, 'CONFLICT', 'A plan for this message is still being applied', { reason: 'plan_in_progress', plan_id: (running as Row[])[0].id });
    }
  }

  const facts = await messageFacts(db, message.id);
  const prepared = await prepare(actor, message, facts, body);
  const { data: plan, error: planError } = await comms(db).from('plans').insert({
    message_id: message.id,
    conversation_id: message.thread_id,
    member_id: actor.memberId,
    mode,
    status: mode === 'shadow' ? 'applied' : 'applying',
    summary: body.summary,
    thread_summary: body.thread_summary ?? null,
    urgent: body.urgent,
    suspicious: body.suspicious,
    flags: body.flags,
    idempotency_key: key,
    request_hash: key ? hash : null,
  }).select('id').single();
  if (planError) {
    // A concurrent retry with the same key stored it first: that request applies it.
    if ((planError as { code?: string }).code === '23505' && key) {
      const { data: winner } = await comms(db).from('plans').select('id').eq('message_id', message.id).eq('mode', mode).eq('idempotency_key', key).single();
      return { ...(await readPlan(db, (winner as Row).id as string)), replayed: true };
    }
    throw planError;
  }
  const planId = (plan as { id: string }).id;
  const { error: itemsError } = await comms(db).from('plan_items').insert(prepared.map((p, position) => ({
    plan_id: planId,
    position,
    conversation_id: message.thread_id,
    mode,
    type: p.item.type,
    intent: p.item.intent,
    project_id: p.projectId,
    task_id: p.taskId,
    addressee: p.item.addressee,
    addressee_member_id: p.item.addressee_member_id ?? null,
    payload: p.item,
    evidence: p.item.evidence ?? null,
    confidence: p.item.confidence,
    decision: p.decision,
    decision_reason: p.reason,
    // An applied question waits for its answer.
    state: mode === 'shadow' ? 'skipped' : p.item.type === 'ask' && p.decision !== 'reject' ? 'pending' : STATE_OF[p.decision],
  })));
  if (itemsError) {
    await comms(db).from('plans').delete().eq('id', planId);
    // A second open question on this conversation.
    if ((itemsError as { code?: string }).code === '23505') {
      throw unprocessable('A question is already waiting on this conversation: apply your default instead.', { reason: 'question_already_open' });
    }
    throw itemsError;
  }
  if (mode === 'live') await finishLive(actor, message, planId, body, agentName);
  return readPlan(db, planId);
}

/** Applies a live plan's items, records its triage and notifies; safe to run again on a partial plan. */
async function finishLive(actor: PlanActor, message: PlanMessage, planId: string, body: PlanRequest, agentName: string): Promise<void> {
  const { db } = actor;
  await applyPending(actor, message, planId);
  const { items } = await readPlan(db, planId);
  const failed = items.some((i) => i.state === 'failed');

  const { data: planRow } = await comms(db).from('plans').select('triage_id').eq('id', planId).single();
  if (!(planRow as Row | null)?.triage_id) {
    const shape = triageOf(body, items);
    const links = items.filter((i) => i.state === 'done' && i.task_id).map((i) => ({
      task_id: i.task_id as string,
      relation: i.type === 'create_task' ? 'created' : i.type === 'link_task' ? ((i.payload as Row).relation as string) : 'updated',
    }));
    const projectIds = [...new Set(items.filter((i) => i.state === 'done' && i.project_id && ['create_task', 'file_project'].includes(i.type as string)).map((i) => i.project_id as string))];
    const { data, error } = await comms(db).rpc('record_triage', {
      p_message_id: message.id,
      p_member_id: actor.memberId,
      p_triage: shape.triage,
      p_links: links,
      p_project_ids: projectIds,
      p_status: shape.status,
      p_idempotency_key: `plan:${planId}`,
      p_request_hash: planId,
    });
    if (error) throw error;
    const triageId = ((data as { triage: { id: string } }).triage).id;
    const [{ error: planUpdate }, { error: triageUpdate }] = await Promise.all([
      comms(db).from('plans').update({ triage_id: triageId, status: failed ? 'partial' : 'applied' }).eq('id', planId),
      comms(db).from('triage').update({ plan_id: planId }).eq('id', triageId),
    ]);
    if (planUpdate) throw planUpdate;
    if (triageUpdate) throw triageUpdate;
  } else {
    const { error } = await comms(db).from('plans').update({ status: failed ? 'partial' : 'applied' }).eq('id', planId);
    if (error) throw error;
  }
  await syncWaitingNotification(db, message, agentName);
}

// ---------------------------------------------------------------------------
// A person resolves a proposal, or undoes
// ---------------------------------------------------------------------------

export async function loadPlanItem(db: SupabaseClient, itemId: string): Promise<{ item: Row; message: PlanMessage }> {
  const { data, error } = await comms(db).from('plan_items').select('*, plan:plans!inner(message_id)').eq('id', itemId).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Plan item');
  const row = data as unknown as Row & { plan: { message_id: string } };
  const { data: message, error: messageError } = await comms(db).from('messages').select('id, thread_id, inbox_id, subject').eq('id', row.plan.message_id).single();
  if (messageError) throw messageError;
  return { item: row, message: message as PlanMessage };
}

/** What a proposal touches (its project, its task's project, a reminder) must be in the person's reach. */
async function assertCanReach(actor: PlanActor, item: PlanItemRequest): Promise<void> {
  const denied = () => new PlanError(403, 'FORBIDDEN', 'You cannot open what this would change');
  const taskId = itemTaskId(item);
  const tasks = await loadTasks(actor.db, taskId ? [taskId] : []);
  if (taskId) {
    const task = tasks.get(taskId);
    if (!task) throw new PlanError(404, 'NOT_FOUND', 'That task no longer exists');
    if (!accessAllowsProject(actor.access, task.project_id, actor.channel)) throw denied();
  }
  const projectId = itemProject(item, tasks);
  if (projectId && !accessAllowsProject(actor.access, projectId, actor.channel)) throw denied();
  if ('reminder_id' in item) {
    const { data: reminder } = await actor.db.from('reminders').select('owner_id, created_by, project_id').eq('id', item.reminder_id).is('deleted_at', null).maybeSingle();
    const row = reminder as { owner_id: string; created_by: string | null; project_id: string | null } | null;
    if (!row) throw new PlanError(404, 'NOT_FOUND', 'That reminder no longer exists');
    const reach = row.owner_id === actor.memberId || row.created_by === actor.memberId || (!!row.project_id && accessAllowsProject(actor.access, row.project_id, actor.channel));
    if (!reach) throw denied();
  }
}

/** A person accepts a proposal (optionally edited): applied as theirs. */
export async function acceptItem(actor: PlanActor, itemId: string, edits: Partial<PlanItemRequest> = {}, agentName = ''): Promise<Row> {
  const { item, message } = await loadPlanItem(actor.db, itemId);
  if (item.state !== 'pending' || item.type === 'ask') throw new PlanError(409, 'CONFLICT', 'Only a waiting proposal can be accepted', { reason: 'not_pending', state: item.state });
  const payload = { ...(item.payload as Row), ...edits } as PlanItemRequest;
  await assertCanReach(actor, payload);
  const result = await applyItem({ ...actor, asPerson: true }, message, payload, item);
  const { error } = await comms(actor.db).from('plan_items').update({
    state: 'accepted', result, payload, error: null, task_id: (result.task_id as string | undefined) ?? (item.task_id as string | null) ?? null,
    resolved_by: actor.memberId, resolved_at: new Date().toISOString(),
  }).eq('id', itemId);
  if (error) throw error;
  await syncWaitingNotification(actor.db, message, agentName);
  return result;
}

export async function dismissItem(actor: PlanActor, itemId: string, agentName = ''): Promise<void> {
  const { item, message } = await loadPlanItem(actor.db, itemId);
  if (item.state !== 'pending') throw new PlanError(409, 'CONFLICT', 'Only a waiting proposal can be dismissed', { reason: 'not_pending', state: item.state });
  const { error } = await comms(actor.db).from('plan_items').update({ state: 'dismissed', resolved_by: actor.memberId, resolved_at: new Date().toISOString() }).eq('id', itemId);
  if (error) throw error;
  await syncWaitingNotification(actor.db, message, agentName);
}

/** Undoes every applied item of a plan, newest first. */
export async function undoPlan(actor: PlanActor, planId: string): Promise<Row[]> {
  const { data, error } = await comms(actor.db).from('plan_items').select('id').eq('plan_id', planId).in('state', ['done', 'accepted']).order('position', { ascending: false });
  if (error) throw error;
  const results: Row[] = [];
  for (const row of (data ?? []) as { id: string }[]) results.push({ id: row.id, ...(await undoItem(actor, row.id)) });
  const { error: planError } = await comms(actor.db).from('plans').update({ status: 'undone' }).eq('id', planId);
  if (planError) throw planError;
  return results;
}
