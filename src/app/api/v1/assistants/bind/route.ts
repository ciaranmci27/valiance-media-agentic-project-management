import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { bindPersonalAgent } from '@/lib/api/personal-agents';
import { bindAssistantSchema } from '@/lib/personal-agents';

export const dynamic = 'force-dynamic';

type BindBody = { agent_id: string; person_id: string | null };

/**
 * Makes an agent someone's personal agent (person_id), or a shared agent
 * again (null), as Settings > Assistants does. The person becomes its owner
 * in place of the one before. Re-binding or unbinding revokes every key the
 * agent holds, with their descendants, and every delegation token it holds:
 * a new key is needed for the new person. Answers { agent }. An Owner's key
 * only, with the AI agents module on.
 *
 * Permission: team.manage, by an Owner.
 */
export const POST = withApi<BindBody>(async ({ supabase, body, access, scopes, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'changes who an agent works for');
  return success(await bindPersonalAgent(supabase, { memberId: teamMemberId, access, scopes }, body.agent_id, body.person_id, { endpoint: '/api/v1/assistants/bind', apiKeyId }));
}, { schema: bindAssistantSchema, permission: 'team.manage' });
