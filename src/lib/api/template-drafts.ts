import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  APPROVAL_DETAILS_MAX, APPROVAL_SUMMARY_MAX, type DecidedVia,
} from '@/lib/questions';
import {
  assignTemplateKeys, keyDatesOf, mainKeyDate, taskCount, templateIssue, templateIssues,
  type DraftTemplateRunInput, type RunTaskTemplateInput, type TaskTemplateRunResult, type TemplateDraftStatus,
  type TemplateField, type TemplateIssue, type TemplateKeyDate, type TemplateRole, type TemplateRunInitiative, type TemplateTask,
} from '@/lib/task-templates';
import { accessAllows, accessAllowsProject, resolveMemberAccess } from './access';
import { callerChannel, callerHolds, type AgentCaller } from './agent-owners';
import { currentActorVia } from './request-context';
import { ApiError, forbidden, notFound } from './errors';
import { answerQuestion, expireDueQuestions, requestApproval, type QuestionsContext } from './questions';
import {
  activeMembers, canManageTemplates, canRunTemplates, createTemplateRun, draftItems, loadTemplateRow, memberNames, prepareRun,
  presentRun, previewOfPrepared, projectNames, RUN_COLUMNS, templateErrors, type DraftSource, type TemplateRunPreview, type TemplateSnapshot,
} from './task-templates';

/**
 * Template runs proposed for a person to approve (drafts), for the API (v1,
 * MCP) and the session routes. Routes run on the service role, so the rules
 * are here:
 * - Drafting (draftTemplateRun): whoever may use the template (tasks.create
 *   on the project), checked with the same prepareRun a run uses, except that
 *   role maps and added steps are not held to the proposer's assign rights
 *   (the approver's are checked). It is the path for an agent whose create
 *   policy is approval, which gets 403 on run. The draft keeps the template as
 *   it was (snapshot) and asks for a decision through the approvals primitive
 *   (requestApproval), asked_to the template's owner when they may use it
 *   there, else a person who manages the project, else the approvals default
 *   (the agent's escalation target, else the Owner); the proposer may name
 *   asked_to or asked_to_group. idempotency_key answers the same draft again.
 * - Deciding: through the approval (answerQuestion), so whoever the approval
 *   names (or the Owner) decides, by the 2.0.41 door rules; and never an
 *   agent caller, a personal agent acting for its person included. The
 *   approver needs tasks.create on the project. Approving checks the run as
 *   the approver first, then records the approval's decision (open to
 *   answered: a question cancelled or expired meanwhile is 409 and nothing is
 *   made), then claims the draft atomically (pending to approved; a second
 *   approve is 409), then makes the run as the approver through
 *   createTemplateRun, from the draft's snapshot, every role map and added
 *   step checked against the approver's own assign rights. Tasks therefore
 *   never exist beside a cancelled or expired approval. If the run fails, the
 *   claim is released and the approval reopened, unless the run was recorded
 *   (only its read back failed): then the draft stays approved and links it.
 *   A template or project gone by then is 404 template_not_found or
 *   project_not_found, never read as the approval being hidden. The run and
 *   its initiative say who drafted it. Deciding the approval card in the app
 *   does the same, since it is the same path.
 * - Expiry: a draft expires with its approval (a database trigger on
 *   pm.questions: the watchdog, a read that stores expiry, or a withdrawal).
 * - Reading: drafts on projects the caller can open, for whoever may use or
 *   manage templates.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_COLUMNS = 'id, template_id, template_version, snapshot, project_id, proposal, note, status, proposed_by, principal_id, question_id, decided_by, decided_at, run_id, idempotency_key, created_at, updated_at';
/** The approval's action type: the decide path knows a draft by it. */
export const TEMPLATE_DRAFT_ACTION = 'template_run';
/** A draft's approval lasts this long unless the proposer says otherwise. */
const DEFAULT_EXPIRY_DAYS = 14;

const missingDraftsSchema = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (['42P01', 'PGRST205'].includes(error.code ?? '') || /task_template_run_drafts.*(does not exist|schema cache)/i.test(error.message ?? ''));

export const draftsMigrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE',
  'Template drafts work once the database update 20261126000300_template_reflow_drafts.sql is applied', { reason: 'migration_pending' });

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingDraftsSchema(error)) throw draftsMigrationPending();
  throw error;
}

const objectOf = <T = string>(value: unknown): Record<string, T> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {});

/** What a draft proposes, as stored. */
interface Proposal {
  key_dates: Record<string, string>;
  roles: Record<string, string | null>;
  values: Record<string, string>;
  create_initiative: boolean;
  initiative: RunTaskTemplateInput['initiative'] | null;
  extra_steps: TemplateTask[];
  removed_steps: string[];
}

/** A draft as the API answers it. */
export interface TemplateDraftView {
  id: string;
  template_id: string;
  template_name: string;
  /** The template's version when it was drafted. */
  template_version: number;
  /** Its version now (null when it is in Trash or out of reach). */
  current_template_version: number | null;
  /** The template changed since it was drafted: the draft still makes what it saw. */
  template_changed: boolean;
  project_id: string;
  project_name: string | null;
  status: TemplateDraftStatus;
  note: string;
  key_dates: Record<string, string>;
  /** Each key date's label, from the template the draft saw. */
  key_date_labels: Record<string, string>;
  roles: Record<string, string | null>;
  values: Record<string, string>;
  create_initiative: boolean;
  initiative: RunTaskTemplateInput['initiative'] | null;
  extra_steps: TemplateTask[];
  removed_steps: string[];
  proposed_by: string | null;
  proposed_by_name: string | null;
  principal_id: string | null;
  /** The approval that decides it (GET /api/v1/approvals/:id). */
  question_id: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A draft's preview: the run preview, each task marked when the draft adds it, and the template's steps it leaves out. */
export type TemplateDraftPreview = Omit<TemplateRunPreview, 'tasks'> & {
  tasks: (TemplateRunPreview['tasks'][number] & { change: 'added' | null })[];
  removed_tasks: { key: string; title: string; parent_key: string | null }[];
  template_changed_since: { from_version: number; to_version: number } | null;
};

export interface TemplateDraftDetail extends TemplateDraftView {
  /** What approving would make, as the reader (null once decided, or when the reader cannot use the template). */
  preview: TemplateDraftPreview | null;
}

/** What approving answers: the draft, and the run it made. */
export interface TemplateDraftApproval {
  draft: TemplateDraftView;
  run: TaskTemplateRunResult | null;
  template_changed_since: { from_version: number; to_version: number } | null;
}

// ── Who may ─────────────────────────────────────────────────────────────

const reaches = (caller: AgentCaller, projectId: string) => accessAllowsProject(caller.access, projectId, callerChannel(caller));

function requireRead(caller: AgentCaller): void {
  if (canRunTemplates(caller) || canManageTemplates(caller)) return;
  throw forbidden('Template drafts are for members who may create tasks', {
    reason: 'missing_permission', needs: 'tasks.create', hint: 'Ask an Owner to grant you Create tasks.',
  });
}

/** The caller of a questions context, as the template services take it. */
export const callerOfQuestions = (ctx: QuestionsContext): AgentCaller => ({
  memberId: ctx.memberId, access: ctx.access, scopes: ctx.channel === 'app' ? null : ctx.scopes ?? [],
});

// ── Presenting ──────────────────────────────────────────────────────────

function proposalOf(row: Row): Proposal {
  const raw = objectOf<unknown>(row.proposal);
  return {
    key_dates: objectOf(raw.key_dates),
    roles: objectOf<string | null>(raw.roles),
    values: objectOf(raw.values),
    create_initiative: raw.create_initiative === true,
    initiative: (raw.initiative as Proposal['initiative']) ?? null,
    extra_steps: Array.isArray(raw.extra_steps) ? raw.extra_steps as TemplateTask[] : [],
    removed_steps: Array.isArray(raw.removed_steps) ? raw.removed_steps as string[] : [],
  };
}

function snapshotOf(row: Row): TemplateSnapshot {
  const snap = objectOf<unknown>(row.snapshot);
  return {
    name: String(snap.name ?? ''),
    description: String(snap.description ?? ''),
    version: Number(row.template_version),
    fields: Array.isArray(snap.fields) ? snap.fields as TemplateField[] : [],
    items: assignTemplateKeys(Array.isArray(snap.items) ? snap.items as TemplateTask[] : []),
    key_dates: keyDatesOf(Array.isArray(snap.key_dates) ? snap.key_dates as TemplateKeyDate[] : null),
    roles: Array.isArray(snap.roles) ? snap.roles as TemplateRole[] : [],
    guidance: String(snap.guidance ?? ''),
  };
}

const sourceOf = (row: Row, names?: Map<string, string>): DraftSource => {
  const proposal = proposalOf(row);
  return {
    snapshot: snapshotOf(row),
    extra: proposal.extra_steps,
    removed: proposal.removed_steps,
    id: row.id,
    draftedBy: row.proposed_by ?? null,
    draftedByName: row.proposed_by ? names?.get(row.proposed_by) ?? null : null,
  };
};

const runInputOf = (row: Row): RunTaskTemplateInput => {
  const proposal = proposalOf(row);
  return {
    project_id: row.project_id,
    values: proposal.values,
    key_dates: proposal.key_dates,
    roles: proposal.roles,
    ...(proposal.create_initiative ? { create_initiative: true } : {}),
    ...(proposal.create_initiative && proposal.initiative ? { initiative: proposal.initiative } : {}),
  };
};

async function currentVersions(service: SupabaseClient, ids: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { data, error } = await service.from('task_templates').select('id, version').in('id', unique).is('deleted_at', null);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; version: number }[]).map((row) => [row.id, row.version]));
}

async function present(service: SupabaseClient, rows: Row[]): Promise<TemplateDraftView[]> {
  const [projects, names, versions] = await Promise.all([
    projectNames(service, rows.map((row) => row.project_id)),
    memberNames(service, rows.flatMap((row) => [row.proposed_by, row.decided_by])),
    currentVersions(service, rows.map((row) => row.template_id)),
  ]);
  return rows.map((row) => {
    const proposal = proposalOf(row);
    const current = versions.get(row.template_id) ?? null;
    return {
      id: row.id,
      template_id: row.template_id,
      template_name: String(row.snapshot?.name ?? ''),
      template_version: row.template_version,
      current_template_version: current,
      template_changed: current !== null && current !== row.template_version,
      project_id: row.project_id,
      project_name: projects.get(row.project_id) ?? null,
      status: row.status as TemplateDraftStatus,
      note: row.note ?? '',
      ...proposal,
      key_date_labels: Object.fromEntries(snapshotOf(row).key_dates.map((keyDate) => [keyDate.key, keyDate.label])),
      proposed_by: row.proposed_by ?? null,
      proposed_by_name: row.proposed_by ? names.get(row.proposed_by) ?? null : null,
      principal_id: row.principal_id ?? null,
      question_id: row.question_id ?? null,
      decided_by: row.decided_by ?? null,
      decided_by_name: row.decided_by ? names.get(row.decided_by) ?? null : null,
      decided_at: row.decided_at ?? null,
      run_id: row.run_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

/** The run preview marked against the template: added steps, and the template's steps left out. */
function markPreview(preview: TemplateRunPreview, row: Row, current: number | null): TemplateDraftPreview {
  const source = sourceOf(row);
  const added = new Set(source.extra.map((task) => task.key as string));
  const removed = new Set(source.removed);
  const removedTasks: TemplateDraftPreview['removed_tasks'] = [];
  for (const task of source.snapshot.items) {
    if (removed.has(task.key as string)) removedTasks.push({ key: task.key as string, title: task.title, parent_key: null });
    for (const subtask of task.subtasks ?? []) {
      if (removed.has(subtask.key as string)) removedTasks.push({ key: subtask.key as string, title: subtask.title, parent_key: task.key as string });
    }
  }
  return {
    ...preview,
    tasks: preview.tasks.map((task) => ({ ...task, change: added.has(task.key as string) ? 'added' as const : null })),
    removed_tasks: removedTasks,
    template_changed_since: current !== null && current !== row.template_version ? { from_version: row.template_version, to_version: current } : null,
  };
}

/** What approving would make, as this reader (null when the reader cannot use the template, or it is gone). */
async function draftPreview(service: SupabaseClient, caller: AgentCaller, row: Row, view: TemplateDraftView): Promise<TemplateDraftPreview | null> {
  if (row.status !== 'pending') return null;
  try {
    const names = await memberNames(service, [row.proposed_by]);
    // An agent reading its own draft sees it as proposed; a person sees it as they would approve it.
    const prepared = await prepareRun(service, caller, row.template_id, runInputOf(row), {
      draft: sourceOf(row, names), proposing: caller.access.role === 'agent',
    });
    return markPreview(await previewOfPrepared(service, prepared), row, view.current_template_version);
  } catch (error) {
    if (error instanceof ApiError && (error.statusCode === 403 || error.statusCode === 404)) return null;
    throw error;
  }
}

// ── Reading ─────────────────────────────────────────────────────────────

async function loadDraftRow(service: SupabaseClient, caller: AgentCaller, draftId: string): Promise<Row> {
  requireRead(caller);
  if (!UUID.test(draftId)) throw notFound('Draft');
  const { data, error } = await service.from('task_template_run_drafts').select(DRAFT_COLUMNS).eq('id', draftId).is('deleted_at', null).maybeSingle();
  if (error) fail(error);
  const row = data as Row | null;
  // Out of reach and missing read the same.
  if (!row || !reaches(caller, row.project_id)) throw notFound('Draft');
  return row;
}

/** One draft with its preview. Stores any approval that expired first, so its status is current. */
export async function getTemplateDraft(service: SupabaseClient, caller: AgentCaller, draftId: string): Promise<TemplateDraftDetail> {
  await expireDueQuestions(service);
  const row = await loadDraftRow(service, caller, draftId);
  const [view] = await present(service, [row]);
  return { ...view, preview: await draftPreview(service, caller, row, view) };
}

export interface TemplateDraftFilters {
  project_id?: string | null;
  template_id?: string | null;
  status?: TemplateDraftStatus | null;
  offset: number;
  limit: number;
}

const DRAFT_STATUSES: readonly string[] = ['pending', 'approved', 'rejected', 'expired'];

export function templateDraftFiltersFrom(searchParams: URLSearchParams): Omit<TemplateDraftFilters, 'offset' | 'limit'> {
  const projectId = searchParams.get('project_id');
  const templateId = searchParams.get('template_id');
  const status = searchParams.get('status');
  const fields: Record<string, string> = {};
  if (projectId && !UUID.test(projectId)) fields.project_id = 'project_id must be a uuid.';
  if (templateId && !UUID.test(templateId)) fields.template_id = 'template_id must be a uuid.';
  if (status && !DRAFT_STATUSES.includes(status)) fields.status = 'Use pending, approved, rejected or expired.';
  if (Object.keys(fields).length) throw new ApiError(422, 'VALIDATION_ERROR', Object.values(fields)[0], { reason: 'invalid_filter', fields });
  return { project_id: projectId, template_id: templateId, status: status as TemplateDraftStatus | null };
}

/** Drafts on projects the caller can open, newest first, paged (without previews). */
export async function listTemplateDrafts(service: SupabaseClient, caller: AgentCaller, filters: TemplateDraftFilters): Promise<{ rows: TemplateDraftView[]; total: number }> {
  requireRead(caller);
  await expireDueQuestions(service);
  let query = service.from('task_template_run_drafts').select(DRAFT_COLUMNS, { count: 'exact' }).is('deleted_at', null);
  if (filters.project_id) {
    if (!reaches(caller, filters.project_id)) return { rows: [], total: 0 };
    query = query.eq('project_id', filters.project_id);
  } else if (!callerHolds(caller, 'projects.read_all')) {
    const reachable = caller.access.project_ids.filter((id) => UUID.test(id) && reaches(caller, id));
    if (!reachable.length) return { rows: [], total: 0 };
    query = query.in('project_id', reachable);
  }
  if (filters.template_id) query = query.eq('template_id', filters.template_id);
  if (filters.status) query = query.eq('status', filters.status);
  const { data, count, error } = await query.order('created_at', { ascending: false }).order('id').range(filters.offset, filters.offset + filters.limit - 1);
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  return { rows: await present(service, rows), total: count ?? rows.length };
}

// ── Drafting ────────────────────────────────────────────────────────────

/**
 * Whom the approval goes to by default: the template's owner when they are
 * an active person who may create tasks in the project, else a person who
 * manages the project (projects.manage, a member of it), never the proposer.
 * Null leaves it to the approvals default (escalation target, else the Owner).
 */
async function defaultApprover(service: SupabaseClient, ownerId: string | null, projectId: string, proposerId: string): Promise<string | null> {
  const eligible = async (memberId: string, needs: 'tasks.create' | 'projects.manage') => {
    if (memberId === proposerId) return false;
    const access = await resolveMemberAccess(service, memberId);
    return !!access && access.status === 'active' && access.role !== 'agent'
      && accessAllows(access, 'tasks.create', 'app') && accessAllows(access, needs, 'app') && accessAllowsProject(access, projectId, 'app');
  };
  if (ownerId && await eligible(ownerId, 'tasks.create')) return ownerId;
  const { data, error } = await service.from('project_members').select('member_id, member:team_members!inner(name, role, status)').eq('project_id', projectId);
  if (error) throw error;
  const people = ((data ?? []) as Row[])
    .filter((row) => row.member?.role !== 'agent' && (row.member?.status ?? 'active') === 'active')
    .sort((a, b) => String(a.member?.name ?? '').localeCompare(String(b.member?.name ?? '')));
  for (const person of people) {
    if (await eligible(person.member_id, 'projects.manage')) return person.member_id as string;
  }
  return null;
}

/** The checks templateIssues makes, on the template with the draft's steps, at the draft's own paths. */
function stepIssues(snapshot: TemplateSnapshot, combined: TemplateTask[], extraFrom: number): TemplateIssue[] {
  const issues = templateIssues({ key_dates: snapshot.key_dates, roles: snapshot.roles, fields: snapshot.fields, items: combined });
  return issues.flatMap((issue) => {
    const [head, index, ...rest] = issue.segments;
    if (head !== 'items' || typeof index !== 'number') return [];
    // The template's own steps were checked when it was saved.
    if (index < extraFrom) return [];
    const segments = ['extra_steps', index - extraFrom, ...rest];
    return [templateIssue(segments, issue.code, issue.message, issue.hint, issue.cycle ? { cycle: issue.cycle } : {})];
  });
}

/**
 * Proposes a run for a person to approve: checked like a run (every error
 * at its path), the template kept as it is now, and an approval asked.
 * The same idempotency_key from the same proposer answers the same draft.
 */
export async function draftTemplateRun(service: SupabaseClient, caller: AgentCaller, templateId: string, input: DraftTemplateRunInput): Promise<{ draft: TemplateDraftDetail; replayed: boolean }> {
  requireRead(caller);
  if (input.idempotency_key) {
    const { data, error } = await service.from('task_template_run_drafts').select(DRAFT_COLUMNS)
      .eq('proposed_by', caller.memberId).eq('idempotency_key', input.idempotency_key).is('deleted_at', null).maybeSingle();
    if (error) fail(error);
    if (data) {
      if ((data as Row).template_id !== templateId) {
        throw new ApiError(409, 'CONFLICT', 'That idempotency_key already drafted a run of another template', {
          reason: 'idempotency_conflict', draft_id: (data as Row).id, hint: 'Send a new idempotency_key for a new draft.',
        });
      }
      return { draft: await getTemplateDraft(service, caller, (data as Row).id), replayed: true };
    }
  }

  const current = await loadTemplateRow(service, caller, templateId);
  const base: TemplateSnapshot = {
    name: current.name, description: current.description ?? '', version: current.version,
    fields: Array.isArray(current.fields) ? current.fields : [],
    items: assignTemplateKeys(Array.isArray(current.items) ? current.items : []),
    key_dates: keyDatesOf(Array.isArray(current.key_dates) ? current.key_dates : null),
    roles: Array.isArray(current.roles) ? current.roles : [],
    guidance: current.guidance ?? '',
  };
  const removed = [...new Set(input.removed_steps ?? [])];
  // The added steps get their keys among the template's: given keys stay, the rest take the next free ones.
  const keptCount = draftItems(base.items, { extra: [], removed }).length;
  const combined = draftItems(base.items, { extra: input.extra_steps ?? [], removed });
  const extra = combined.slice(keptCount);
  const source: DraftSource = { snapshot: base, extra, removed };
  const runInput: RunTaskTemplateInput = {
    project_id: input.project_id, start_date: input.start_date, values: input.values, key_dates: input.key_dates, roles: input.roles,
    create_initiative: input.create_initiative, initiative: input.initiative,
  };
  const prepared = await prepareRun(service, caller, templateId, runInput, { draft: source, proposing: true });
  const errors = [...prepared.errors, ...stepIssues(base, combined, keptCount)];
  if (errors.length) throw templateErrors(errors);
  const projectId = prepared.projectId as string;
  const projectName = prepared.projectName as string;

  // The approval: to whom it should go, with what the run would do.
  const askedTo = input.asked_to || input.asked_to_group ? null : await defaultApprover(service, current.created_by ?? null, projectId, caller.memberId);
  const draftId = randomUUID();
  const mainKey = mainKeyDate(base.key_dates);
  const mainDate = prepared.keyDates[mainKey.key];
  const total = taskCount(prepared.items);
  const summary = `Run "${base.name}" in ${projectName}: ${total} ${total === 1 ? 'task' : 'tasks'}${mainDate ? `, ${mainKey.label} ${mainDate}` : ''}`;
  const details: Record<string, string> = {
    template: base.name,
    project: projectName,
    tasks: String(total),
    key_dates: base.key_dates.filter((keyDate) => prepared.keyDates[keyDate.key]).map((keyDate) => `${keyDate.label} ${prepared.keyDates[keyDate.key]}`).join(', '),
    ...(extra.length ? { added: extra.map((task) => task.title).join('; ') } : {}),
    ...(removed.length ? { removed: removed.join(', ') } : {}),
    ...(prepared.initiative ? { initiative: prepared.initiative.name } : {}),
    draft_id: draftId,
  };
  for (const key of ['added', 'removed']) {
    if (details[key] && details[key].length > 400) details[key] = `${details[key].slice(0, 399)}…`;
  }
  const qctx: QuestionsContext = { db: service, access: caller.access, memberId: caller.memberId, channel: callerChannel(caller), scopes: caller.scopes ?? undefined };
  const expiresAt = input.expires_at ?? new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86_400_000).toISOString();
  const approval = await requestApproval(qctx, {
    action: {
      type: TEMPLATE_DRAFT_ACTION,
      summary: summary.length > APPROVAL_SUMMARY_MAX ? `${summary.slice(0, APPROVAL_SUMMARY_MAX - 1)}…` : summary,
      ...(JSON.stringify(details).length <= APPROVAL_DETAILS_MAX ? { details } : { details: { draft_id: draftId } }),
    },
    ...(input.note ? { question: input.note } : {}),
    project_id: projectId,
    ...(input.asked_to ? { asked_to: input.asked_to } : askedTo ? { asked_to: askedTo } : {}),
    ...(input.asked_to_group ? { asked_to_group: input.asked_to_group } : {}),
    expires_at: expiresAt,
  });

  const proposal: Proposal = {
    key_dates: prepared.keyDates,
    roles: input.roles ?? {},
    values: prepared.values,
    create_initiative: input.create_initiative === true,
    initiative: input.create_initiative === true ? input.initiative ?? null : null,
    extra_steps: extra,
    removed_steps: removed,
  };
  const { error: insertError } = await service.from('task_template_run_drafts').insert({
    id: draftId,
    template_id: templateId,
    template_version: base.version,
    snapshot: {
      name: base.name, description: base.description, fields: base.fields, items: base.items,
      key_dates: base.key_dates, roles: base.roles, guidance: base.guidance,
    },
    project_id: projectId,
    proposal,
    note: input.note ?? '',
    proposed_by: caller.memberId,
    principal_id: caller.access.principal_id ?? null,
    question_id: approval.id,
    idempotency_key: input.idempotency_key ?? null,
  });
  if (insertError) {
    // No draft, no approval left asking for it.
    await service.from('questions').update({ status: 'cancelled', cancelled_by: caller.memberId, cancelled_at: new Date().toISOString() })
      .eq('id', approval.id).eq('status', 'open');
    // The same key raced in from a retry: answer the draft it made.
    if (insertError.code === '23505' && input.idempotency_key) return draftTemplateRun(service, caller, templateId, input);
    fail(insertError);
  }
  return { draft: await getTemplateDraft(service, caller, draftId), replayed: false };
}

// ── Deciding ────────────────────────────────────────────────────────────

/** What a decision on a draft-linked approval did. */
export interface DraftOutcome {
  draft_id: string;
  status: 'approved' | 'rejected';
  run: TaskTemplateRunResult | null;
  template_changed_since: { from_version: number; to_version: number } | null;
}

const decided = (status: string) => new ApiError(409, 'CONFLICT', status === 'approved'
  ? 'This draft was already approved.'
  : `This draft is ${status}.`, { reason: 'draft_decided', status });

/** How the approval's own decision is stored, handed in by answerQuestion. */
export interface ApprovalDecisionStore {
  /** Records the decision (open to answered); throws 409 when the approval is no longer open. */
  record: () => Promise<void>;
  /** Puts a recorded decision back to open, after a decision that could not be carried out. */
  reopen: () => Promise<void>;
}

/**
 * Decides the draft an approval is about (answerQuestion calls this once it
 * knows the decider): null when the approval is about no draft, and then
 * nothing is recorded here. The approval's decision is recorded before the
 * draft is claimed and before any task is made, so a question cancelled or
 * expired meanwhile stops it with a 409 and nothing made. Approving makes the
 * run as the person deciding; a failure before the run is recorded leaves the
 * draft pending and the approval open again.
 */
export async function decideDraftForApproval(ctx: QuestionsContext, questionId: string, decision: 'approve' | 'reject', decider: { by: string; via: DecidedVia }, store: ApprovalDecisionStore): Promise<DraftOutcome | null> {
  const service = ctx.db;
  const { data, error } = await service.from('task_template_run_drafts').select(DRAFT_COLUMNS).eq('question_id', questionId).is('deleted_at', null).maybeSingle();
  if (error) {
    if (missingDraftsSchema(error)) return null;
    throw error;
  }
  const row = data as Row | null;
  if (!row) return null;
  if (ctx.access.role === 'agent' || decider.via === 'agent' || decider.via === 'act_for') {
    throw forbidden('A person decides a template draft: an agent never approves or rejects one, even for its person', {
      reason: 'draft_needs_person', hint: 'Ask the person to decide it in the app, or with their own API key.',
    });
  }
  if (row.status !== 'pending') throw decided(row.status);
  const caller = callerOfQuestions(ctx);
  const now = new Date().toISOString();
  const claim = (status: 'approved' | 'rejected') => service.from('task_template_run_drafts')
    .update({ status, decided_by: ctx.memberId, decided_at: now })
    .eq('id', row.id).eq('status', 'pending').is('deleted_at', null)
    .select('id').maybeSingle();

  // The draft could not be claimed after the decision was recorded: undo the decision, say why.
  const claimFailed = async (claimError: unknown): Promise<never> => {
    await store.reopen();
    if (claimError) throw claimError;
    throw decided((await reread(service, row.id)) ?? 'decided');
  };

  if (decision === 'reject') {
    await store.record();
    const { data: claimed, error: claimError } = await claim('rejected');
    if (claimError || !claimed) await claimFailed(claimError);
    return { draft_id: row.id, status: 'rejected', run: null, template_changed_since: null };
  }

  // Everything the run checks, as the approver, before the draft is claimed.
  const names = await memberNames(service, [row.proposed_by]);
  const source = sourceOf(row, names);
  const input = runInputOf(row);
  const prepared = await prepareRun(service, caller, row.template_id, input, { draft: source }).catch((error: unknown) => { throw goneAtApprove(error, row); });
  if (prepared.errors.length) {
    throw templateErrors(prepared.errors, prepared.errors.some((issue) => issue.code === 'cannot_assign_others') ? 403 : 422);
  }
  // The decision first: a cancelled or expired approval stops here, before anything is claimed or made.
  await store.record();
  const { data: claimed, error: claimError } = await claim('approved');
  if (claimError || !claimed) await claimFailed(claimError);
  let run: TaskTemplateRunResult;
  try {
    run = await createTemplateRun(service, caller, row.template_id, input, ctx.channel === 'app' ? 'app' : currentActorVia() === 'mcp' ? 'mcp' : 'api', { draft: source });
  } catch (runError) {
    // A run fails after it is recorded only on the read back (createTemplateRun
    // never rolls a recorded run back): then the draft made it, and stays approved.
    let recorded: TaskTemplateRunResult | null;
    try {
      recorded = await recordedRunOf(service, row);
    } catch (lookupError) {
      // Cannot tell whether it was made: keep the claim, so a retry can never make it twice.
      console.error('[template-drafts] could not check whether the draft made its run', row.id, lookupError);
      throw runError;
    }
    if (!recorded) {
      // Not made: the draft waits again, and so does its approval.
      await service.from('task_template_run_drafts').update({ status: 'pending', decided_by: null, decided_at: null })
        .eq('id', row.id).eq('status', 'approved').is('run_id', null);
      await store.reopen();
      throw goneAtApprove(runError, row);
    }
    console.error('[template-drafts] the draft made its run, but reading it back failed', row.id, runError);
    run = recorded;
  }
  const { error: linkError } = await service.from('task_template_run_drafts').update({ run_id: run.run.id }).eq('id', row.id);
  if (linkError) console.error('[template-drafts] could not link the run to its draft', row.id, linkError);
  const versions = await currentVersions(service, [row.template_id]);
  const current = versions.get(row.template_id) ?? null;
  return {
    draft_id: row.id,
    status: 'approved',
    run,
    template_changed_since: current !== null && current !== row.template_version ? { from_version: row.template_version, to_version: current } : null,
  };
}

async function reread(service: SupabaseClient, draftId: string): Promise<string | null> {
  const { data } = await service.from('task_template_run_drafts').select('status').eq('id', draftId).maybeSingle();
  return (data as { status?: string } | null)?.status ?? null;
}

/**
 * The run this draft already made (its snapshot names the draft), as a run
 * answers it, or null when there is none. Its tasks are read back when they
 * can be; a failed read lists none rather than failing the approval again.
 */
async function recordedRunOf(service: SupabaseClient, row: Row): Promise<TaskTemplateRunResult | null> {
  const { data, error } = await service.from('task_template_runs').select(RUN_COLUMNS)
    .eq('template_id', row.template_id).eq('project_id', row.project_id).filter('snapshot->draft->>id', 'eq', row.id)
    .order('created_at').limit(1).maybeSingle();
  if (error) throw error;
  const run = data as Row | null;
  if (!run) return null;
  const taskIds = Array.isArray(run.task_ids) ? run.task_ids as string[] : [];
  const [projects, names, tasks, initiative] = await Promise.all([
    projectNames(service, [run.project_id]),
    memberNames(service, [run.run_by]),
    (async () => {
      const out: Row[] = [];
      for (let start = 0; start < taskIds.length; start += 100) {
        const { data: chunk, error: taskError } = await service.from('tasks').select('*').in('id', taskIds.slice(start, start + 100)).is('deleted_at', null);
        if (taskError) return [];
        out.push(...((chunk ?? []) as Row[]));
      }
      const order = new Map(taskIds.map((taskId, i) => [taskId, i]));
      return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    })(),
    run.initiative_id
      ? service.from('initiatives').select('id, project_id, name, status, start_date, target_date, owner_member_id, owner_group_id').eq('id', run.initiative_id).is('deleted_at', null).maybeSingle()
        .then(({ data: found }) => (found as TemplateRunInitiative | null) ?? null)
      : Promise.resolve(null),
  ]);
  return { run: presentRun(run, projects, names), tasks, notes: [], initiative };
}

/**
 * What approving says when the template or project the draft runs in is
 * gone (in Trash, or out of the approver's reach): a 404 of its own, so it is
 * never read as the approval being hidden. The draft stays pending.
 */
function goneAtApprove(error: unknown, row: Row): unknown {
  if (!(error instanceof ApiError) || error.statusCode !== 404) return error;
  if (/^Project /.test(error.message)) {
    return new ApiError(404, 'NOT_FOUND', 'The project this draft runs in is in Trash or out of your reach', {
      reason: 'project_not_found', project_id: row.project_id, hint: 'Restore the project, or reject the draft.',
    });
  }
  return new ApiError(404, 'NOT_FOUND', 'The template this draft runs is in Trash or out of your reach', {
    reason: 'template_not_found', template_id: row.template_id, hint: 'Restore the template, or reject the draft.',
  });
}

/**
 * Approves or rejects a draft by deciding its approval: the same path as the
 * approval card in the app, so the approval's own rules decide who may.
 */
export async function decideTemplateDraft(ctx: QuestionsContext, draftId: string, decision: 'approve' | 'reject', note?: string): Promise<TemplateDraftApproval> {
  const caller = callerOfQuestions(ctx);
  await expireDueQuestions(ctx.db);
  const row = await loadDraftRow(ctx.db, caller, draftId);
  if (row.status !== 'pending') throw decided(row.status);
  if (!row.question_id) {
    throw new ApiError(409, 'CONFLICT', 'This draft has no approval to decide it with', { reason: 'draft_without_approval' });
  }
  let outcome: DraftOutcome | null = null;
  await answerQuestion(ctx, row.question_id, { choice: decision, ...(note ? { text: note } : {}) }, { onDraft: (result) => { outcome = result; } })
    .catch((error: unknown) => {
      // The approval reads as missing to someone it is hidden from: say what that means here.
      // Only its own 404 (no reason); the template's or project's (goneAtApprove) passes through.
      if (error instanceof ApiError && error.statusCode === 404 && !objectOf<unknown>(error.details).reason) {
        throw forbidden('Only the person the approval names, or the Owner, decides this draft.', { reason: 'not_asked', question_id: row.question_id });
      }
      throw error;
    });
  const [view] = await present(ctx.db, [await loadDraftRow(ctx.db, caller, draftId)]);
  const done = outcome as DraftOutcome | null;
  return { draft: view, run: done?.run ?? null, template_changed_since: done?.template_changed_since ?? null };
}
