import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { trashEntry, updateEntry } from '@/lib/api/initiatives';
import { updateInitiativeEntrySchema, type UpdateInitiativeEntryInput } from '@/lib/initiatives';

type Params = { id: string; initiativeId: string; entryId: string };

/**
 * Changes a log entry. Its author changes title, body and task_id; status
 * (open, resolved) resolves or reopens an issue, for anyone who may log.
 *
 * Permission: tasks.read; never a guest.
 */
export const PATCH = withApi<UpdateInitiativeEntryInput, Params>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { before, entry } = await updateEntry(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.initiativeId, params.entryId, body);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/projects/${params.id}/initiatives/${params.initiativeId}/entries/${params.entryId}`, entityType: 'initiative_entry', entityId: params.entryId, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: entry, statusCode: 200 });
  return success(entry);
}, { schema: updateInitiativeEntrySchema, permission: 'tasks.read' });

/**
 * Moves a log entry to Trash: its author's, or whoever manages projects.
 *
 * Permission: tasks.read; never a guest.
 */
export const DELETE = withApi<unknown, Params>(async ({ supabase, params, teamMemberId, access, scopes, apiKeyId }) => {
  const entry = await trashEntry(supabase, { memberId: teamMemberId, access, scopes }, params.id, params.initiativeId, params.entryId);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/projects/${params.id}/initiatives/${params.initiativeId}/entries/${params.entryId}`, entityType: 'initiative_entry', entityId: params.entryId, apiKeyId, teamMemberId, beforeSnapshot: entry, statusCode: 200 });
  return success({ id: params.entryId, deleted: true });
}, { permission: 'tasks.read' });
