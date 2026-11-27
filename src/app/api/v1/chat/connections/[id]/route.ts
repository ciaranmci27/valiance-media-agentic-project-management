import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { apiConnectionView, deleteChatConnection, updateChatConnection } from '@/lib/chat/connections';
import { apiUpdateChatConnectionSchema, type ApiUpdateChatConnection } from '@/lib/chat/types';
import { appUrlFor } from '@/lib/team/invite';

export const dynamic = 'force-dynamic';

/**
 * Renames a connection (display_name) or switches it on or off (enabled),
 * as Settings > Assistants > Chat apps does. A bot token, signing secret or
 * relay secret is replaced in the app only: those fields are refused here
 * (a secret never passes through an agent). Answers the connection with its
 * health. An Owner's key only.
 *
 * Permission: team.manage, by an Owner.
 */
export const PATCH = withApi<ApiUpdateChatConnection, { id: string }>(async ({ supabase, params, body, access, teamMemberId, apiKeyId, origin }) => {
  assertOwnerCaller(access, 'manages chat connections');
  const view = await updateChatConnection(supabase, access, teamMemberId, params.id, body, appUrlFor(origin), { endpoint: `/api/v1/chat/connections/${params.id}`, apiKeyId });
  return success(apiConnectionView(view));
}, { schema: apiUpdateChatConnectionSchema, permission: 'team.manage' });

/**
 * Removes a connection with its chat history (Telegram's webhook is
 * deleted with it), its agents and channel mappings. Cannot be undone. Answers
 * { id, deleted: true }. An Owner's key only.
 *
 * Permission: team.manage, by an Owner.
 */
export const DELETE = withApi<unknown, { id: string }>(async ({ supabase, params, access, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'manages chat connections');
  return success(await deleteChatConnection(supabase, access, teamMemberId, params.id, { endpoint: `/api/v1/chat/connections/${params.id}`, apiKeyId }));
}, { permission: 'team.manage' });
