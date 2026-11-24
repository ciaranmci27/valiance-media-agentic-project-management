import type { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled, type AccessContext, type PermissionKey } from '@/lib/access-control';
import { accessAllows, sanitizeProjectForAccess } from './access';
import { permissionAlternatives } from './middleware';
import { readTaskInFull } from './task-read';
import { readProjectContext } from './project-context';
import { escalationTarget, loadMemberRules } from './agent-rules';
import { apiContext, listTaskFiles } from '@/lib/task-files/service';

/**
 * Everything an agent needs to work one task, in one bounded read: the task
 * (subtasks, acceptance criteria, blockers), its project and the project's
 * active context entries, the newest comments, files and links, the open
 * question, the claim, the latest agent run, and the caller's own rules.
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
  const escalateId = member.isAgent ? await escalationTarget(caller.supabase, caller.teamMemberId) : null;
  let escalateName: string | null = null;
  if (escalateId) {
    const { data } = await caller.supabase.from('team_members').select('name').eq('id', escalateId).maybeSingle();
    escalateName = (data as { name?: string } | null)?.name ?? null;
  }
  return {
    is_agent: member.isAgent,
    self_assign: member.rules.agent_self_assign,
    close_policy: member.rules.agent_close_policy,
    create_policy: member.rules.agent_create_policy,
    // Whoever ask_human goes to by default: the agent's own choice, else the Owner.
    escalate_to: escalateId ? { id: escalateId, name: escalateName } : null,
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
    seeContext ? readProjectContext(supabase, full.project_id) : Promise.resolve(null),
    seeFiles ? listTaskFiles(apiContext(caller), taskId) : Promise.resolve(null),
    briefRules(caller),
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
    let truncated = false;
    for (const row of contextRows) {
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
        content: content.text,
        ...(content.truncated ? { content_truncated: true } : {}),
        file_path: row.file_path ?? null,
        updated_at: row.updated_at,
      });
    }
    context = { entries, total: contextRows.length, truncated };
  }

  const fileRows = files ?? null;
  const brief: Row = {
    task: briefTask,
    project,
    project_context: context,
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
    rules,
    omitted,
  };

  fitBrief(brief, { context, recent, project });
  if (context?.truncated && !context.note) context.note = 'Cut to fit; get_project_context has every entry.';
  return brief;
}

/**
 * The last guard: shrinks the brief until it serializes under
 * BRIEF_LIMITS.total, so the MCP tool (which has nothing to narrow by) never
 * answers 413. In order, each a part with its own reader to page through:
 * context entries, the oldest comments, files, subtasks, criteria, then the
 * descriptions down to BRIEF_LIMITS.descriptionFloor. Each step taken is
 * named in cut_to_fit and flagged on its part.
 */
function fitBrief(brief: Row, parts: { context: Row | null; recent: Row[]; project: Row | null }) {
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

  const { context, recent, project } = parts;
  shrink('project_context', () => !!context && context.entries.pop() !== undefined, () => {
    context!.truncated = true;
    context!.note = 'Cut to fit; get_project_context has every entry.';
  });
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
