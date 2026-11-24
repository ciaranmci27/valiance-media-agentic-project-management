import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { adminLinkIdentities } from '@/lib/api/identities';
import { adminLinkSchema, type AdminLinkInput } from '@/lib/identities';

/**
 * Links accounts to members in bulk (up to 500): each { member_id, provider,
 * external_id, workspace_id?, handle?, verified? }. Verified (method admin)
 * unless verified is false. One already linked to someone else refuses the
 * whole call (409 identity_linked_elsewhere). Answers { linked, created,
 * updated }.
 *
 * Permission: team.manage.
 */
export const POST = withApi<AdminLinkInput>(async ({ supabase, body, teamMemberId, access, scopes, apiKeyId }) => {
  const result = await adminLinkIdentities(supabase, { memberId: teamMemberId, access, scopes }, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/identities', entityType: 'member_identity', apiKeyId, teamMemberId, requestBody: body, afterSnapshot: { created: result.created, updated: result.updated }, statusCode: 200 });
  return success(result);
}, { schema: adminLinkSchema, permission: 'team.manage' });
