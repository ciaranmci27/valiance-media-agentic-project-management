import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { recordBudgetChange } from '@/lib/api/budget-change';
import type { BudgetType } from '@/lib/project-budget-history';
import { updateProjectSchema } from '@/lib/schemas';
import { forbidden, notFound } from '@/lib/api/errors';
import { patchProject } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { trashForApi } from '@/lib/api/trash';
import { apiKeyAllows, sanitizeProjectForAccess } from '@/lib/api/access';

export const GET = withApi(async ({ supabase, params, access }) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*, project_members(member_id)')
    .eq('id', (params as any).id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Project');

  const project = sanitizeProjectForAccess({
    ...data,
    member_ids: (data.project_members || []).map((pm: any) => pm.member_id),
    project_members: undefined,
  }, access, 'api');

  return success(project);
}, { permission: 'projects.read' });

/** Fields a project update leaves alone unless the key holds a second permission: billing and the agent's working setup. */
const BILLING_FIELDS = ['hourly_rate', 'budget_type', 'budget_value', 'billing_address', 'billing_email', 'tax_rate', 'invoice_pdf_options', 'client_time_billing'];
const AGENT_FIELDS = ['autonomous_enabled', 'auto_merge_enabled', 'integration_branch', 'production_branch', 'suggestions_per_cycle', 'suggestion_queue_cap', 'audit_interval_hours', 'sensitive_paths', 'repo_path'];

/**
 * Changes a project. Billing fields need billing.manage and the agent's
 * working setup agents.manage as well; without them those fields are left
 * alone, as before, and the answer now says so in meta.ignored_fields (each
 * with the permission it needs) instead of dropping them silently. A budget
 * change is recorded in the project's budget history (and its budget emails),
 * as the app's Edit project panel does.
 */
export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('projects').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Project');
  const { member_ids, ...updates } = body as any;
  if (member_ids !== undefined && !apiKeyAllows(access, scopes, 'project_members.manage')) {
    throw forbidden('Assigning project members requires the project_members.manage API scope');
  }
  const ignored: { field: string; needs: string }[] = [];
  const leaveAlone = (fields: string[], needs: string) => {
    for (const field of fields) {
      if (field in updates) ignored.push({ field, needs });
      delete updates[field];
    }
  };
  if (!apiKeyAllows(access, scopes, 'billing.manage')) leaveAlone(BILLING_FIELDS, 'billing.manage');
  if (!apiKeyAllows(access, scopes, 'agents.manage')) leaveAlone(AGENT_FIELDS, 'agents.manage');
  const project = await patchProject(supabase, id, updates, member_ids);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/projects/${id}`, entityType: 'project', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: project, statusCode: 200 });

  const budget = (row: Record<string, unknown>) => ({
    type: ((row.budget_type as string | null) ?? null) as BudgetType,
    value: row.budget_value === null || row.budget_value === undefined ? null : Number(row.budget_value),
  });
  if ('budget_type' in updates || 'budget_value' in updates) {
    const oldSnapshot = budget(before);
    const newSnapshot = budget({ ...before, ...updates });
    if (oldSnapshot.type !== newSnapshot.type || oldSnapshot.value !== newSnapshot.value) {
      await recordBudgetChange({ access, projectId: id, oldSnapshot, newSnapshot, changedBy: teamMemberId });
    }
  }
  if (ignored.length === 0) return success(project);
  return NextResponse.json({ success: true, data: project, meta: { ignored_fields: ignored } });
}, { schema: updateProjectSchema, permission: 'projects.manage' });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('projects').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Project');
  // Moves the project to Trash. Archiving has its own action (/archive).
  await trashForApi(supabase, 'projects', id, teamMemberId, 'Project');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/projects/${id}`, entityType: 'project', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
}, { permission: 'projects.manage' });
