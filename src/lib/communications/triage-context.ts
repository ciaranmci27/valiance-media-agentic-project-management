/**
 * What a triage agent reads before planning a message, in one call: the
 * message as the agent API shows it, who is speaking and how it reached us,
 * what earlier plans on the conversation did, what is still owed or asked,
 * and each project in scope with its open tasks and recent plan items (from
 * any conversation, so a request sent twice becomes one task).
 *
 * In shadow mode the bundle leaves out what this message itself already
 * caused (the old triage ran first): its task links and the tasks they
 * created, the projects it filed, its reminders and its triage. The scope
 * itself is still the database's, which may include a project the old
 * triage filed from this message.
 *
 * Also here: the queue a triage job works through, and the plan counts the
 * signal adds for the dispatcher.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { comms } from './db';
import { messageDetail } from './agent-read';
import { messageFacts } from './speaker';
import type { AccessibleMessage } from './agent-access';

type Row = Record<string, unknown>;

/** A conversation is planned once it has been quiet this long (bursts, corrections, edits). */
export const QUIET_MINUTES = 3;
/** Machine mail about these topics skips the wait. */
const URGENT_TOPICS = ['account_risk', 'security'];
const OPEN_TASKS_PER_PROJECT = 40;
const RECENT_DAYS = 14;

async function rows<T = Row>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

export async function triageContext(supabase: SupabaseClient, message: AccessibleMessage, mode: 'live' | 'shadow'): Promise<Row> {
  const [detail, facts] = await Promise.all([messageDetail(supabase, message), messageFacts(supabase, message.id)]);
  const conversationId = message.thread_id;

  // What this message caused, left out in shadow mode.
  const ownLinks = mode === 'shadow'
    ? await rows<{ task_id: string; relation: string }>(comms(supabase).from('task_links').select('task_id, relation').eq('message_id', message.id))
    : [];
  const ownFiled = mode === 'shadow'
    ? new Set((await rows<{ project_id: string }>(comms(supabase).from('conversation_projects').select('project_id').eq('message_id', message.id))).map((r) => r.project_id))
    : new Set<string>();
  const ownCreated = new Set(ownLinks.filter((l) => l.relation === 'created').map((l) => l.task_id));

  const [conversation, plans, points, reminders] = await Promise.all([
    rows<Row>(comms(supabase).from('conversations').select('muted_at').eq('id', conversationId)),
    rows<Row>(comms(supabase).from('plans').select('id, message_id, mode, status, summary, created_at').eq('conversation_id', conversationId).eq('mode', 'live').order('created_at')),
    rows<Row>(comms(supabase).from('reply_points').select('id, who, what, kind, project_id, by_when, urgent, to_agent, created_at').eq('conversation_id', conversationId).eq('state', 'open').order('created_at')),
    rows<Row>(supabase.from('reminders').select('id, title, remind_on, status, task_id, project_id, source_message_id')
      .eq('status', 'open').is('deleted_at', null)
      .in('source_message_id', ((detail.thread as Row).messages as Row[]).map((m) => m.id as string))),
  ]);
  const planItems = plans.length
    ? await rows<Row>(comms(supabase).from('plan_items').select('id, plan_id, type, intent, project_id, task_id, decision, state, payload, resolved_by')
      .in('plan_id', plans.map((p) => p.id as string)).order('position'))
    : [];

  // Projects in reach: the scope's, and the conversation's.
  const scope = (detail.project_scope ?? {}) as { projects?: { project_id: string }[] };
  const projectIds = [...new Set([
    ...(scope.projects ?? []).map((p) => p.project_id),
    ...((detail.projects ?? []) as { id: string }[]).map((p) => p.id),
  ])].filter((id) => !ownFiled.has(id) || (scope.projects ?? []).some((p) => p.project_id === id));
  const [projectRows, taskRows, recentItems] = projectIds.length ? await Promise.all([
    rows<Row>(supabase.from('projects').select('id, name, status, archived_at').in('id', projectIds).is('deleted_at', null)),
    rows<Row>(supabase.from('tasks').select('id, project_id, title, status, due_date, priority, updated_at, created_by')
      .in('project_id', projectIds).is('deleted_at', null).neq('status', 'done').order('updated_at', { ascending: false }).limit(OPEN_TASKS_PER_PROJECT * projectIds.length)),
    rows<Row>(comms(supabase).from('plan_items').select('id, type, intent, project_id, task_id, state, payload, conversation_id, created_at')
      .in('project_id', projectIds).eq('mode', 'live').in('state', ['done', 'accepted', 'pending'])
      .gte('created_at', new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString()).order('created_at', { ascending: false }).limit(100)),
  ]) : [[], [], []];

  const brief = (item: Row) => ({
    // What a revert_item names.
    id: item.id,
    type: item.type,
    intent: item.intent,
    project_id: item.project_id,
    task_id: item.task_id,
    state: item.state,
    title: ((item.payload ?? {}) as Row).title ?? ((item.payload ?? {}) as Row).what ?? ((item.payload ?? {}) as Row).question ?? null,
  });
  const current = { ...detail } as Row;
  if (mode === 'shadow') {
    current.linked_tasks = [];
    current.latest_triage = null;
    current.projects = ((detail.projects ?? []) as { id: string }[]).filter((p) => !ownFiled.has(p.id));
  }

  return {
    message: current,
    // Who is speaking and how it reached us, as the app worked it out.
    speaker: facts.speaker,
    trust: facts.trust,
    delivery: facts.delivery,
    addressed_to_agent: facts.addressedToAshley,
    owner_forward_without_note: facts.ownerForwardWithoutNote ?? false,
    conversation: {
      id: conversationId,
      muted: !!conversation[0]?.muted_at,
      // What earlier plans on it did, oldest first.
      plans: plans.filter((p) => p.message_id !== message.id || mode === 'live').map((p) => ({
        id: p.id,
        message_id: p.message_id,
        summary: p.summary,
        created_at: p.created_at,
        items: planItems.filter((i) => i.plan_id === p.id).map(brief),
      })),
      reply_owed: points,
      open_question: planItems.find((i) => i.type === 'ask' && i.state === 'pending') ? brief(planItems.find((i) => i.type === 'ask' && i.state === 'pending')!) : null,
      reminders: reminders.filter((r) => mode === 'live' || r.source_message_id !== message.id),
    },
    projects: projectRows.map((project) => ({
      id: project.id,
      name: project.name,
      status: project.archived_at ? 'archived' : project.status,
      open_tasks: taskRows.filter((t) => t.project_id === project.id && !ownCreated.has(t.id as string)).slice(0, OPEN_TASKS_PER_PROJECT)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, due_date: t.due_date, priority: t.priority, updated_at: t.updated_at })),
      // What triage did on it lately, from any conversation and channel.
      recent: recentItems.filter((i) => i.project_id === project.id && (mode === 'live' || i.conversation_id !== conversationId || !ownCreated.has(i.task_id as string)))
        .slice(0, 20).map((i) => ({ ...brief(i), conversation_id: i.conversation_id, created_at: i.created_at })),
    })),
  };
}

/** Inboxes by triage mode, among those given. */
export async function inboxModes(supabase: SupabaseClient, inboxIds: string[]): Promise<Map<string, string>> {
  if (!inboxIds.length) return new Map();
  const found = await rows<{ id: string; triage_mode: string }>(comms(supabase).from('inboxes').select('id, triage_mode').in('id', inboxIds));
  return new Map(found.map((row) => [row.id, row.triage_mode]));
}

/**
 * What a triage job works through, oldest first. plans: new messages in plan
 * inboxes whose conversation has been quiet for QUIET_MINUTES (urgent machine
 * mail at once), in conversations nobody muted. shadow: messages in shadow
 * inboxes the old triage already handled, with no shadow plan yet, from the
 * last 14 days.
 */
export async function triageQueue(supabase: SupabaseClient, inboxIds: string[], mode: 'plans' | 'shadow', limit = 50): Promise<Row[]> {
  const modes = await inboxModes(supabase, inboxIds);
  const wanted = inboxIds.filter((id) => modes.get(id) === mode);
  if (!wanted.length) return [];
  if (mode === 'plans') {
    // Muted conversations are left out in the query, so they never fill the window.
    const muted = (await rows<{ id: string }>(comms(supabase).from('conversations').select('id').in('inbox_id', wanted).not('muted_at', 'is', null))).map((c) => c.id);
    let query = comms(supabase).from('messages').select('id, inbox_id, thread_id, subject, received_at, kind, topic')
      .in('inbox_id', wanted).eq('status', 'new');
    if (muted.length) query = query.not('thread_id', 'in', `(${muted.join(',')})`);
    const candidates = await rows<Row>(query.order('received_at').limit(limit * 3));
    if (!candidates.length) return [];
    const conversations = await rows<{ id: string; last_message_at: string | null; muted_at: string | null }>(comms(supabase).from('conversations')
      .select('id, last_message_at, muted_at').in('id', [...new Set(candidates.map((m) => m.thread_id as string))]));
    const byId = new Map(conversations.map((c) => [c.id, c]));
    const quietBefore = Date.now() - QUIET_MINUTES * 60_000;
    return candidates.filter((m) => {
      const conversation = byId.get(m.thread_id as string);
      if (!conversation || conversation.muted_at) return false;
      const urgent = m.kind === 'notification' && URGENT_TOPICS.includes(m.topic as string);
      return urgent || !conversation.last_message_at || Date.parse(conversation.last_message_at) <= quietBefore;
    }).slice(0, limit).map((m) => ({ id: m.id, inbox_id: m.inbox_id, conversation_id: m.thread_id, subject: m.subject, received_at: m.received_at }));
  }
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  // What shadow already planned is left out in the query, so the window never fills with it.
  const planned = [...new Set((await rows<{ message_id: string }>(comms(supabase).from('plans').select('message_id')
    .eq('mode', 'shadow').gte('created_at', since))).map((p) => p.message_id))];
  let query = comms(supabase).from('messages').select('id, inbox_id, thread_id, subject, received_at')
    .in('inbox_id', wanted).in('status', ['handled', 'needs_human']).gte('received_at', since);
  if (planned.length) query = query.not('id', 'in', `(${planned.join(',')})`);
  const handled = await rows<Row>(query.order('received_at').limit(limit));
  return handled
    .map((m) => ({ id: m.id, inbox_id: m.inbox_id, conversation_id: m.thread_id, subject: m.subject, received_at: m.received_at }));
}

/** The plan counts the signal adds: ready new messages in plan inboxes, and shadow work waiting. */
export async function planSignal(supabase: SupabaseClient, inboxIds: string[]): Promise<{ plans_new_count: number; shadow_pending_count: number }> {
  const [ready, shadow] = await Promise.all([triageQueue(supabase, inboxIds, 'plans', 200), triageQueue(supabase, inboxIds, 'shadow', 200)]);
  return { plans_new_count: ready.length, shadow_pending_count: shadow.length };
}
