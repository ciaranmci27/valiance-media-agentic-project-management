/**
 * Everything the agent did with an email or a meeting, taken back in one go
 * ("Undo all") and put back the same way ("Restore all"). The agent often
 * misreads a message and makes several tasks and reminders from it; a person
 * should not have to wave each off.
 *
 * - A message with a live plan is the plan's: its applied items are undone
 *   through the plan's own undo (a task a person changed since stays).
 * - An older message (triaged before plans) is undone from what it left:
 *   tasks the agent created go to Trash (one already done stays), reminders
 *   the agent set go to Trash (one already done stays), and the agent's
 *   other links to existing tasks are removed. Edits the agent made to an
 *   existing task were never recorded, so they stay; the link goes.
 *
 * Undo returns exactly what it changed. Restore takes that receipt and puts
 * back only what belongs to this conversation.
 */
import { hasPermission } from '@/lib/access-control';
import { accessAllowsProject } from '@/lib/api/access';
import { moveToTrash, restoreFromTrash } from '@/lib/supabase/trash';
import { comms } from './db';
import { assertCanTriage, assertId, InboxError, loadReadableThread, many, type InboxContext } from './inbox-service';
import { restorePlanItem, undoWholePlan } from './inbox-plans';
import type { AgentWorkUndo } from './inbox-types';

type Row = Record<string, unknown>;

export interface AgentWorkScope {
  /** The messages to undo; every message of the conversation when null. */
  message_ids: string[] | null;
  /** Only the agent's links to this task (an older message's row action). */
  task_id: string | null;
}

async function threadMessages(ctx: InboxContext, threadId: string): Promise<Set<string>> {
  const rows = await many<{ id: string }>(comms(ctx.service).from('messages').select('id').eq('thread_id', threadId).neq('status', 'receiving'));
  return new Set(rows.map((row) => row.id));
}

async function agentIds(ctx: InboxContext): Promise<Set<string>> {
  const rows = await many<{ id: string }>(ctx.service.from('team_members').select('id').eq('role', 'agent'));
  return new Set(rows.map((row) => row.id));
}

function titleOf(payload: unknown): string {
  const row = (payload as Row | null) ?? {};
  for (const key of ['title', 'what', 'text']) {
    const value = row[key];
    if (typeof value === 'string' && value) return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  return 'A change';
}

export async function undoAgentWork(ctx: InboxContext, threadId: string, scope: AgentWorkScope): Promise<AgentWorkUndo> {
  assertCanTriage(ctx.access);
  const thread = await loadReadableThread(ctx, threadId);
  const inThread = await threadMessages(ctx, thread.id);
  const ids = scope.message_ids ? [...new Set(scope.message_ids.map((id) => assertId(id, 'message id')))] : [...inThread];
  if (ids.some((id) => !inThread.has(id))) throw new InboxError(422, 'Those emails are not in this conversation');
  const taskId = scope.task_id ? assertId(scope.task_id, 'task id') : null;
  const undo: AgentWorkUndo = { plan_items: [], tasks: [], reminders: [], links: [], kept: [] };
  if (!ids.length) return undo;

  // A message with a live plan is the plan's; only its newest plan shows.
  const plans = await many<{ id: string; message_id: string }>(comms(ctx.service).from('plans')
    .select('id, message_id').in('message_id', ids).eq('mode', 'live').order('created_at', { ascending: false }));
  const newest = new Map<string, string>();
  for (const plan of plans) if (!newest.has(plan.message_id)) newest.set(plan.message_id, plan.id);
  if (!taskId) {
    for (const planId of newest.values()) {
      const { items } = await undoWholePlan(ctx, planId);
      undo.plan_items.push(...items.filter((item) => item.undone).map((item) => item.id as string));
      const changed = items.filter((item) => item.changed_since).map((item) => item.id as string);
      if (changed.length) {
        const rows = await many<{ payload: unknown }>(comms(ctx.service).from('plan_items').select('payload').in('id', changed));
        undo.kept.push(...rows.map((row) => ({ label: titleOf(row.payload), reason: 'changed since, so it stays' })));
      }
    }
  }

  const older = ids.filter((id) => !newest.has(id));
  if (!older.length) return undo;
  const agents = await agentIds(ctx);
  // Binning a task takes what the row's "Not a task" takes.
  const canBinTasks = hasPermission(ctx.access, 'tasks.manage_all') || hasPermission(ctx.access, 'tasks.manage_assigned');

  let linkQuery = comms(ctx.service).from('task_links').select('message_id, task_id, relation, triage_id, linked_by')
    .in('message_id', older).not('triage_id', 'is', null);
  if (taskId) linkQuery = linkQuery.eq('task_id', taskId);
  const links = await many<AgentWorkUndo['links'][number]>(linkQuery);
  const taskIds = [...new Set(links.map((link) => link.task_id))];
  const tasks = new Map((taskIds.length
    ? await many<{ id: string; title: string; project_id: string; status: string; created_by: string | null }>(ctx.service.from('tasks')
        .select('id, title, project_id, status, created_by').in('id', taskIds).is('deleted_at', null))
    : []).map((task) => [task.id, task]));
  const trashed = new Set<string>();
  for (const link of links) {
    const task = tasks.get(link.task_id);
    // Already in Trash (waved off one by one, say): nothing left to take back.
    if (!task) continue;
    if (!accessAllowsProject(ctx.access, task.project_id)) {
      undo.kept.push({ label: 'A task in another project', reason: 'out of your reach, so it stays' });
      continue;
    }
    if (link.relation === 'created' && task.created_by && agents.has(task.created_by)) {
      if (task.status === 'done') {
        undo.kept.push({ label: task.title, reason: 'already done, so it stays' });
      } else if (!canBinTasks) {
        undo.kept.push({ label: task.title, reason: 'you cannot move tasks to Trash, so it stays' });
      } else if (!trashed.has(task.id)) {
        trashed.add(task.id);
        await moveToTrash(ctx.service, 'tasks', task.id, ctx.memberId);
        undo.tasks.push(task.id);
      }
      continue;
    }
    const { error } = await comms(ctx.service).from('task_links').delete()
      .eq('message_id', link.message_id).eq('task_id', link.task_id).eq('relation', link.relation);
    if (error) throw error;
    undo.links.push(link);
    if (link.relation === 'updated') undo.kept.push({ label: task.title, reason: 'its edits stay, only the link is removed' });
  }

  if (!taskId) {
    const reminders = await many<{ id: string; title: string; status: string; created_by: string | null }>(ctx.service.from('reminders')
      .select('id, title, status, created_by').in('source_message_id', older).is('deleted_at', null));
    for (const reminder of reminders) {
      // A person's own reminder from this email is theirs, not the agent's.
      if (!reminder.created_by || !agents.has(reminder.created_by)) continue;
      if (reminder.status === 'done') {
        undo.kept.push({ label: reminder.title, reason: 'already done, so it stays' });
        continue;
      }
      await moveToTrash(ctx.service, 'reminders', reminder.id, ctx.memberId);
      undo.reminders.push(reminder.id);
    }
  }
  return undo;
}

/** Restore all: what one Undo all took back, put back, as long as it belongs to this conversation. */
export async function restoreAgentWork(ctx: InboxContext, threadId: string, undo: Omit<AgentWorkUndo, 'kept'>): Promise<{ restored: number; kept: AgentWorkUndo['kept'] }> {
  assertCanTriage(ctx.access);
  const thread = await loadReadableThread(ctx, threadId);
  const inThread = [...await threadMessages(ctx, thread.id)];
  const itemIds = [...new Set(undo.plan_items)].map((id) => assertId(id, 'item id'));
  const taskIds = [...new Set(undo.tasks)].map((id) => assertId(id, 'task id'));
  const reminderIds = [...new Set(undo.reminders)].map((id) => assertId(id, 'reminder id'));
  const links = undo.links.map((link) => ({ ...link, message_id: assertId(link.message_id, 'message id'), task_id: assertId(link.task_id, 'task id') }));

  // Everything must be this conversation's before anything changes.
  const items = itemIds.length
    ? await many<{ id: string; plan_id: string; payload: unknown; state: string }>(comms(ctx.service).from('plan_items').select('id, plan_id, payload, state').in('id', itemIds).eq('conversation_id', thread.id))
    : [];
  const created = taskIds.length && inThread.length
    ? await many<{ task_id: string }>(comms(ctx.service).from('task_links').select('task_id').in('task_id', taskIds).in('message_id', inThread).eq('relation', 'created'))
    : [];
  const taskRows = taskIds.length
    // includes-deleted: the tasks to restore are in Trash
    ? await many<{ id: string; project_id: string }>(ctx.service.from('tasks').select('id, project_id').in('id', taskIds))
    : [];
  const reminders = reminderIds.length && inThread.length
    // includes-deleted: the reminders to restore are in Trash
    ? await many<{ id: string; created_by: string | null }>(ctx.service.from('reminders').select('id, created_by').in('id', reminderIds).in('source_message_id', inThread))
    : [];
  // Only the agent's reminders: Undo all never takes a person's own, so Restore all never brings one back.
  const agents = reminders.length ? await agentIds(ctx) : new Set<string>();
  const linkTasks = links.length
    ? await many<{ id: string; project_id: string }>(ctx.service.from('tasks').select('id, project_id').in('id', [...new Set(links.map((l) => l.task_id))]).is('deleted_at', null))
    : [];
  const createdIds = new Set(created.map((row) => row.task_id));
  if (items.length !== itemIds.length || taskIds.some((id) => !createdIds.has(id))
    || reminders.length !== reminderIds.length || reminders.some((r) => !r.created_by || !agents.has(r.created_by))
    || links.some((link) => !inThread.includes(link.message_id))) {
    throw new InboxError(422, 'Some of that is not on this conversation');
  }
  const reachable = (rows: { id: string; project_id: string }[], id: string) => {
    const row = rows.find((r) => r.id === id);
    return !!row && accessAllowsProject(ctx.access, row.project_id);
  };

  let restored = 0;
  const kept: AgentWorkUndo['kept'] = [];
  for (const id of taskIds) {
    if (!reachable(taskRows, id)) continue;
    if (await restoreFromTrash(ctx.service, 'tasks', id, ctx.memberId)) restored++;
  }
  for (const id of reminderIds) {
    if (await restoreFromTrash(ctx.service, 'reminders', id, ctx.memberId)) restored++;
  }
  for (const link of links) {
    // A task gone to Trash since cannot be tied again.
    if (!reachable(linkTasks, link.task_id)) continue;
    const { error } = await comms(ctx.service).from('task_links')
      .insert({ message_id: link.message_id, task_id: link.task_id, relation: link.relation, triage_id: link.triage_id, linked_by: link.linked_by });
    // Tied again meanwhile (restored on its own, or a second Restore): already as it should be.
    if (!error) restored++;
    else if ((error as { code?: string }).code !== '23505') throw error;
  }
  // One already put back on its own is left as it is.
  for (const item of [...items].reverse().filter((row) => row.state === 'undone')) {
    try {
      await restorePlanItem(ctx, item.id);
      restored++;
    } catch (error) {
      if (!(error instanceof InboxError) || error.status !== 409) throw error;
      kept.push({ label: titleOf(item.payload), reason: error.message });
    }
  }
  const planIds = [...new Set(items.map((item) => item.plan_id))];
  if (planIds.length) {
    const { error } = await comms(ctx.service).from('plans').update({ status: 'applied' }).in('id', planIds).eq('status', 'undone');
    if (error) throw error;
  }
  return { restored, kept };
}
