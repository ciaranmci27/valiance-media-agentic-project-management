import type { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled, type AccessContext } from '@/lib/access-control';
import { formatEventTitle } from '@/lib/agent-events';
import {
  APPROVAL_CHOICES, APPROVALS_DECIDE, DECIDED_VIA, approvalDecision as approvalChoiceDecision, effectiveQuestionStatus, textAnswers,
  type AnswerQuestionInput, type ApprovalAction, type AskQuestionInput, type DecidedVia, type QuestionKind, type QuestionStatus,
  type QuestionView, type RequestApprovalInput,
} from '@/lib/questions';
import { isRunFinished } from '@/lib/agent-runs';
import { accessAllows, accessAllowsProject } from './access';
import { afterResponse } from './after-response';
import { currentConnection } from './request-context';
import { escalationRecipient } from './agent-rules';
import { activeGroupMembers, groupNames, groupsMigrationPending, liveGroup, missingGroupsSchema } from './groups';
import { ApiError, badRequest, forbidden, notFound } from './errors';
import {
  askedMayPerform, assertActionShownInChat, cannotPerform, isPerformableType, mayPerform, performAction, proposedActions, validatePerforms, type Performs,
} from './question-actions';
import { postgrestList, trashedProjectIds } from '@/lib/supabase/trash';
import { readPage } from './pagination';

/**
 * Questions for the API (v1, MCP) and the app's session routes: one member
 * asks another and gets the answer back. Routes run on the service role, so
 * the visibility the database gives a signed-in member is enforced here:
 * a member sees the questions they asked, the ones they were asked, and the
 * ones on a task or project they can open (never one whose task or project
 * is in Trash). The asked member, the Owner, or someone who may manage the
 * team answers; the asker or those managers cancel. An approval (kind
 * 'approval') is decided only by whoever it names, or the Owner: managing
 * the team is not a say over a deploy or a spend. The door matters too
 * (approvalDecision below): an agent named decides with its own key; one
 * that names a person (or the Owner's override) is decided signed in to the
 * app, with the person's own key carrying approvals.decide, or by an agent
 * acting for them with approvals.decide on its key and held by both; never
 * by a connected AI tool. decided_via records the door.
 *
 * A question can be asked to a group instead (asked_to_group): every member
 * of it is a party (they see it, and their bells ring), and any member may
 * answer it (answered_by says who). An approval asked to a group is decided
 * by any person in it, never an agent in it.
 *
 * Expiry: an open question past expires_at reads as expired, and every list
 * or change stores that first (which clears its bell). The watchdog
 * (pm.run_watchdog) stores it within five minutes anyway; the stored change
 * sends question.expired and tells whoever asked, once.
 */

export interface QuestionsContext {
  db: SupabaseClient;
  access: AccessContext;
  memberId: string;
  channel: 'api' | 'app';
  /** The API key's scopes (api channel); the app channel has none. */
  scopes?: string[];
  /**
   * A Connect AI connection made the request. Left out, the API channel reads
   * it from the request (withApi and the MCP server set it in process).
   */
  connection?: boolean;
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
  /** The asker's run it holds; missing on a database before 20261125001300. */
  run_id?: string | null;
  /** Why it expired before its time; missing on a database before 20261127001400. */
  expired_reason?: string | null;
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
  /** How an approval was decided; missing on a database before 20261125000700 (none recorded). */
  decided_via?: string | null;
  /** The whitelisted action the answer performs, and what it did (20261127002000). */
  performs?: Performs | null;
  performed?: QuestionView['performed'];
  /** Whom the agent asked, when it went to its orchestrator first (20261127002000). */
  requested_to?: string | null;
  requested_to_group?: string | null;
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

/** The ask-first approval's action type, made only by the app (agent-access.ts). */
const AGENT_USE_ACTION = 'agent.use';

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

/**
 * Whether the caller reads tasks and projects through this request. In the
 * app, by the member's permissions. Over the API, the key must carry
 * tasks.read or tasks.manage_all (and its member hold it): a key that came
 * in on questions.ask alone asks, reads and withdraws only questions that
 * name no task or project, its own, whatever its member could open.
 */
export function readsPlaces(ctx: Pick<QuestionsContext, 'access' | 'channel' | 'scopes'>): boolean {
  if (ctx.channel === 'app') return true;
  return (['tasks.read', 'tasks.manage_all'] as const).some((permission) =>
    (ctx.scopes ?? []).includes(permission) && accessAllows(ctx.access, permission, 'api'));
}

/**
 * Whether the request may answer a plain question: the app, or a key that
 * reads questions (tasks.read, tasks.manage_all or questions.ask, held by its
 * member). A key on approvals.decide alone decides approvals only.
 */
function readsQuestions(ctx: Pick<QuestionsContext, 'access' | 'channel' | 'scopes'>): boolean {
  return readsPlaces(ctx)
    || ((ctx.scopes ?? []).includes('questions.ask') && accessAllows(ctx.access, 'questions.ask', 'api'));
}

async function loadTaskReader(ctx: QuestionsContext): Promise<TaskReader> {
  if (!readsPlaces(ctx)) return { full: false, readable: new Set() };
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
  if ((place.task_id || place.project_id) && !readsPlaces(ctx)) return false;
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
  // A guest sees only what is addressed to them (or a group they are in) and
  // what they asked: never the team's own questions and approvals on the
  // tasks they can open.
  if (isGuestReader(ctx)) return party && partyInReach(ctx, row);
  return (party && partyInReach(ctx, row))
    || ((!!row.task_id || !!row.project_id) && row.can_open_place === true);
}

/** A guest (a client let into some projects) reads questions as a party only. Mirrors questions_select (20261127001500). */
export function isGuestReader(ctx: Pick<QuestionsContext, 'access'>): boolean {
  return ctx.access.role === 'guest';
}

/**
 * Acting for a person (X-Act-For), being a party to a question (asking it,
 * being asked, a group of the agent's) is no reach of the person's: it
 * counts only on a project the person and the agent both reach, or, on a
 * question on nothing, one the agent asked for this same person. Without a
 * principal every party counts, as before.
 */
function partyInReach(ctx: QuestionsContext, row: Pick<QuestionRow, 'project_id' | 'principal_id'>): boolean {
  // A key on questions.ask alone reaches only questions on nothing.
  if (row.project_id && !readsPlaces(ctx)) return false;
  const principal = ctx.access.principal_id;
  if (!principal) return true;
  if (row.project_id) return accessAllowsProject(ctx.access, row.project_id, ctx.channel);
  return row.principal_id === principal;
}

const isApproval = (row: { kind?: string | null }) => row.kind === 'approval';

/**
 * The person an agent acts for (X-Act-For, or a personal agent's person), as
 * a possible approver: their role and the groups they are in. Null without a
 * principal. Read once per request.
 */
interface Principal {
  id: string;
  role: string | null;
  groups: Set<string>;
}

const principals = new WeakMap<QuestionsContext, Promise<Principal | null>>();

function actingFor(ctx: QuestionsContext): Promise<Principal | null> {
  const id = ctx.access.principal_id;
  if (!id || ctx.channel !== 'api') return Promise.resolve(null);
  let principal = principals.get(ctx);
  if (!principal) {
    principal = Promise.all([
      ctx.db.from('team_members').select('role').eq('id', id).maybeSingle(),
      ctx.db.from('group_members').select('group_id').eq('member_id', id),
    ]).then(([member, groups]) => {
      if (member.error) throw member.error;
      if (groups.error && !missingGroupsSchema(groups.error)) throw groups.error;
      return {
        id,
        role: (member.data as { role?: string } | null)?.role ?? null,
        groups: new Set(((groups.error ? [] : groups.data ?? []) as { group_id: string }[]).map((row) => row.group_id)),
      };
    });
    principals.set(ctx, principal);
  }
  return principal;
}

/** The request came from a connected AI tool (Connect AI). */
const viaConnection = (ctx: QuestionsContext) => ctx.channel === 'api' && (ctx.connection ?? currentConnection());

/** The key carries approvals.decide and its member holds it (an agent acting for someone: the agent and the person both). */
const keyMayDecide = (ctx: QuestionsContext) =>
  (ctx.scopes ?? []).includes(APPROVALS_DECIDE) && accessAllows(ctx.access, APPROVALS_DECIDE, 'api');

/** How an approval gets decided: who it is recorded as (answered_by), and through which door. */
interface ApprovalDecider {
  by: string;
  via: DecidedVia;
}

const needsPerson = (message: string, hint: string) =>
  forbidden(message, { reason: 'approval_needs_person', needs: APPROVALS_DECIDE, hint });

const notNamed = () => forbidden('Only the person asked, or the Owner, can decide this approval.', { reason: 'not_asked' });

/**
 * Whoever the approval names decides it, or the Owner:
 * - named to an agent (asked_to is the calling agent): that agent's own key
 *   decides it (decided_via agent);
 * - named to a person, or to a group (a person in it, never whoever asked),
 *   or the Owner's override: signed in to the app (app); over the API only
 *   with approvals.decide on the key and held by its member (a person's own
 *   key: api_key; an agent acting for the person, X-Act-For or a personal
 *   agent: act_for, which needs it held by the agent and the person both and
 *   is recorded as the person's decision); a connected AI tool never,
 *   whatever its scopes. An agent never decides a request it made.
 * Answers the decider, or the 403 to throw: not_asked when the caller (or
 * the person it acts for) is not whom it names, approval_needs_person when
 * they are but this door may not decide for a person.
 */
function approvalDecision(ctx: QuestionsContext, row: QuestionRow, principal: Principal | null): ApprovalDecider | ApiError {
  if (ctx.channel === 'api' && ctx.access.role === 'agent') {
    // Never its own request (asking yourself is refused when asked; this holds for any row).
    if (row.asked_to === ctx.memberId && row.asked_by !== ctx.memberId) return { by: ctx.memberId, via: 'agent' };
    if (!principal || row.asked_by === ctx.memberId) return notNamed();
    const named = !(!!row.asked_to_group && row.asked_by === principal.id) && (row.asked_to === principal.id
      || (!!row.asked_to_group && principal.role !== 'agent' && principal.groups.has(row.asked_to_group))
      || principal.role === 'owner');
    if (!named) return notNamed();
    if (!keyMayDecide(ctx)) {
      return needsPerson(
        `An agent decides an approval for a person only with ${APPROVALS_DECIDE} on its key, held by the person and the agent.`,
        `Ask the person to decide it in the app, or add ${APPROVALS_DECIDE} to this key and have an Owner grant it to both.`,
      );
    }
    return { by: principal.id, via: 'act_for' };
  }
  // A person: named, a person in the group named, or the Owner. Whoever asked a group never decides for it.
  const named = !(!!row.asked_to_group && row.asked_by === ctx.memberId) && (row.asked_to === ctx.memberId
    || (!!row.asked_to_group && row.to_reader === true) || ctx.access.role === 'owner');
  if (!named) return notNamed();
  if (ctx.channel === 'app') return { by: ctx.memberId, via: 'app' };
  if (viaConnection(ctx)) {
    return needsPerson(
      'A connected AI tool cannot decide an approval for a person.',
      `Decide it in the app, or with your own API key that carries ${APPROVALS_DECIDE}.`,
    );
  }
  if (!keyMayDecide(ctx)) {
    return needsPerson(
      `Deciding an approval for a person over the API needs ${APPROVALS_DECIDE} on the key.`,
      `Decide it in the app, or add ${APPROVALS_DECIDE} to your own key on purpose.`,
    );
  }
  return { by: ctx.memberId, via: 'api_key' };
}

/**
 * Who answers: the member asked (or, for a group, any member of it), the
 * Owner, or for a plain question a team manager. An approval is decided by
 * whom it names, through a door that may (approvalDecision).
 */
const canAnswer = (ctx: QuestionsContext, row: QuestionRow, principal: Principal | null) =>
  isApproval(row)
    ? !(approvalDecision(ctx, row, principal) instanceof ApiError)
    // Whoever asked a group never answers for it, Owner or not: someone else in it does.
    : !(!!row.asked_to_group && row.asked_by === ctx.memberId) && (row.asked_to === ctx.memberId
      || (!!row.asked_to_group && row.to_reader === true) || canManage(ctx));
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
  const [names, groupsById, principal, proposals] = await Promise.all([
    memberNames(ctx.db, rows.flatMap((r) => [r.asked_by, r.asked_to, r.answered_by, r.principal_id ?? null])),
    groupNames(ctx.db, rows.map((r) => r.asked_to_group)),
    rows.some((r) => isApproval(r) && effectiveQuestionStatus(r) === 'open') ? actingFor(ctx) : Promise.resolve(null),
    Promise.all(rows.map((r) => (r.performs ? proposedActions(ctx.db, r as unknown as Record<string, unknown>, ctx) : Promise.resolve([])))),
  ]);
  return rows.map((row, index) => {
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
      can_answer: status === 'open' && canAnswer(ctx, row, principal),
      can_cancel: status === 'open' && canCancel(ctx, row),
      ...(isApproval(row) ? approvalFields(row, names) : {}),
      // Only a group's question and one asked for someone carry these, so a plain question reads as it always has.
      ...(row.asked_to_group ? {
        asked_to_group: row.asked_to_group,
        asked_to_group_name: groupsById.get(row.asked_to_group) ?? null,
        asked_to_you: row.to_reader === true,
      } : {}),
      ...(row.principal_id ? { principal_id: row.principal_id, principal_name: names.get(row.principal_id) ?? null } : {}),
      ...(row.run_id ? { run_id: row.run_id } : {}),
      ...(row.expired_reason === 'asked_member_suspended' ? { expired_reason: 'asked_member_suspended' as const } : {}),
      // Only a question that carries an action, or went to an orchestrator first, says so.
      ...(row.performs ? { proposed_actions: proposals[index], performed: row.performed ?? null } : {}),
      ...(row.requested_to || row.requested_to_group ? { requested_to: row.requested_to ?? null, requested_to_group: row.requested_to_group ?? null } : {}),
    };
  });
}

/** What only an approval carries: its action and the decision, once there is one. */
function approvalFields(row: QuestionRow, names: Map<string, string>): Partial<QuestionView> {
  const decided = row.status === 'answered' ? row.answered_by : null;
  return {
    kind: 'approval',
    action: row.action ?? undefined,
    decision: approvalChoiceDecision(row.answer_choice),
    decided_by: decided,
    decided_by_name: decided ? names.get(decided) ?? null : null,
    decided_via: decided && (DECIDED_VIA as readonly string[]).includes(row.decided_via ?? '') ? row.decided_via as DecidedVia : null,
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
  if ((input.task_id || input.project_id) && !readsPlaces(ctx)) {
    throw forbidden('Naming a task or project needs tasks.read on this key', {
      reason: 'place_needs_tasks_read',
      grant_on: 'api_key',
      hint: 'questions.ask covers questions and approvals that name no task or project. Leave task_id and project_id out, or use a key that carries tasks.read.',
    });
  }
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
 * person, or to an agent named in asked_to (a reviewer agent asked on
 * purpose); a default that lands on an agent is refused, so an agent is
 * never an approver by accident. Nobody asks themselves.
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
  if (kind === 'approval' && !askedTo) {
    const { data, error } = await ctx.db.from('team_members').select('role').eq('id', target).maybeSingle();
    if (error) throw error;
    if ((data as { role?: string } | null)?.role === 'agent') {
      throw invalid('Your escalation target is an agent, and an approval goes to a person unless you name an agent in asked_to: name one.', { reason: 'approver_not_person' });
    }
  }
  if (target === ctx.memberId) {
    throw invalid(askedTo ? 'You cannot ask yourself. Name someone else in asked_to.' : 'You would be asking yourself: name someone in asked_to.', { reason: 'asked_self' });
  }
  return { asked_to: target as string, asked_to_group: null };
}

/** A database without questions.decided_via yet (new code before 20261125000700_approval_decisions.sql). */
const missingDecidedVia = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204') && /decided_via/.test(error.message ?? '');

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
  // agent.use is the app's own ask-first approval (agent-access.ts): nobody asks for one by hand.
  if (action.type === AGENT_USE_ACTION) {
    throw invalid(`action.type ${AGENT_USE_ACTION} is the app's own: give the agent the work instead, and the app asks its managers when it asks first.`, { reason: 'reserved_action_type' });
  }
  return createQuestion(ctx, {
    ...rest,
    question: question ?? action.summary,
    choices: [...APPROVAL_CHOICES],
    allow_other: false,
  }, 'approval', action);
}

/**
 * The run a question names: one of the asker's own runs, still unfinished.
 * Another member's run and a missing one read the same (422 run_not_yours);
 * a finished run is 409 run_finished.
 */
async function resolveQuestionRun(ctx: QuestionsContext, runId: string | undefined): Promise<string | null> {
  if (!runId) return null;
  const { data, error } = await ctx.db.from('agent_runs').select('id, agent_id, status').eq('id', runId).maybeSingle();
  if (error && error.code !== '42P01' && error.code !== 'PGRST205') throw error;
  if (!data || data.agent_id !== ctx.memberId) {
    throw invalid('run_id must be one of your own runs', {
      reason: 'run_not_yours',
      hint: 'Name the run you are working in (start_run gives its id), or leave run_id out.',
    });
  }
  if (isRunFinished(data.status)) {
    throw new ApiError(409, 'CONFLICT', `That run already finished (${data.status}).`, {
      reason: 'run_finished',
      status: data.status,
      hint: 'Ask without run_id, or start a new run first.',
    });
  }
  return data.id as string;
}

/**
 * Specialists ask their orchestrator first: a question (never an approval,
 * never one that carries an action) an agent with an orchestrator sends to
 * a person or a group goes to its orchestrator instead, unless the agent's
 * "ask a person directly" (ask_people_directly) is on. The orchestrator
 * answers it, or brings it to whom the agent asked (requested_to). Null:
 * it goes where it was addressed.
 */
async function orchestratorFirst(ctx: QuestionsContext, addressee: Addressee): Promise<{ to: Addressee; requested_to: string | null; requested_to_group: string | null } | null> {
  if (ctx.access.role !== 'agent') return null;
  const { data: me, error } = await ctx.db.from('team_members').select('orchestrator_id, ask_people_directly').eq('id', ctx.memberId).maybeSingle();
  // A database before the hierarchy or this update: nothing routes.
  if (error && (error.code === '42703' || error.code === 'PGRST204' || /orchestrator_id|ask_people_directly/.test(error.message ?? ''))) return null;
  if (error) throw error;
  const orchestratorId = (me as { orchestrator_id?: string | null } | null)?.orchestrator_id ?? null;
  if (!orchestratorId || (me as { ask_people_directly?: boolean }).ask_people_directly === true) return null;
  if (addressee.asked_to === orchestratorId) return null;
  if (addressee.asked_to) {
    const { data: target, error: targetError } = await ctx.db.from('team_members').select('role').eq('id', addressee.asked_to).maybeSingle();
    if (targetError) throw targetError;
    // Agents ask each other directly (a reviewer, a peer).
    if ((target as { role?: string } | null)?.role === 'agent') return null;
  }
  const { data: orchestrator, error: orchestratorError } = await ctx.db.from('team_members').select('id, role, status').eq('id', orchestratorId).maybeSingle();
  if (orchestratorError) throw orchestratorError;
  const o = orchestrator as { role?: string; status?: string } | null;
  // An orchestrator that is gone or suspended asks nobody: the question goes where it was addressed.
  if (!o || o.role !== 'agent' || (o.status ?? 'active') !== 'active') return null;
  return { to: { asked_to: orchestratorId, asked_to_group: null }, requested_to: addressee.asked_to, requested_to_group: addressee.asked_to_group };
}

/** The whitelisted action a new question or approval carries, checked; null for none. */
async function performsOf(ctx: QuestionsContext, input: AskQuestionInput, kind: QuestionKind, action: ApprovalAction | null): Promise<Performs | null> {
  if (kind === 'approval') {
    if (!action || !isPerformableType(action.type)) return null;
    return validatePerforms(ctx.db, { type: action.type, details: action.details, summary: action.summary }, 'approve');
  }
  if (!input.action) return null;
  const choices = input.choices ?? [];
  if (choices.length === 0) throw invalid('A question that performs an action needs choices: one of them does it (action.on_choice).', { reason: 'action_needs_choices' });
  const onChoice = input.action.on_choice ?? choices[0];
  const choice = choices.find((c) => c.toLowerCase() === onChoice.toLowerCase());
  if (!choice) throw invalid('action.on_choice must be one of the choices', { reason: 'unknown_choice', choices });
  return validatePerforms(ctx.db, input.action, choice);
}

async function createQuestion(ctx: QuestionsContext, input: AskQuestionInput, kind: QuestionKind, action: ApprovalAction | null): Promise<QuestionView> {
  const place = await resolvePlace(ctx, input);
  let addressee = await resolveAddressee(ctx, input, kind);
  const runId = await resolveQuestionRun(ctx, input.run_id);
  if (input.expires_at && new Date(input.expires_at).getTime() <= Date.now()) {
    throw invalid('expires_at must be in the future', { reason: 'expires_in_past' });
  }
  const performs = await performsOf(ctx, input, kind, action);
  const routed = kind === 'question' && !performs ? await orchestratorFirst(ctx, addressee) : null;
  if (routed) addressee = routed.to;
  if (performs) {
    const verdict = await askedMayPerform(ctx.db, performs, addressee, ctx.memberId);
    if (!verdict.allowed) {
      throw invalid(`Whoever you ask cannot do what the answer would (${verdict.reason ?? 'not allowed'}). Ask someone who can.`, {
        reason: 'asked_cannot_perform', why: verdict.reason ?? null, action_type: performs.type,
        hint: 'Ask a person who holds projects.manage on that project (an Owner, or its manager), or leave action out.',
      });
    }
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
      // Only a question that holds a run sends it, so the previous database takes the rest as before.
      ...(runId ? { run_id: runId } : {}),
      ...(performs ? { performs } : {}),
      ...(routed ? { requested_to: routed.requested_to, requested_to_group: routed.requested_to_group } : {}),
    })
    .select(SELECT)
    .single();
  if ((performs || routed) && error && (error.code === '42703' || error.code === 'PGRST204')) {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Questions that perform an action or go to an orchestrator first work once the database update 20261127002000_agent_runtime.sql is applied', {
      reason: 'migration_pending',
    });
  }
  if (addressee.asked_to_group && missingGroupsSchema(error)) throw groupsMigrationPending();
  if (runId && error && (error.code === '42703' || error.code === 'PGRST204') && /run_id/.test(error.message ?? '')) {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Questions that hold a run work once the database update 20261125001300_watchdog_retention.sql is applied', {
      reason: 'migration_pending',
    });
  }
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
  // A key on questions.ask alone reads its own questions on nothing (canSee checks each row again).
  if (!readsPlaces(ctx)) return parties.map((party) => `and(${party},project_id.is.null,task_id.is.null)`).join(',');
  // A guest: only the questions they are a party to, wherever they hang (canSee checks each row again).
  if (isGuestReader(ctx)) return parties.join(',');
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
  const { data, count, error } = await readPage(query
    .order('created_at', { ascending: !!filters.oldestFirst })
    .order('id'), filters);
  if (error) throw error;
  const rows = (await withPlaces(ctx, (data ?? []) as QuestionRow[])).filter((row) => canSee(ctx, row));
  return { rows: await present(ctx, rows), total: count ?? rows.length };
}

/**
 * The 409 for a question no longer open, naming who handled it when someone
 * did ("Already answered by Mia."): details.handled_by and handled_by_name,
 * so a screen can take the item away and say why.
 */
async function notOpen(ctx: QuestionsContext, row: QuestionRow): Promise<ApiError | null> {
  const status = effectiveQuestionStatus(row);
  if (status === 'open') return null;
  const by = status === 'answered' ? row.answered_by : status === 'cancelled' ? row.cancelled_by : null;
  let name: string | null = null;
  if (by) {
    const { data } = await ctx.db.from('team_members').select('name').eq('id', by).maybeSingle();
    name = (data as { name?: string | null } | null)?.name?.trim() || null;
  }
  const verb = status === 'answered'
    ? (isApproval(row) ? (row.answer_choice === 'reject' ? 'rejected' : 'approved') : 'answered')
    : 'cancelled';
  const message = name && status !== 'expired'
    ? `Already ${verb} by ${name}.`
    : {
      answered: 'This question has already been answered.',
      cancelled: 'This question was cancelled.',
      expired: row.expired_reason === 'asked_member_suspended'
        ? 'This question closed: the member it was asked to was suspended. Ask someone else.'
        : 'This question expired before anyone answered it.',
    }[status];
  return new ApiError(409, 'CONFLICT', message, {
    reason: `question_${status}`, status, handled_by: by, handled_by_name: name,
    ...(status === 'expired' && row.expired_reason ? { expired_reason: row.expired_reason } : {}),
  });
}

/** What else a decision did: a template draft the approval was about (template-drafts.ts). */
export interface AnswerHooks {
  onDraft?: (outcome: import('./template-drafts').DraftOutcome) => void;
}

/**
 * Answers a question: asked_to, the Owner, or a team manager. An approval:
 * whom it names, or the Owner, through a door that may decide it
 * (approvalDecision), recorded in decided_via. Twice is 409. An approval
 * about a template draft (action type template_run) decides the draft first,
 * as the decider (a person only): approving makes its run; if that fails the
 * approval stays open.
 */
export async function answerQuestion(ctx: QuestionsContext, id: string, input: AnswerQuestionInput, hooks: AnswerHooks = {}): Promise<QuestionView> {
  const row = await loadRow(ctx, id);
  if (row.asked_to_group && row.asked_by === ctx.memberId) {
    throw forbidden(isApproval(row) ? 'You asked for this approval: someone else in the group decides it.' : 'You asked this group: someone else in it answers.', { reason: 'asked_self' });
  }
  let decider: ApprovalDecider | null = null;
  if (isApproval(row)) {
    const decision = approvalDecision(ctx, row, await actingFor(ctx));
    if (decision instanceof ApiError) throw decision;
    decider = decision;
  } else if (!readsQuestions(ctx)) {
    throw forbidden(`${APPROVALS_DECIDE} decides approvals only: answering a question needs questions.ask or tasks.read on this key.`, {
      reason: 'missing_key_scope', needs: ['questions.ask', 'tasks.read'],
    });
  } else if (!canAnswer(ctx, row, null)) {
    throw forbidden('Only the person asked, the Owner, or someone who may manage the team can answer this question.', { reason: 'not_asked' });
  }
  const closed = await notOpen(ctx, row);
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
  // An answer that does the thing: whoever answers must be able to do it, before anything is recorded.
  const performs = row.performs && isPerformableType(row.performs.type) && choice === row.performs.on_choice ? row.performs : null;
  if (performs) {
    const verdict = mayPerform(performs, ctx.access, ctx.channel, ctx.scopes);
    if (!verdict.allowed) throw cannotPerform(performs, verdict.reason);
    // Answering for a person in chat: they must have been shown what it does first.
    if (ctx.access.role === 'agent' && ctx.access.principal_id) {
      await assertActionShownInChat(ctx.db, { row: row as unknown as Record<string, unknown>, performs, agentId: ctx.memberId, personId: ctx.access.principal_id });
    }
  }
  const now = new Date().toISOString();
  const answered = { status: 'answered', answer_choice: choice, answer_text: input.text ?? null, answered_by: decider?.by ?? ctx.memberId, answered_at: now };
  const write = (fields: Record<string, unknown>) => ctx.db
    .from('questions')
    .update(fields)
    .eq('id', id)
    .eq('status', 'open')
    .select(SELECT)
    .maybeSingle();
  let stored: QuestionRow | null = null;
  // The one write that decides it: open to answered, so a second decision, or
  // one racing a cancel or an expiry, finds nothing open and is 409.
  const record = async () => {
    // A plain question writes exactly what it always did; an approval adds how it was decided.
    let { data, error } = await write(decider ? { ...answered, decided_via: decider.via } : answered);
    // A database before 20261125000700 has no decided_via yet: the decision stands, unrecorded.
    if (decider && missingDecidedVia(error)) ({ data, error } = await write(answered));
    if (error) throw error;
    if (!data) {
      // Someone else answered or cancelled it a moment ago.
      throw await notOpen(ctx, await loadRow(ctx, id)) ?? new ApiError(409, 'CONFLICT', 'This question just changed. Read it again.', { reason: 'question_changed' });
    }
    stored = data as QuestionRow;
  };
  // Undoes this call's own decision. Answered is final for everyone else
  // (nothing but this undo moves it back), so the row is still the one this call stored.
  const reopen = async () => {
    const cleared = { status: 'open', answer_choice: null, answer_text: null, answered_by: null, answered_at: null };
    const undo = (fields: Record<string, unknown>) => ctx.db.from('questions').update(fields).eq('id', id).eq('status', 'answered').eq('answered_by', answered.answered_by);
    let { error } = await undo(decider ? { ...cleared, decided_via: null } : cleared);
    if (decider && missingDecidedVia(error)) ({ error } = await undo(cleared));
    if (error) console.error('[questions] could not reopen an approval after its decision failed', id, error);
    stored = null;
  };
  if (decider && row.action?.type === 'template_run' && (choice === 'approve' || choice === 'reject')) {
    // Loaded on demand: the drafts module builds on this one. It records the
    // decision itself, after checking the run and before claiming the draft,
    // so tasks never exist beside a cancelled or expired approval.
    const { decideDraftForApproval } = await import('./template-drafts');
    const outcome = await decideDraftForApproval(ctx, row.id, choice, decider, { record, reopen });
    if (outcome) hooks.onDraft?.(outcome);
  }
  if (!stored) await record();
  if (performs) {
    // Done as the answerer; if it fails, the answer is undone and the question stays open.
    let result: Record<string, unknown>;
    try {
      result = await performAction(ctx.db, performs);
    } catch (error) {
      await reopen();
      throw error;
    }
    const performed = { type: performs.type, status: 'done' as const, by: answered.answered_by, at: new Date().toISOString(), result };
    const { data: after, error: performedError } = await ctx.db.from('questions').update({ performed }).eq('id', id).select(SELECT).single();
    if (performedError) throw performedError;
    stored = after as QuestionRow;
  }
  return (await present(ctx, await withPlaces(ctx, [stored as unknown as QuestionRow])))[0];
}

/** Withdraws an open question: the asker, the Owner, or a team manager. */
export async function cancelQuestion(ctx: QuestionsContext, id: string): Promise<QuestionView> {
  const row = await loadRow(ctx, id);
  if (!canCancel(ctx, row)) {
    throw forbidden('Only whoever asked, the Owner, or someone who may manage the team can cancel this question.', { reason: 'not_asker' });
  }
  const closed = await notOpen(ctx, row);
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
    throw await notOpen(ctx, await loadRow(ctx, id)) ?? new ApiError(409, 'CONFLICT', 'This question just changed. Read it again.', { reason: 'question_changed' });
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
export async function openQuestionForTask(db: SupabaseClient, taskId: string, onlyFor?: { memberId: string } | null): Promise<OpenQuestion | null> {
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
  // A guest reader (onlyFor) sees only a question asked by them, of them or of a group they are in.
  let groups: Set<string> | null = null;
  if (onlyFor) {
    const { data: memberships, error: groupsError } = await db.from('group_members').select('group_id').eq('member_id', onlyFor.memberId);
    if (groupsError && !missingGroupsSchema(groupsError)) throw groupsError;
    groups = new Set(((memberships ?? []) as { group_id: string }[]).map((row) => row.group_id));
  }
  const addressed = (q: QuestionRow) => !onlyFor || q.asked_by === onlyFor.memberId || q.asked_to === onlyFor.memberId
    || (!!q.asked_to_group && !!groups?.has(q.asked_to_group));
  const open = ((data ?? []) as QuestionRow[]).find((q) => effectiveQuestionStatus(q) === 'open' && addressed(q));
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

