import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateProjectSchema } from '@/lib/schemas';
import { forbidden, notFound } from '@/lib/api/errors';
import { patchProject } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { apiKeyAllows, sanitizeProjectForAccess } from '@/lib/api/access';

export const GET = withApi(async ({ supabase, params, access }) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*, project_members(member_id)')
    .eq('id', (params as any).id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Project');

  const project = sanitizeProjectForAccess({
    ...data,
    member_ids: (data.project_members || []).map((pm: any) => pm.member_id),
    project_members: undefined,
  }, access, 'api');

  return success(project);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('projects').select('*').eq('id', id).maybeSingle();
  if (!before) throw notFound('Project');
  const { member_ids, ...updates } = body as any;
  if (member_ids !== undefined && !apiKeyAllows(access, scopes, 'project_members.manage')) {
    throw forbidden('Assigning project members requires the project_members.manage API scope');
  }
  if (!apiKeyAllows(access, scopes, 'billing.manage')) {
    for (const field of ['hourly_rate', 'budget_type', 'budget_value', 'billing_address', 'billing_email', 'tax_rate', 'invoice_pdf_options', 'client_time_billing']) {
      delete updates[field];
    }
  }
  if (!apiKeyAllows(access, scopes, 'agents.manage')) {
    for (const field of ['autonomous_enabled', 'auto_merge_enabled', 'integration_branch', 'production_branch', 'suggestions_per_cycle', 'suggestion_queue_cap', 'audit_interval_hours', 'repo_path']) {
      delete updates[field];
    }
  }
  const project = await patchProject(supabase, id, updates, member_ids);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/projects/${id}`, entityType: 'project', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: project, statusCode: 200 });
  return success(project);
}, { schema: updateProjectSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('projects').select('*').eq('id', id).maybeSingle();
  // Soft delete: set archived_at
  const { data, error } = await supabase
    .from('projects')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Project');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/projects/${id}`, entityType: 'project', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success({ archived: true, archived_at: data.archived_at });
});
