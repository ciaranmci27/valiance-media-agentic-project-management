import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { restoreForApi, TRASH_PERMISSIONS, TRASH_TYPES } from '@/lib/api/trash-api';

export const dynamic = 'force-dynamic';

// The id is recordId, not id: withApi reads params.id under a /projects/ path as a live project to reach,
// and a project being restored is in Trash.
const paramsSchema = z.object({ type: z.enum(TRASH_TYPES), recordId: z.uuid() });

/**
 * Brings one record back from Trash exactly as it was, for whoever could
 * have moved it there (the same rules as Settings > Trash, on the key's
 * api channel). 404 when it is not in Trash or out of the key's reach; 409
 * with what must come back first (its task or project). Answers
 * { restored: true, record_type, id }.
 */
export const POST = withApi(async ({ supabase, params, access, scopes, teamMemberId, apiKeyId }) => {
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw badRequest(`type must be one of: ${TRASH_TYPES.join(', ')}; recordId a uuid`, { reason: 'invalid_record' });
  const { type, recordId: id } = parsed.data;
  const result = await restoreForApi({ service: supabase, access, scopes, memberId: teamMemberId }, type, id);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/trash/${type}/${id}/restore`, entityType: type, entityId: id, apiKeyId, teamMemberId, afterSnapshot: result, statusCode: 200 });
  return success(result);
}, { permission: TRASH_PERMISSIONS });
