import { workspaceApi, WorkspaceApiError } from '@/lib/agent-workspace';
import { invalidateTables } from '@/lib/query-cache';
import { INITIATIVE_TABLES, TEMPLATE_DRAFT_TABLES } from '@/lib/reads';
import { demoInitiatives, demoInitiativeTemplateRuns, demoTaskTemplates, demoTemplateDrafts } from '@/lib/demo-data';
import { localReflow, type ReflowResult, type TemplateDraftView } from '@/lib/template-ui';
import type { Task } from '@/lib/types';

/**
 * The template run writes the screens make, through the session routes:
 * changing a live run's key dates (reflow, with a dry run first) and
 * deciding a draft. Each marks the reads it touches stale. In demo mode the
 * demo rows change in place (nothing leaves the browser).
 */

export interface ReflowRequest {
  runId: string;
  initiativeId: string;
  /** Only the key dates that change. */
  keyDates: Record<string, string>;
  includeTaskIds: string[];
  dryRun: boolean;
}

/** The server's reason on a refused write (run_changed, draft_decided, ...), or null. */
export function reasonOf(error: unknown): string | null {
  if (!(error instanceof WorkspaceApiError)) return null;
  const details = error.details as { reason?: unknown } | null | undefined;
  return typeof details?.reason === 'string' ? details.reason : null;
}

/** Moves a live run to new key dates, or with dryRun answers what that would do. */
export async function reflowRun(request: ReflowRequest, demo: { isDemo: boolean; tasks: readonly Task[]; today: string }): Promise<ReflowResult> {
  const body = { key_dates: request.keyDates, include_task_ids: request.includeTaskIds, dry_run: request.dryRun };
  if (!demo.isDemo) {
    const result = await workspaceApi<ReflowResult>(`/api/workspace/task-templates/runs/${encodeURIComponent(request.runId)}/reflow`, { method: 'POST', body });
    if (!request.dryRun) invalidateTables([...INITIATIVE_TABLES, 'task_template_runs', 'tasks']);
    return result;
  }
  const entry = demoInitiativeTemplateRuns.find((r) => r.run.run_id === request.runId);
  const template = entry && demoTaskTemplates.find((t) => t.id === entry.run.template_id);
  if (!entry || !template) throw new Error('This run is not in the demo.');
  const initiative = demoInitiatives.find((i) => i.id === entry.initiative_id) ?? null;
  const from = Object.fromEntries(entry.run.key_dates.map((k) => [k.key, k.date]));
  const result = localReflow({
    runId: request.runId, templateId: template.id, projectId: entry.project_id,
    initiative: initiative ? { id: initiative.id, name: initiative.name, target_date: initiative.target_date } : null,
    items: template.items, keyDates: template.key_dates ?? [], from, input: body, links: entry.tasks, tasks: demo.tasks, today: demo.today,
  });
  if (request.dryRun) return result;
  // Applied: the run keeps its new dates, the moved tasks their new planned date, the initiative follows.
  for (const keyDate of entry.run.key_dates) keyDate.date = result.key_dates.to[keyDate.key] ?? keyDate.date;
  for (const moved of result.moved) {
    const link = entry.tasks.find((l) => l.task_id === moved.task_id);
    if (link) link.planned_due_date = moved.to;
  }
  if (initiative && result.initiative?.follows) initiative.target_date = result.initiative.to;
  invalidateTables([...INITIATIVE_TABLES, 'task_template_runs']);
  return { ...result, dry_run: false };
}

/** What deciding a draft answers (the session routes' { draft, run, template_changed_since }). */
export interface DraftDecision {
  draft: TemplateDraftView;
  run: { run: { id: string }; tasks: unknown[]; initiative?: { id: string; project_id: string; name: string } | null } | null;
}

/** Approves or rejects a draft by deciding its approval; an optional note goes with the decision. */
export async function decideDraft(draftId: string, decision: 'approve' | 'reject', note: string, isDemo: boolean): Promise<DraftDecision> {
  const refresh = () => invalidateTables([...TEMPLATE_DRAFT_TABLES, ...INITIATIVE_TABLES, 'task_template_runs', 'tasks', 'team_member_notifications']);
  if (isDemo) {
    const draft = demoTemplateDrafts.find((d) => d.id === draftId);
    if (!draft) throw new Error('This draft is not in the demo.');
    if (draft.status !== 'pending') throw new Error(`This draft is ${draft.status}.`);
    Object.assign(draft, { status: decision === 'approve' ? 'approved' : 'rejected', decided_by_name: 'You', decided_at: new Date().toISOString() });
    refresh();
    return { draft, run: null };
  }
  const result = await workspaceApi<DraftDecision>(`/api/workspace/task-templates/drafts/${encodeURIComponent(draftId)}/${decision}`, {
    method: 'POST', body: note.trim() ? { note: note.trim() } : {},
  });
  refresh();
  return result;
}
