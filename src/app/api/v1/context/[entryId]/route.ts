import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { removeScopedEntry, updateScopedEntry } from '@/lib/api/context-scopes';
import { patchScopedEntrySchema, type PatchScopedEntry } from '@/lib/context-scopes';

export const dynamic = 'force-dynamic';

/** Changes an entry in any scope the caller may write: content, section, pinned. 404 for one it cannot read. */
export const PATCH = withApi<PatchScopedEntry, { entryId: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { entry } = await updateScopedEntry(supabase, { memberId: teamMemberId, access, scopes }, params.entryId, body);
  logAudit(supabase, {
    method: 'PATCH', endpoint: `/api/v1/context/${params.entryId}`, entityType: 'project_context', entityId: entry.id, apiKeyId, teamMemberId,
    requestBody: { section: body.section, pinned: body.pinned, content_changed: body.content !== undefined }, statusCode: 200,
  });
  return success(entry);
}, { schema: patchScopedEntrySchema, permission: [...API_ENDPOINT_PERMISSIONS] });

/** Removes an entry: archived, or deleted from a person's memory (it is theirs). */
export const DELETE = withApi<unknown, { entryId: string }>(async ({ supabase, params, teamMemberId, access, scopes, apiKeyId }) => {
  const { before, deleted } = await removeScopedEntry(supabase, { memberId: teamMemberId, access, scopes }, params.entryId);
  logAudit(supabase, {
    method: 'DELETE', endpoint: `/api/v1/context/${params.entryId}`, entityType: 'project_context', entityId: before.id, apiKeyId, teamMemberId,
    requestBody: { scope_type: before.scope_type, deleted }, statusCode: 200,
  });
  return success({ id: before.id, deleted, archived: !deleted });
}, { permission: [...API_ENDPOINT_PERMISSIONS] });
