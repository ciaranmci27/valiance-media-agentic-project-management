import type { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled, type AccessContext, type PermissionKey } from '@/lib/access-control';
import { accessAllows, sanitizeProjectForAccess } from './access';
import { permissionAlternatives } from './middleware';
import { readTaskInFull } from './task-read';
import { BRIEF_CONTEXT_COLUMNS, readProjectContext } from './project-context';
import { ownAssignment } from './project-agents';
import { escalationRecipient, loadMemberRules } from './agent-rules';
import { groupNames } from './groups';
import { groupTargetLabel } from '@/lib/groups';
import { apiContext, listTaskFiles } from '@/lib/task-files/service';
import { pinnedForAgent, type PinnedScope } from './context-scopes';
import { delegationOf } from './agent-handoff';
import { initiativeForBrief } from './initiatives';

/**
 * Everything an agent needs to work one task, in one bounded read: the task
 * (subtasks, acceptance criteria, blockers), its project and the project's
 * active context entries (pinned first, each with its brief section), the
 * caller's own assignment on that project (settings and instructions), the
 * newest comments, files and links, the open question, the claim, the
 * latest agent run, and the caller's own rules. For an agent, also the
 * pinned entries beyond the project (the workspace's, its groups', its own
 * and, for a personal agent whose person allows it, its person's memory) as
 * scoped_context, and for a delegated subtask the run that handed it over
 * (delegated_from); each only when there is one. The task's initiative (the
 * body of work it belongs to: its header and pinned brief entries) comes as
 * initiative, beside the task's goal (task.project_goal_id); null when it
 * has none or that initiative is in Trash.
 *
 * Every part comes from the reader its own route uses (GET /tasks/{id},
 * /projects/{id}, /projects/{id}/context, /tasks/{id}/files). The task's
 * access is withApi's, exactly as for GET /tasks/{id}; a part whose own
 * permission the key lacks (the project, its context, files) is left out and
 * named in omitted, never a reason to refuse the whole brief.
 *
 * Bounded: long text is cut and flagged, only the newest comments come, and
 * context entries stop at a budget with truncated: true. If the whole brief
 * is still over BRIEF_LIMITS.total, fitBrief cuts it further (named in
 * cut_to_fit), so it stays under the MCP read cap (40,000 characters).
 */

export const BRIEF_LIMITS = {
  description: 8000,
  /** The shortest a description gets when the brief is cut to fit. */
  descriptionFloor: 500,
  criteria: 30,
  criterion: 1000,
  subtasks: 50,
  comments: 10,
  comment: 1500,
  review: 2000,
  files: 50,
  contextEntry: 2000,
  /** Characters of context content in all. */
  contextTotal: 12_000,
  contextEntries: 40,
  /** Characters of the initiative's description. */
  initiativeDescription: 2000,
  /** Characters of the caller's instructions on the project, and the least they are cut to. */
  assignmentInstructions: 4000,
  assignmentInstructionsFloor: 500,
  /** The whole brief, serialized. */
  total: 36_000,
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const cut = (text: unknown, max: number): { text: unknown; truncated: boolean } =>
  typeof text === 'string' && text.length > max
    ? { text: `${text.slice(0, max)}…`, truncated: true }
    : { text, truncated: false };

export interface BriefCaller {
  supabase: SupabaseClient;
  access: AccessContext;
  scopes: string[];
  teamMemberId: string;
}

/** Whether the key and its member both hold a permission, or one that implies it, as withApi decides. */
function keyHolds(caller: BriefCaller, permission: PermissionKey): boolean {
  return permissionAlternatives(permission).some((option) =>
    caller.scopes.includes(option) && accessAllows(caller.access, option, 'api'));
}

async function briefRules(caller: BriefCaller) {
  const member = await loadMemberRules(caller.supabase, caller.teamMemberId);
  const escalation = member.isAgent ? await escalationRecipient(caller.supabase, caller.teamMemberId) : null;
  const escalateId = escalation?.id ?? null;
  let escalateName: string | null = null;
  if (escalation?.kind === 'group') {
    escalateName = groupTargetLabel((await groupNames(caller.supabase, [escalation.id])).get(escalation.id));
  } else if (escalateId) {
    const { data } = await caller.supabase.from('team_members').select('name').eq('id', escalateId).maybeSingle();
    escalateName = (data as { name?: string } | null)?.name ?? null;
  }
  return {
    is_agent: member.isAgent,
    self_assign: member.rules.agent_self_assign,
    close_policy: member.rules.agent_close_policy,
    create_policy: member.rules.agent_create_policy,
    // Whoever ask_human goes to by default: the agent's own choice, else the Owner.
    escalate_to: escalateId ? { id: escalateId, name: escalateName, ...(escalation?.kind === 'group' ? { kind: 'group' as const } : {}) } : null,
  };
}

export async function buildTaskBrief(caller: BriefCaller, taskId: string): Promise<Row> {
  const { supabase } = caller;
  const full = await readTaskInFull(supabase, taskId, { agentsOn: isModuleEnabled(caller.access, 'agents') });
  const omitted: { part: string; reason: string; needs: PermissionKey }[] = [];

  const seeProject = keyHolds(caller, 'projects.read');
  const seeContext = keyHolds(caller, 'project_context.read');
  const seeFiles = keyHolds(caller, 'files.read');
  if (!seeProject) omitted.push({ part: 'project', reason: 'This key cannot read projects.', needs: 'projects.read' });
  if (!seeContext) omitted.push({ part: 'project_context', reason: 'This key cannot read project context.', needs: 'project_context.read' });
  if (!seeFiles) omitted.push({ part: 'files', reason: 'This key cannot read files.', needs: 'files.read' });

  const [projectRow, contextRows, files, rules] = await Promise.all([
    seeProject
      ? supabase.from('projects').select('*, project_members(member_id)').eq('id', full.project_id).is('deleted_at', null).maybeSingle()
        .then(({ data, error }) => { if (error) throw error; return data as Row | null; })
      : Promise.resolve(null),
    seeContext ? briefContextRows(supabase, full.project_id) : Promise.resolve(null),
    seeFiles ? listTaskFiles(apiContext(caller), taskId) : Promise.resolve(null),
    briefRules(caller),
  ]);
  const [assignmentRow, scoped, delegatedFrom, initiative] = await Promise.all([
    rules.is_agent ? ownAssignment(supabase, caller.teamMemberId, full.project_id) : Promise.resolve(null),
    rules.is_agent && seeContext ? pinnedForAgent(supabase, caller.teamMemberId, { withMemory: true }) : Promise.resolve([] as PinnedScope[]),
    delegationOf(supabase, taskId),
    initiativeForBrief(supabase, full.initiative_id as string | null | undefined, { withBrief: seeContext, descriptionMax: BRIEF_LIMITS.initiativeDescription }),
  ]);

  // The task, as GET /tasks/{id} reads it, without the parts the brief lifts
  // to the top (comments, claim, open question) and with long text cut.
  const {
    comments: allComments = [],
    claim,
    open_question: openQuestion,
    latest_run: latestRun,
    blocked_by: blockedBy,
    dependencies_met: dependenciesMet,
    ...task
  } = full;
  const description = cut(task.description, BRIEF_LIMITS.description);
  const criteria = (task.acceptance_criteria ?? []) as Row[];
  const subtasks = (task.subtasks ?? []) as Row[];
  const review = task.latest_review as Row | null;
  const briefTask: Row = {
    ...task,
    description: description.text,
    ...(description.truncated ? { description_truncated: true } : {}),
    acceptance_criteria: criteria.slice(0, BRIEF_LIMITS.criteria)
      .map((c) => ({ ...c, criterion: cut(c.criterion, BRIEF_LIMITS.criterion).text })),
    ...(criteria.length > BRIEF_LIMITS.criteria ? { acceptance_criteria_note: `First ${BRIEF_LIMITS.criteria} of ${criteria.length}; get_task has them all.` } : {}),
    subtasks: subtasks.slice(0, BRIEF_LIMITS.subtasks),
    ...(subtasks.length > BRIEF_LIMITS.subtasks ? { subtasks_note: `First ${BRIEF_LIMITS.subtasks} of ${subtasks.length}; search_tasks with parent_task_id lists them all.` } : {}),
    latest_review: review ? { ...review, summary: cut(review.summary, BRIEF_LIMITS.review).text } : null,
  };

  const comments = allComments as Row[];
  const recent = comments.slice(-BRIEF_LIMITS.comments)
    .map((comment) => ({ ...comment, text: cut(comment.text, BRIEF_LIMITS.comment).text }));

  let project: Row | null = null;
  if (projectRow) {
    const sanitized: Row = sanitizeProjectForAccess<Row>({
      ...projectRow,
      member_ids: ((projectRow.project_members ?? []) as Row[]).map((m) => m.member_id),
      project_members: undefined,
    }, caller.access, 'api');
    const projectDescription = cut(sanitized.description, BRIEF_LIMITS.description);
    project = {
      id: sanitized.id,
      name: sanitized.name,
      status: sanitized.status,
      description: projectDescription.text,
      ...(projectDescription.truncated ? { description_truncated: true } : {}),
      repo_path: sanitized.repo_path ?? null,
      autonomous_enabled: sanitized.autonomous_enabled ?? null,
      integration_branch: sanitized.integration_branch ?? null,
      production_branch: sanitized.production_branch ?? null,
      sensitive_paths: sanitized.sensitive_paths ?? null,
      member_ids: sanitized.member_ids,
    };
  }

  let context: Row | null = null;
  if (contextRows) {
    const entries: Row[] = [];
    let used = 0;
    let truncated = contextRows.total > contextRows.rows.length;
    for (const row of contextRows.rows) {
      if (entries.length >= BRIEF_LIMITS.contextEntries || used >= BRIEF_LIMITS.contextTotal) {
        truncated = true;
        break;
      }
      const content = cut(row.content, Math.min(BRIEF_LIMITS.contextEntry, BRIEF_LIMITS.contextTotal - used));
      used += typeof content.text === 'string' ? content.text.length : 0;
      if (content.truncated) truncated = true;
      entries.push({
        id: row.id,
        category: row.category,
        ...(row.section !== undefined ? { section: row.section, pinned: row.pinned === true } : {}),
        content: content.text,
        ...(content.truncated ? { content_truncated: true } : {}),
        file_path: row.file_path ?? null,
        updated_at: row.updated_at,
      });
    }
    context = { entries, total: contextRows.total, truncated };
  }

  let assignment: Row | null = null;
  if (assignmentRow) {
    const instructions = cut(assignmentRow.instructions ?? '', BRIEF_LIMITS.assignmentInstructions);
    assignment = {
      status: assignmentRow.status,
      template_key: assignmentRow.template_key ?? null,
      settings: assignmentRow.settings ?? {},
      instructions: instructions.text,
      ...(instructions.truncated ? { instructions_truncated: true } : {}),
    };
  }

  const fileRows = files ?? null;
  const brief: Row = {
    task: briefTask,
    project,
    project_context: context,
    initiative,
    ...(scoped.length ? { scoped_context: scoped } : {}),
    assignment,
    comments: {
      recent,
      total: comments.length,
      ...(comments.length > recent.length ? { note: `Newest ${recent.length} of ${comments.length}; list_task_comments has the rest.` } : {}),
    },
    files: fileRows ? fileRows.slice(0, BRIEF_LIMITS.files) : null,
    ...(fileRows && fileRows.length > BRIEF_LIMITS.files ? { files_note: `First ${BRIEF_LIMITS.files} of ${fileRows.length}; list_task_files has them all.` } : {}),
    blockers: { blocked_by: blockedBy ?? [], dependencies_met: dependenciesMet ?? true },
    open_question: openQuestion ?? null,
    claim: claim ?? null,
    latest_run: latestRun ?? null,
    ...(delegatedFrom ? { delegated_from: delegatedFrom } : {}),
    rules,
    omitted,
  };

  fitBrief(brief, { context, recent, project, assignment, scoped });
  if (context?.truncated && !context.note) context.note = CONTEXT_NOTE;
  return brief;
}

const CONTEXT_NOTE = 'Cut to fit; search_project_context finds the rest, and get_project_context lists every entry.';

/**
 * The project's active entries for the brief: pinned first, then by
 * category and age, at most BRIEF_LIMITS.contextEntries plus one (to know
 * there are more), with the exact total. A database before the agent
 * workspaces update has no pins: the entries as get_project_context reads them.
 */
async function briefContextRows(supabase: SupabaseClient, projectId: string): Promise<{ rows: Row[]; total: number }> {
  const { data, error, count } = await supabase
    .from('project_context')
    .select(BRIEF_CONTEXT_COLUMNS, { count: 'exact' })
    .eq('project_id', projectId)
    .eq('is_active', true)
    .order('pinned', { ascending: false })
    .order('category')
    .order('created_at')
    .limit(BRIEF_LIMITS.contextEntries + 1);
  if (!error) return { rows: (data ?? []) as unknown as Row[], total: count ?? 0 };
  const rows = await readProjectContext(supabase, projectId);
  return { rows, total: rows.length };
}

/**
 * The last guard: shrinks the brief until it serializes under
 * BRIEF_LIMITS.total, so the MCP tool (which has nothing to narrow by) never
 * answers 413. In order, each a part with its own reader to page through:
 * context entries, the oldest comments, files, subtasks, criteria, then the
 * descriptions down to BRIEF_LIMITS.descriptionFloor. Each step taken is
 * named in cut_to_fit and flagged on its part.
 */
function fitBrief(brief: Row, parts: { context: Row | null; recent: Row[]; project: Row | null; assignment: Row | null; scoped: PinnedScope[] }) {
  const size = () => JSON.stringify(brief).length;
  if (size() <= BRIEF_LIMITS.total) return;
  const cutToFit: string[] = [];
  brief.cut_to_fit = cutToFit;
  const task = brief.task as Row;
  const files = brief.files as Row[] | null;

  const shrink = (step: string, more: () => boolean, after: () => void) => {
    let cutHere = false;
    while (size() > BRIEF_LIMITS.total && more()) cutHere = true;
    if (cutHere) {
      cutToFit.push(step);
      after();
    }
  };

  const { context, recent, project, assignment, scoped } = parts;
  shrink('scoped_context', () => {
    const scope = [...scoped].reverse().find((s) => s.entries.length > 0);
    if (!scope) return false;
    scope.entries.pop();
    scope.more = (scope.more ?? 0) + 1;
    return true;
  }, () => undefined);
  shrink('project_context', () => !!context && context.entries.pop() !== undefined, () => {
    context!.truncated = true;
    context!.note = CONTEXT_NOTE;
  });
  shrink('assignment_instructions', () => {
    if (!assignment || typeof assignment.instructions !== 'string') return false;
    const text = assignment.instructions.replace(/…$/, '');
    if (text.length <= BRIEF_LIMITS.assignmentInstructionsFloor) return false;
    assignment.instructions = `${text.slice(0, Math.max(BRIEF_LIMITS.assignmentInstructionsFloor, Math.floor(text.length / 2)))}…`;
    assignment.instructions_truncated = true;
    return true;
  }, () => undefined);
  shrink('comments', () => recent.shift() !== undefined, () => {
    brief.comments.truncated = true;
    brief.comments.note = `Newest ${recent.length} of ${brief.comments.total} shown to fit; list_task_comments has the rest.`;
  });
  shrink('files', () => !!files && files.pop() !== undefined, () => {
    brief.files_note = `First ${files!.length} shown to fit; list_task_files has them all.`;
  });
  shrink('subtasks', () => (task.subtasks as Row[]).pop() !== undefined, () => {
    task.subtasks_truncated = true;
    task.subtasks_note = `First ${(task.subtasks as Row[]).length} shown to fit; search_tasks with parent_task_id lists them all.`;
  });
  shrink('acceptance_criteria', () => (task.acceptance_criteria as Row[]).pop() !== undefined, () => {
    task.acceptance_criteria_truncated = true;
    task.acceptance_criteria_note = `First ${(task.acceptance_criteria as Row[]).length} shown to fit; get_task has them all.`;
  });
  // Halve the longer description each round, down to the floor.
  const uncut = (text: string) => (text.endsWith('…') ? text.slice(0, -1) : text);
  shrink('descriptions', () => {
    const holders = [task, project].filter((holder): holder is Row =>
      !!holder && typeof holder.description === 'string' && uncut(holder.description).length > BRIEF_LIMITS.descriptionFloor);
    if (holders.length === 0) return false;
    const longest = holders.reduce((a, b) => (uncut(a.description).length >= uncut(b.description).length ? a : b));
    const text = uncut(longest.description);
    longest.description = `${text.slice(0, Math.max(BRIEF_LIMITS.descriptionFloor, Math.floor(text.length / 2)))}…`;
    longest.description_truncated = true;
    return true;
  }, () => undefined);
}
