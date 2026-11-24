import type { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled, type AccessContext } from '@/lib/access-control';
import { formatEventTitle } from '@/lib/agent-events';
import {
  APPROVAL_CHOICES, approvalDecision, effectiveQuestionStatus, textAnswers, type AnswerQuestionInput, type ApprovalAction,
  type AskQuestionInput, type QuestionKind, type QuestionStatus, type QuestionView, type RequestApprovalInput,
} from '@/lib/questions';
import { accessAllows, accessAllowsProject } from './access';
import { afterResponse } from './after-response';
import { escalationRecipient } from './agent-rules';
import { activeGroupMembers, groupNames, groupsMigrationPending, liveGroup, missingGroupsSchema } from './groups';
import { ApiError, badRequest, forbidden, notFound } from './errors';
import { postgrestList, trashedProjectIds } from '@/lib/supabase/trash';

/**
 * Questions for the API (v1, MCP) and the app's session routes: one member
 * asks another and gets the answer back. Routes run on the service role, so
 * the visibility the database gives a signed-in member is enforced here:
 * a member sees the questions they asked, the ones they were asked, and the
 * ones on a task or project they can open (never one whose task or project
 * is in Trash). The asked member, the Owner, or someone who may manage the
 * team answers; the asker or those managers cancel. An approval (kind
 * 'approval') is decided only by the member asked, who is always a person,
 * or the Owner: managing the team is not a say over a deploy or a spend.
 *
 * A question can be asked to a group instead (asked_to_group): every member
 * of it is a party (they see it, and their bells ring), and any member may
 * answer it (answered_by says who). An approval asked to a group is decided
 * by any person in it, never an agent in it.
 *
 * Expiry needs no job: an open question past expires_at reads as expired,
 * and every list or change stores that first (which clears its bell).
 */

export interface QuestionsContext {
  db: SupabaseClient;
  access: AccessContext;
  memberId: string;
  channel: 'api' | 'app';
  /** The API key's scopes (api channel); the app channel has none. */
  scopes?: string[];
}

const SELECT = '*';

interface QuestionRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  asked_by: string;
  /** Null when the question is asked to a group (asked_to_group). */
  asked_to: string | null;
  asked_to_group?: string | null;
  /** The person an agent asked it for (X-Act-For). */
  principal_id?: string | null;
  question: string;
  choices: string[] | null;
  allow_other: boolean;
  status: string;
  answer_choice: string | null;
  answer_text: string | null;
  answered_by: string | null;
  answered_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** question or approval; missing on a database before 20261124000600 (a question). */
  kind?: string;
  action?: ApprovalAction | null;
  /** Filled by withPlaces: the live task and project it hangs on. */
  task?: { title: string } | null;
  project?: { name: string } | null;
  /** False when its task or project is in Trash (withPlaces). */
  place_live?: boolean;
  /** The reader may open its task or project (withPlaces); true for a question on nothing. */
  can_open_place?: boolean;
  /** Asked to the reader, by name or through a group they are in (withPlaces). */
  to_reader?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (message: string, details?: Record<string, unknown>) => new ApiError(422, 'VALIDATION_ERROR', message, details);

/** A database that does not have the questions table yet (new code before its migration). */
export const missingQuestionsTable = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42P01' || error.code === 'PGRST205' || /questions.*(does not exist|schema cache)/i.test(error.message ?? ''));

/** The Owner, or a member who may manage the team (on the key too, over the API). */
function canManage(ctx: QuestionsContext): boolean {
  if (ctx.access.role === 'owner') return true;
  if (!accessAllows(ctx.access, 'team.manage', ctx.channel)) return false;
  return ctx.channel === 'app' || (ctx.scopes ?? []).includes('team.manage');
}

/**
 * Which tasks the reader may read, by the rule the database uses for a
 * signed-in member (pm.can_read_task_row): tasks.read reads every task in the
 * projects they can open; tasks.read_assigned only the tasks assigned to them
 * or created by them, the subtasks of those, and the parents of those. A key
 * that may manage every task reads them all too. `readable` is null when the
 * reader reads every task (or none: `full` false and an empty set).
 */
interface TaskReader {
  full: boolean;
  readable: Set<string> | null;
}

const readers = new WeakMap<QuestionsContext, Promise<TaskReader>>();

/** `.in()` on a long id list, in chunks so the URL stays short. */
async function inChunks<T>(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await read(ids.slice(i, i + 100));
    if (error) throw error;
    out.push(...(data ?? []));
  }
  return out;
}

async function loadTaskReader(ctx: QuestionsContext): Promise<TaskReader> {
  if (accessAllows(ctx.access, 'tasks.read', ctx.channel) || accessAllows(ctx.access, 'tasks.manage_all', ctx.channel)) {
    return { full: true, readable: null };
  }
  if (!accessAllows(ctx.access, 'tasks.read_assigned', ctx.channel)) return { full: false, readable: new Set() };
  const [assigned, created] = await Promise.all([
    ctx.db.from('task_assignees').select('task_id').eq('member_id', ctx.memberId),
    ctx.db.from('tasks').select('id').eq('created_by', ctx.memberId).is('deleted_at', null),
  ]);
  if (assigned.error) throw assigned.error;
  if (created.error) throw created.error;
  const own = [...new Set([
    ...((assigned.data ?? []) as { task_id: string }[]).map((row) => row.task_id),
    ...((created.data ?? []) as { id: string }[]).map((row) => row.id),
  ])];
  const live = await inChunks<{ id: string; parent_task_id: string | null }>(own, (chunk) =>
    ctx.db.from('tasks').select('id, parent_task_id').in('id', chunk).is('deleted_at', null));
  const liveIds = live.map((row) => row.id);
  const children = await inChunks<{ id: string }>(liveIds, (chunk) =>
    ctx.db.from('tasks').select('id').in('parent_task_id', chunk).is('deleted_at', null));
  return {
    full: false,
    readable: new Set([
      ...liveIds,
      ...live.map((row) => row.parent_task_id).filter((id): id is string => !!id),
      ...children.map((row) => row.id),
    ]),
  };
}

const memberGroups = new WeakMap<QuestionsContext, Promise<Set<string>>>();

/**
 * The groups the reader is in, read once per request: a question asked to one
 * of them is theirs. Groups in Trash count, so a question asked before its
 * group went there can still be answered.
 */
function readerGroups(ctx: QuestionsContext): Promise<Set<string>> {
  let groups = memberGroups.get(ctx);
  if (!groups) {
    groups = Promise.resolve(ctx.db.from('group_members').select('group_id').eq('member_id', ctx.memberId)).then(({ data, error }) => {
      if (missingGroupsSchema(error)) return new Set<string>();
      if (error) throw error;
      return new Set(((data ?? []) as { group_id: string }[]).map((row) => row.group_id));
    });
    memberGroups.set(ctx, groups);
  }
  return groups;
}

/** Asked to the reader: by name, or to a group they are in. */
const askedToReader = (ctx: QuestionsContext, groups: Set<string>, row: Pick<QuestionRow, 'asked_to' | 'asked_to_group'>) =>
  row.asked_to === ctx.memberId || (!!row.asked_to_group && groups.has(row.asked_to_group));

/** The reader's task rule, read once per request. */
function taskReader(ctx: QuestionsContext): Promise<TaskReader> {
  let reader = readers.get(ctx);
  if (!reader) {
    reader = loadTaskReader(ctx);
    readers.set(ctx, reader);
  }
  return reader;
}

/** Whether the reader may open the task (or project) a question hangs on. */
function canOpenPlace(ctx: QuestionsContext, reader: TaskReader, place: { task_id: string | null; project_id: string | null }): boolean {
  if (place.task_id) {
    return !!place.project_id && accessAllowsProject(ctx.access, place.project_id, ctx.channel)
      && (reader.full || !!reader.readable?.has(place.task_id));
  }
  if (place.project_id) return accessAllowsProject(ctx.access, place.project_id, ctx.channel);
  return true;
}

/**
 * Who sees a question: whoever asked it, whoever was asked, and anyone who
 * may read its task (or open its project, for one on a project). One on
 * nothing is only its two members'.
 */
function canSee(ctx: QuestionsContext, row: QuestionRow): boolean {
  if (row.deleted_at || row.place_live === false) return false;
  const party = row.asked_by === ctx.memberId || row.asked_to === ctx.memberId || row.to_reader === true;
  return (party && partyInReach(ctx, row))
    || ((!!row.task_id || !!row.project_id) && row.can_open_place === true);
}

/**
 * Acting for a person (X-Act-For), being a party to a question (asking it,
 * being asked, a group of the agent's) is no reach of the person's: it
 * counts only on a project the person and the agent both reach, or, on a
 * question on nothing, one the agent asked for this same person. Without a
 * principal every party counts, as before.
 */
function partyInReach(ctx: QuestionsContext, row: Pick<QuestionRow, 'project_id' | 'principal_id'>): boolean {
  const principal = ctx.access.principal_id;
  if (!principal) return true;
  if (row.project_id) return accessAllowsProject(ctx.access, row.project_id, ctx.channel);
  return row.principal_id === principal;
}

const isApproval = (row: { kind?: string | null }) => row.kind === 'approval';

/**
 * Who answers: the member asked (or, for a group, any member of it; an
 * approval only a person in it), the Owner, or for a plain question a team
 * manager.
 */
const canAnswer = (ctx: QuestionsContext, row: QuestionRow) =>
  // Whoever asked a group never answers for it, Owner or not: someone else in it does.
  !(!!row.asked_to_group && row.asked_by === ctx.memberId) && (row.asked_to === ctx.memberId
  || (!!row.asked_to_group && row.to_reader === true && (!isApproval(row) || ctx.access.role !== 'agent'))
  || (isApproval(row) ? ctx.access.role === 'owner' : canManage(ctx)));
const canCancel = (ctx: QuestionsContext, row: QuestionRow) => row.asked_by === ctx.memberId || canManage(ctx);

async function memberNames(db: SupabaseClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const { data, error } = await db.from('team_members').select('id, name').in('id', unique);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));
}

/**
 * Adds each row's task title and project name, whether both are out of
 * Trash, and whether the reader may open them.
 */
async function withPlaces(ctx: QuestionsContext, rows: QuestionRow[]): Promise<QuestionRow[]> {
  const db = ctx.db;
  const [reader, groups] = await Promise.all([taskReader(ctx), readerGroups(ctx)]);
  const taskIds = [...new Set(rows.map((r) => r.task_id).filter((id): id is string => !!id))];
  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((id): id is string => !!id))];
  const [tasks, projects] = await Promise.all([
    taskIds.length ? db.from('tasks').select('id, title').in('id', taskIds).is('deleted_at', null) : Promise.resolve({ data: [], error: null }),
    projectIds.length ? db.from('projects').select('id, name').in('id', projectIds).is('deleted_at', null) : Promise.resolve({ data: [], error: null }),
  ]);
  if (tasks.error) throw tasks.error;
  if (projects.error) throw projects.error;
  const taskById = new Map(((tasks.data ?? []) as { id: string; title: string }[]).map((t) => [t.id, t]));
  const projectById = new Map(((projects.data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p]));
  return rows.map((row) => {
    const task = row.task_id ? taskById.get(row.task_id) ?? null : null;
    const project = row.project_id ? projectById.get(row.project_id) ?? null : null;
    return {
      ...row,
      task: task ? { title: task.title } : null,
      project: project ? { name: project.name } : null,
      place_live: (!row.task_id || !!task) && (!row.project_id || !!project),
      can_open_place: canOpenPlace(ctx, reader, row),
      to_reader: askedToReader(ctx, groups, row),
    };
  });
}

async function present(ctx: QuestionsContext, rows: QuestionRow[]): Promise<QuestionView[]> {
  const [names, groupsById] = await Promise.all([
    memberNames(ctx.db, rows.flatMap((r) => [r.asked_by, r.asked_to, r.answered_by, r.principal_id ?? null])),
    groupNames(ctx.db, rows.map((r) => r.asked_to_group)),
  ]);
  return rows.map((row) => {
    const status = effectiveQuestionStatus(row);
    return {
      id: row.id,
      project_id: row.project_id,
      // The place is named only to someone who may open it: no dead link.
      project_name: row.can_open_place ? row.project?.name ?? null : null,
      task_id: row.task_id,
      task_title: row.can_open_place ? row.task?.title ?? null : null,
      asked_by: row.asked_by,
      asked_by_name: names.get(row.asked_by) ?? null,
      asked_to: row.asked_to,
      asked_to_name: row.asked_to ? names.get(row.asked_to) ?? null : null,
      question: row.question,
      choices: Array.isArray(row.choices) ? row.choices : null,
      allow_other: row.allow_other,
      status,
      answer_choice: row.answer_choice,
      answer_text: row.answer_text,
      answered_by: row.answered_by,
      answered_by_name: row.answered_by ? names.get(row.answered_by) ?? null : null,
      answered_at: row.answered_at,
      cancelled_by: row.cancelled_by,
      cancelled_at: row.cancelled_at,
      expires_at: row.expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      can_answer: status === 'open' && canAnswer(ctx, row),
      can_cancel: status === 'open' && canCancel(ctx, row),
      ...(isApproval(row) ? approvalFields(row, names) : {}),
      // Only a group's question and one asked for someone carry these, so a plain question reads as it always has.
      ...(row.asked_to_group ? {
        asked_to_group: row.asked_to_group,
        asked_to_group_name: groupsById.get(row.asked_to_group) ?? null,
        asked_to_you: row.to_reader === true,
      } : {}),
      ...(row.principal_id ? { principal_id: row.principal_id, principal_name: names.get(row.principal_id) ?? null } : {}),
    };
  });
}

/** What only an approval carries: its action and the decision, once there is one. */
function approvalFields(row: QuestionRow, names: Map<string, string>): Partial<QuestionView> {
  const decided = row.status === 'answered' ? row.answered_by : null;
  return {
    kind: 'approval',
    action: row.action ?? undefined,
    decision: approvalDecision(row.answer_choice),
    decided_by: decided,
    decided_by_name: decided ? names.get(decided) ?? null : null,
  };
}

/** Stores 'expired' on open questions past their time, which clears their bells. */
export async function expireDueQuestions(db: SupabaseClient) {
  const { error } = await db
    .from('questions')
    .update({ status: 'expired' })
    .eq('status', 'open')
    .lte('expires_at', new Date().toISOString());
  if (error) throw error;
}

async function loadRow(ctx: QuestionsContext, id: string): Promise<QuestionRow> {
  if (!UUID.test(id)) throw notFound('Question');
  const { data, error } = await ctx.db.from('questions').select(SELECT).eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  const row = data ? (await withPlaces(ctx, [data as QuestionRow]))[0] : null;
  // Hidden, in Trash and missing read the same, so ids cannot be probed.
  if (!row || !canSee(ctx, row)) throw notFound('Question');
  return row;
}

/** Where a new question hangs: a task (its project comes with it), a project, or nothing. */
async function resolvePlace(ctx: QuestionsContext, input: AskQuestionInput) {
  if (input.task_id) {
    const { data: task, error } = await ctx.db
      .from('tasks')
      .select('id, title, project_id, project:projects!inner(id)')
      .eq('id', input.task_id)
      .is('deleted_at', null)
      .is('project.deleted_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!task || !canOpenPlace(ctx, await taskReader(ctx), { task_id: task.id, project_id: task.project_id })) throw notFound('Task');
    if (input.project_id && input.project_id !== task.project_id) {
      throw badRequest("project_id does not match the task's project; send task_id alone");
    }
    return { task_id: task.id as string, project_id: task.project_id as string, task_title: task.title as string };
  }
  if (input.project_id) {
    if (!accessAllowsProject(ctx.access, input.project_id, ctx.channel)) throw notFound('Project');
    const { data, error } = await ctx.db.from('projects').select('id').eq('id', input.project_id).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    if (!data) throw notFound('Project');
    return { task_id: null, project_id: input.project_id, task_title: null };
  }
  return { task_id: null, project_id: null, task_title: null };
}

/** Who a question goes to: one member, or a group. */
type Addressee = { asked_to: string; asked_to_group: null } | { asked_to: null; asked_to_group: string };

/**
 * A group as the one asked: live, with at least one active member besides
 * the asker who may answer (a person, for an approval).
 */
async function resolveAskedGroup(ctx: QuestionsContext, groupId: string, kind: QuestionKind, named: boolean): Promise<Addressee> {
  const group = await liveGroup(ctx.db, groupId);
  if (!group) throw invalid(named ? 'asked_to_group must be a live group' : 'Your escalation group is gone: name asked_to or asked_to_group.', { reason: 'asked_to_group_not_found' });
  const members = (await activeGroupMembers(ctx.db, groupId, { peopleOnly: kind === 'approval' })).filter((m) => m.id !== ctx.memberId);
  if (members.length === 0) {
    throw invalid(kind === 'approval'
      ? `No one in ${group.name} can decide it: an approval goes to a person other than you.`
      : `No one in ${group.name} can answer it: the group has no other active member.`, { reason: 'group_has_no_one' });
  }
  return { asked_to: null, asked_to_group: groupId };
}

/**
 * Who is asked: the named member or group, else the agent's escalation
 * target (a member or a group), else the Owner. An approval goes to a
 * person: an agent cannot approve an action.
 */
async function resolveAddressee(ctx: QuestionsContext, input: AskQuestionInput, kind: QuestionKind = 'question'): Promise<Addressee> {
  if (input.asked_to && input.asked_to_group) {
    throw invalid('Send asked_to or asked_to_group, not both.', { reason: 'two_addressees' });
  }
  if (input.asked_to_group) return resolveAskedGroup(ctx, input.asked_to_group, kind, true);
  const askedTo = input.asked_to;
  let target: string | null = askedTo ?? null;
  if (askedTo) {
    const { data, error } = await ctx.db.from('team_members').select('id').eq('id', askedTo).eq('status', 'active').maybeSingle();
    if (error) throw error;
    if (!data) throw invalid('asked_to must be an active team member', { reason: 'asked_to_not_member' });
  } else {
    // The agent's own choice (a member or a group), its owners, or the Owner; a person gets the Owner.
    const recipient = await escalationRecipient(ctx.db, ctx.memberId);
    if (!recipient) throw invalid('There is no one to ask: name asked_to.', { reason: 'no_one_to_ask' });
    if (recipient.kind === 'group') return resolveAskedGroup(ctx, recipient.id, kind, false);
    target = recipient.id;
  }
  if (kind === 'approval') {
    const { data, error } = await ctx.db.from('team_members').select('role').eq('id', target).maybeSingle();
    if (error) throw error;
    if ((data as { role?: string } | null)?.role === 'agent') {
      throw invalid(askedTo ? 'An approval goes to a person: asked_to is an agent.' : 'Your escalation target is an agent, and an approval goes to a person: name one in asked_to.', { reason: 'approver_not_person' });
    }
  }
  if (target === ctx.memberId) {
    throw invalid(askedTo ? 'You cannot ask yourself. Name someone else in asked_to.' : 'You would be asking yourself: name someone in asked_to.', { reason: 'asked_self' });
  }
  return { asked_to: target as string, asked_to_group: null };
}

/** A database without the approval columns yet (new code before its migration). */
const missingApprovalColumns = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || /column .*(kind|action)/i.test(error.message ?? ''));

/** Logs the typed blocked event for an agent that asks, so its state reads as needing a person. */
function recordBlocked(ctx: QuestionsContext, row: QuestionRow, taskTitle: string | null) {
  if (ctx.access.role !== 'agent' || !isModuleEnabled(ctx.access, 'agents')) return;
  const payload = {
    ...(row.task_id ? { task_id: row.task_id } : {}),
    ...(taskTitle ? { task_title: taskTitle.slice(0, 200) } : {}),
    reason: row.question.length > 300 ? `${row.question.slice(0, 299)}…` : row.question,
  };
  afterResponse('blocked activity', async () => {
    const { error } = await ctx.db.from('agent_activities').insert({
      agent_id: ctx.memberId,
      project_id: row.project_id,
      activity_type: 'blocked',
      title: formatEventTitle('blocked', payload),
      description: '',
      reference_type: row.task_id ? 'task' : 'question',
      reference_id: row.task_id ?? row.id,
      metadata: { ...payload, question_id: row.id },
    });
    if (error) throw error;
  });
}

/** Asks a question. Answers with the question; asked_to's bell rings (database trigger). */
export async function askQuestion(ctx: QuestionsContext, input: AskQuestionInput): Promise<QuestionView> {
  return createQuestion(ctx, input, 'question', null);
}

/**
 * Asks a person to approve an action before the caller does it: a question
 * of kind approval, with the choices approve and reject and no free-text
 * answer (a note rides along). Its question is the action's summary unless
 * the caller adds more context. Answers with the approval; poll it until
 * decision is approved or rejected.
 */
export async function requestApproval(ctx: QuestionsContext, input: RequestApprovalInput): Promise<QuestionView> {
  const { action, question, ...rest } = input;
  return createQuestion(ctx, {
    ...rest,
    question: question ?? action.summary,
    choices: [...APPROVAL_CHOICES],
    allow_other: false,
  }, 'approval', action);
}

async function createQuestion(ctx: QuestionsContext, input: AskQuestionInput, kind: QuestionKind, action: ApprovalAction | null): Promise<QuestionView> {
  const place = await resolvePlace(ctx, input);
  const addressee = await resolveAddressee(ctx, input, kind);
  if (input.expires_at && new Date(input.expires_at).getTime() <= Date.now()) {
    throw invalid('expires_at must be in the future', { reason: 'expires_in_past' });
  }
  const choices = input.choices?.length ? input.choices : null;
  const { data, error } = await ctx.db
    .from('questions')
    .insert({
      task_id: place.task_id,
      project_id: place.project_id,
      asked_by: ctx.memberId,
      asked_to: addressee.asked_to,
      question: input.question,
      choices,
      allow_other: choices ? input.allow_other ?? true : true,
      expires_at: input.expires_at ?? null,
      // A plain question sends exactly what it always did.
      ...(kind === 'approval' ? { kind, action } : {}),
      ...(addressee.asked_to_group ? { asked_to_group: addressee.asked_to_group } : {}),
    })
    .select(SELECT)
    .single();
  if (addressee.asked_to_group && missingGroupsSchema(error)) throw groupsMigrationPending();
  if (kind === 'approval' && missingApprovalColumns(error)) {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Approvals work once the database update 20261124000600_open_agent_vocabulary.sql is applied', {
      reason: 'migration_pending',
    });
  }
  if (error) throw error;
  const [row] = await withPlaces(ctx, [data as QuestionRow]);
  recordBlocked(ctx, row, place.task_title);
  return (await present(ctx, [row]))[0];
}

/** One approval the caller can see. A plain question (or a hidden id) is 404. */
export async function getApproval(ctx: QuestionsContext, id: string): Promise<QuestionView> {
  const row = await loadRow(ctx, id).catch((error: unknown) => {
    throw error instanceof ApiError && error.statusCode === 404 ? notFound('Approval') : error;
  });
  if (!isApproval(row)) throw notFound('Approval');
  return (await present(ctx, [row]))[0];
}

export async function getQuestion(ctx: QuestionsContext, id: string): Promise<QuestionView> {
  return (await present(ctx, [await loadRow(ctx, id)]))[0];
}

export interface QuestionFilters {
  status?: QuestionStatus | 'all';
  /** 'me' or a member id. */
  askedBy?: string;
  /** A member id; the reader's own id also matches questions asked to their groups. */
  askedTo?: string;
  /** Questions asked to this group. */
  askedToGroup?: string;
  taskId?: string;
  projectId?: string;
  /** Only questions, or only approvals; both when left out. */
  kind?: QuestionKind;
  offset: number;
  limit: number;
  /** Oldest first (the app's open list); the API lists newest first. */
  oldestFirst?: boolean;
}

/** Reads the list filters off a query string, refusing what the database would choke on. */
export function questionFiltersFrom(searchParams: URLSearchParams, memberId: string): Omit<QuestionFilters, 'offset' | 'limit'> {
  const status = searchParams.get('status') ?? 'all';
  if (!['open', 'answered', 'cancelled', 'expired', 'all'].includes(status)) {
    throw badRequest('status must be open, answered, cancelled, expired or all');
  }
  const who = (name: string) => {
    const value = searchParams.get(name);
    if (!value) return undefined;
    if (value === 'me') return memberId;
    if (!UUID.test(value)) throw badRequest(`${name} must be me or a team member id`);
    return value;
  };
  const id = (name: string) => {
    const value = searchParams.get(name);
    if (value && !UUID.test(value)) throw badRequest(`${name} must be a uuid`);
    return value ?? undefined;
  };
  const kind = searchParams.get('kind');
  if (kind !== null && kind !== 'question' && kind !== 'approval') throw badRequest('kind must be question or approval');
  return {
    status: status as QuestionFilters['status'], askedBy: who('asked_by'), askedTo: who('asked_to'), taskId: id('task_id'), projectId: id('project_id'),
    ...(kind ? { kind } : {}),
    ...(id('asked_to_group') ? { askedToGroup: id('asked_to_group') } : {}),
  };
}

/**
 * The `.or()` filter for every question the member may see (Trash aside):
 * their own, ones on projects they can open, and ones on tasks they may read
 * (canSee checks each row again).
 */
async function visibleFilter(ctx: QuestionsContext, reader: TaskReader): Promise<string> {
  const groups = [...await readerGroups(ctx)];
  const parties = [`asked_by.eq.${ctx.memberId}`, `asked_to.eq.${ctx.memberId}`, ...(groups.length ? [`asked_to_group.in.(${groups.join(',')})`] : [])];
  const readAll = accessAllows(ctx.access, 'projects.read_all', ctx.channel);
  const projects = readAll ? [] : accessAllows(ctx.access, 'projects.read', ctx.channel) ? ctx.access.project_ids : [];
  const inProjects = readAll ? 'project_id.not.is.null' : projects.length ? `project_id.in.(${projects.join(',')})` : null;
  // Acting for a person, a party row counts only where partyInReach says (canSee checks each row again).
  const principal = ctx.access.principal_id;
  const own = principal
    ? parties.flatMap((party) => [
      ...(inProjects ? [`and(${party},${inProjects})`] : []),
      `and(${party},project_id.is.null,principal_id.eq.${principal})`,
    ]).join(',')
    : parties.join(',');
  if (!inProjects) return own;
  if (reader.full) return `${own},${inProjects}`;
  // A reader of assigned tasks may read hundreds of them over the years: only
  // the ones that carry a question go in the filter, so the URL stays short.
  const tasks = await tasksWithQuestions(ctx.db, [...(reader.readable ?? [])]);
  return [own, `and(task_id.is.null,${inProjects})`, ...(tasks.length ? [`task_id.in.(${tasks.join(',')})`] : [])].join(',');
}

/** Of these tasks, the ones that carry a live question (any status). */
async function tasksWithQuestions(db: SupabaseClient, taskIds: string[]): Promise<string[]> {
  const rows = await inChunks<{ task_id: string }>(taskIds, (chunk) =>
    db.from('questions').select('task_id').in('task_id', chunk).is('deleted_at', null));
  return [...new Set(rows.map((row) => row.task_id))];
}

/** Tasks in Trash that still have questions: theirs go out of reach with them. */
async function trashedQuestionTasks(db: SupabaseClient): Promise<string[]> {
  // includes-deleted: finds the questions' tasks that are in Trash
  const { data, error } = await db
    .from('questions')
    .select('task_id, task:tasks!inner(id)')
    .is('deleted_at', null)
    .not('task.deleted_at', 'is', null);
  if (error) throw error;
  return [...new Set((data ?? []).map((row: { task_id: string }) => row.task_id))];
}

export async function listQuestions(ctx: QuestionsContext, filters: QuestionFilters): Promise<{ rows: QuestionView[]; total: number }> {
  await expireDueQuestions(ctx.db);
  let query = ctx.db
    .from('questions')
    .select(SELECT, { count: 'exact' })
    .or(await visibleFilter(ctx, await taskReader(ctx)))
    .is('deleted_at', null);
  const trashedProjects = await trashedProjectIds(ctx.db);
  if (trashedProjects.length) query = query.or(`project_id.is.null,project_id.not.in.${postgrestList(trashedProjects)}`);
  const trashedTasks = await trashedQuestionTasks(ctx.db);
  if (trashedTasks.length) query = query.or(`task_id.is.null,task_id.not.in.${postgrestList(trashedTasks)}`);
  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.askedBy) query = query.eq('asked_by', filters.askedBy);
  if (filters.askedTo) {
    // "Asked to me" takes in the groups the reader is in.
    const groups = filters.askedTo === ctx.memberId ? [...await readerGroups(ctx)] : [];
    query = groups.length
      ? query.or(`asked_to.eq.${filters.askedTo},asked_to_group.in.(${groups.join(',')})`)
      : query.eq('asked_to', filters.askedTo);
  }
  if (filters.askedToGroup) query = query.eq('asked_to_group', filters.askedToGroup);
  if (filters.taskId) query = query.eq('task_id', filters.taskId);
  if (filters.projectId) query = query.eq('project_id', filters.projectId);
  if (filters.kind) query = query.eq('kind', filters.kind);
  const { data, count, error } = await query
    .order('created_at', { ascending: !!filters.oldestFirst })
    .range(filters.offset, filters.offset + filters.limit - 1);
  if (error) throw error;
  const rows = (await withPlaces(ctx, (data ?? []) as QuestionRow[])).filter((row) => canSee(ctx, row));
  return { rows: await present(ctx, rows), total: count ?? rows.length };
}

function notOpen(row: QuestionRow): ApiError | null {
  const status = effectiveQuestionStatus(row);
  if (status === 'open') return null;
  const message = {
    answered: 'This question has already been answered.',
    cancelled: 'This question was cancelled.',
    expired: 'This question expired before anyone answered it.',
  }[status];
  return new ApiError(409, 'CONFLICT', message, { reason: `question_${status}`, status });
}

/** Answers a question: asked_to, the Owner, or a team manager. Twice is 409. */
export async function answerQuestion(ctx: QuestionsContext, id: string, input: AnswerQuestionInput): Promise<QuestionView> {
  const row = await loadRow(ctx, id);
  if (row.asked_to_group && row.asked_by === ctx.memberId) {
    throw forbidden(isApproval(row) ? 'You asked for this approval: someone else in the group decides it.' : 'You asked this group: someone else in it answers.', { reason: 'asked_self' });
  }
  if (!canAnswer(ctx, row)) {
    throw isApproval(row)
      ? forbidden('Only the person asked, or the Owner, can decide this approval.', { reason: 'not_asked' })
      : forbidden('Only the person asked, the Owner, or someone who may manage the team can answer this question.', { reason: 'not_asked' });
  }
  const closed = notOpen(row);
  if (closed) throw closed;
  const choices = Array.isArray(row.choices) ? row.choices : [];
  let choice: string | null = null;
  if (input.choice !== undefined) {
    if (choices.length === 0) throw invalid('This question has no choices: answer with text.', { reason: 'no_choices' });
    choice = choices.find((c) => c === input.choice) ?? choices.find((c) => c.toLowerCase() === input.choice!.toLowerCase()) ?? null;
    if (!choice) throw invalid('choice must be one of the question\'s choices', { reason: 'unknown_choice', choices });
  } else if (!textAnswers({ choices, allow_other: row.allow_other })) {
    throw invalid(isApproval(row) ? 'Send choice approve or reject; text is an optional note.' : 'Pick one of the choices.', { reason: 'choice_required', choices });
  }
  const now = new Date().toISOString();
  const { data, error } = await ctx.db
    .from('questions')
    .update({ status: 'answered', answer_choice: choice, answer_text: input.text ?? null, answered_by: ctx.memberId, answered_at: now })
    .eq('id', id)
    .eq('status', 'open')
    .select(SELECT)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // Someone else answered or cancelled it a moment ago.
    throw notOpen(await loadRow(ctx, id)) ?? new ApiError(409, 'CONFLICT', 'This question just changed. Read it again.', { reason: 'question_changed' });
  }
  return (await present(ctx, await withPlaces(ctx, [data as QuestionRow])))[0];
}

/** Withdraws an open question: the asker, the Owner, or a team manager. */
export async function cancelQuestion(ctx: QuestionsContext, id: string): Promise<QuestionView> {
  const row = await loadRow(ctx, id);
  if (!canCancel(ctx, row)) {
    throw forbidden('Only whoever asked, the Owner, or someone who may manage the team can cancel this question.', { reason: 'not_asker' });
  }
  const closed = notOpen(row);
  if (closed) throw closed;
  const { data, error } = await ctx.db
    .from('questions')
    .update({ status: 'cancelled', cancelled_by: ctx.memberId, cancelled_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'open')
    .select(SELECT)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw notOpen(await loadRow(ctx, id)) ?? new ApiError(409, 'CONFLICT', 'This question just changed. Read it again.', { reason: 'question_changed' });
  }
  return (await present(ctx, await withPlaces(ctx, [data as QuestionRow])))[0];
}

/** A task's open question as task reads carry it: the oldest one still open. */
export interface OpenQuestion {
  id: string;
  question: string;
  choices: string[] | null;
  allow_other: boolean;
  asked_by: string;
  asked_by_name: string | null;
  /** Null when it is asked to a group. */
  asked_to: string | null;
  asked_to_name: string | null;
  expires_at: string | null;
  created_at: string;
  /** Approvals only: absent on a plain question. */
  kind?: 'approval';
  action?: ApprovalAction;
  /** A group's question only: absent otherwise. */
  asked_to_group?: string;
  asked_to_group_name?: string | null;
}

/**
 * The oldest open question on a task, or null. Anyone who can read the task
 * sees it. A database without the questions table yet reads as none. A plain
 * question has exactly the fields it always had; an approval adds kind and
 * action.
 */
export async function openQuestionForTask(db: SupabaseClient, taskId: string): Promise<OpenQuestion | null> {
  // Every column, so a database before the approval columns reads the same.
  const { data, error } = await db
    .from('questions')
    .select('*')
    .eq('task_id', taskId)
    .eq('status', 'open')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(20);
  if (missingQuestionsTable(error)) return null;
  if (error) throw error;
  const open = ((data ?? []) as QuestionRow[]).find((q) => effectiveQuestionStatus(q) === 'open');
  if (!open) return null;
  const [names, groupsById] = await Promise.all([
    memberNames(db, [open.asked_by, open.asked_to]),
    groupNames(db, [open.asked_to_group]),
  ]);
  return {
    id: open.id,
    question: open.question,
    choices: open.choices,
    allow_other: open.allow_other,
    asked_by: open.asked_by,
    asked_to: open.asked_to,
    expires_at: open.expires_at,
    created_at: open.created_at,
    asked_by_name: names.get(open.asked_by) ?? null,
    asked_to_name: open.asked_to ? names.get(open.asked_to) ?? null : null,
    ...(isApproval(open) && open.action ? { kind: 'approval' as const, action: open.action } : {}),
    ...(open.asked_to_group ? { asked_to_group: open.asked_to_group, asked_to_group_name: groupsById.get(open.asked_to_group) ?? null } : {}),
  };
}

