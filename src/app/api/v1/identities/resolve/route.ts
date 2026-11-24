import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { resolveIdentity, resolveQueryFrom } from '@/lib/api/identities';

/**
 * Who a chat account belongs to: provider, external_id, workspace_id (for
 * providers with workspaces). Only verified accounts resolve; anything else
 * is 404 identity_not_found. Answers { member: { id, name, role, title,
 * status, active }, identity }; a suspended member reads active false.
 *
 * Permission: identities.read.
 */
export const GET = withApi(async ({ supabase, searchParams }) =>
  success(await resolveIdentity(supabase, resolveQueryFrom(searchParams))), { permission: 'identities.read' });
