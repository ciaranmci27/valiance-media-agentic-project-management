import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { createLinkRequest } from '@/lib/api/identities';
import { linkRequestSchema, type LinkRequestInput } from '@/lib/identities';
import { appUrlFor } from '@/lib/team/invite';

/**
 * A one-time link for a person to prove a chat account is theirs: send them
 * url; they open it signed in and confirm, and the account is stored as
 * verified for them. Body: provider, external_id, workspace_id?, handle?,
 * member_id? (only that member may confirm). The link lasts 15 minutes and
 * works once; the token in it is shown only here.
 *
 * Permission: identities.link.
 */
export const POST = withApi<LinkRequestInput>(async ({ supabase, body, teamMemberId, apiKeyId, origin }) => {
  const link = await createLinkRequest(supabase, { memberId: teamMemberId, keyId: apiKeyId }, body, appUrlFor(origin));
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/identities/link-requests', entityType: 'identity_link_request', entityId: link.id, apiKeyId, teamMemberId, requestBody: body, statusCode: 201 });
  const response = created(link);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}, { schema: linkRequestSchema, permission: 'identities.link', returnsSecret: true });
