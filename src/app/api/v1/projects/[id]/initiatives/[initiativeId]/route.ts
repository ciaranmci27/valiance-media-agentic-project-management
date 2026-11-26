import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { getInitiative, trashInitiative, updateInitiative } from '@/lib/api/initiatives';
import { updateInitiativeSchema, type UpdateInitiativeInput } from '@/lib/initiatives';

type Params = { id: string; initiativeId: string };

/**
 * An initiative's starting read: { initiative (with owner and progress),
 * open_issues (newest 20), recent_entries (last 10), brief (its pinned brief
 * entries), can }. Each bounded list says how many more there are; a part
 * the key may not read is null (the log needs tasks.read and is never a
 * guest's; the brief needs project_context.read).
 *
 * Permission: projects.read (and the project).
 */
export const GET = withApi<unknown, Params>(async ({ supabase, params, teamMemberId, access, scopes }) =>
  success(await getInitiative(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.initiativeId)), { permission: 'projects.read' });

/**
 * Changes an initiative: only what is sent. Naming a member owner clears a
 * group owner and the other way round. Health is cleared when it stops
 * being active. Its project never changes.
 *
 * Permission: tasks.create (and the project).
 */
export const PATCH = withApi<UpdateInitiativeInput, Params>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { before, initiative } = await updateInitiative(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.initiativeId, body);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/projects/${params.id}/initiatives/${params.initiativeId}`, entityType: 'initiative', entityId: params.initiativeId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: initiative, statusCode: 200 });
  return success(initiative);
}, { schema: updateInitiativeSchema, permission: 'tasks.create' });

/**
 * Moves an initiative to Trash. Its tasks stay where they are, keep the link
 * and read as having no initiative until it is restored (Settings > Trash).
 *
 * Permission: projects.manage, or tasks.create for the member who made it.
 */
export const DELETE = withApi<unknown, Params>(async ({ supabase, params, teamMemberId, access, scopes, apiKeyId }) => {
  const initiative = await trashInitiative(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.initiativeId);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/projects/${params.id}/initiatives/${params.initiativeId}`, entityType: 'initiative', entityId: params.initiativeId, apiKeyId, teamMemberId, beforeSnapshot: initiative, statusCode: 200 });
  return success({ id: params.initiativeId, deleted: true });
}, { permission: ['projects.manage', 'tasks.create'] });
