import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { restoreScopedEntries } from '@/lib/api/context-scopes';
import { restoreEntriesSchema, type RestoreEntries } from '@/lib/context-scopes';

export const dynamic = 'force-dynamic';

/**
 * Brings archived entries back, each in a scope the caller may write (one
 * out of reach is skipped). Answers { restored: [ids] }.
 */
export const POST = withApi<RestoreEntries>(async ({ supabase, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { restored } = await restoreScopedEntries(supabase, { memberId: teamMemberId, access, scopes }, body.entry_ids);
  logAudit(supabase, {
    method: 'POST', endpoint: '/api/v1/context/restore', entityType: 'project_context', entityId: restored[0], apiKeyId, teamMemberId,
    requestBody: { asked: body.entry_ids.length, restored: restored.length }, statusCode: 200,
  });
  return success({ restored });
}, { schema: restoreEntriesSchema, permission: [...API_ENDPOINT_PERMISSIONS] });
